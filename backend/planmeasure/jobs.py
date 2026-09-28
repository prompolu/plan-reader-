"""PostgreSQL-backed job queue (SELECT ... FOR UPDATE SKIP LOCKED) and worker loop.

Run workers with ``python -m planmeasure.worker``. Several workers can run in
parallel; each job is claimed by exactly one of them. Jobs whose heartbeat
stops (crashed worker) are re-queued.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_sessionmaker
from .models import Job
from .pipeline.runner import STEPS

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(minutes=10)


def initial_steps() -> dict[str, Any]:
    return {sid: {"label": label, "status": "pending", "detail": None} for sid, label in STEPS}


def enqueue(db: Session, project_id: uuid.UUID, kind: str = "process_project", payload: dict | None = None, user_id=None) -> Job:
    """Queue a job - or reuse a queued (not yet started) one for the same project."""
    existing = db.scalar(select(Job).where(Job.project_id == project_id, Job.kind == kind, Job.status == "queued"))
    if existing is not None:
        existing.payload = {**(existing.payload or {}), **(payload or {})}
        db.flush()
        return existing
    steps = initial_steps()
    steps["uploaded"]["status"] = "done"
    job = Job(project_id=project_id, kind=kind, payload=payload or {}, steps=steps, step="uploaded", created_by=user_id, message="Queued")
    db.add(job)
    db.flush()
    return job


def claim(db: Session, worker_id: str) -> Job | None:
    # re-queue jobs abandoned by crashed workers
    db.execute(
        update(Job)
        .where(Job.status == "running", Job.heartbeat_at < datetime.now(timezone.utc) - STALE_AFTER)
        .values(status="queued", locked_by=None, message="Re-queued after worker timeout")
    )
    row = db.execute(
        text("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")
    ).first()
    if row is None:
        db.commit()
        return None
    job = db.get(Job, row[0])
    assert job is not None
    now = datetime.now(timezone.utc)
    job.status = "running"
    job.locked_by = worker_id
    job.attempts += 1
    job.started_at = now
    job.heartbeat_at = now
    db.commit()
    return job


class ProgressReporter:
    """Writes step/progress updates to the job row (throttled, own transactions)."""

    RANGES = {
        "rendered": (0.02, 0.25),
        "analyzed": (0.25, 0.85),
        "classified": (0.85, 0.86),
        "dimensions": (0.86, 0.87),
        "openings": (0.87, 0.88),
        "associated": (0.88, 0.89),
        "schedules": (0.89, 0.92),
        "crossref": (0.92, 0.95),
        "scored": (0.95, 0.98),
    }

    def __init__(self, job_id: uuid.UUID):
        self.job_id = job_id
        self.last = 0.0
        self.current: str | None = None
        self.order = [s for s, _ in STEPS]

    def __call__(self, step: str, frac: float, message: str) -> None:
        now = time.monotonic()
        changed = step != self.current
        if not changed and now - self.last < 0.4 and frac < 1.0:
            return
        self.last = now
        self.current = step
        lo, hi = self.RANGES.get(step, (0.0, 1.0))
        overall = lo + (hi - lo) * max(0.0, min(1.0, frac))
        with get_sessionmaker()() as db:
            job = db.get(Job, self.job_id)
            if job is None:
                return
            steps = dict(job.steps or initial_steps())
            idx = self.order.index(step) if step in self.order else -1
            for i, sid in enumerate(self.order):
                if sid not in steps:
                    continue
                entry = dict(steps[sid])
                if i < idx:
                    entry["status"] = "done"
                elif i == idx:
                    entry["status"] = "done" if frac >= 1.0 else "running"
                    entry["detail"] = message
                steps[sid] = entry
            job.steps = steps
            job.step = step
            job.progress = max(job.progress or 0.0, overall)
            job.message = message
            job.heartbeat_at = datetime.now(timezone.utc)
            db.commit()


def run_job(job_id: uuid.UUID) -> None:
    from .services.processing import process_project

    progress = ProgressReporter(job_id)
    SessionLocal = get_sessionmaker()
    try:
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            assert job is not None
            if job.kind == "process_project":
                process_project(db, job, progress)
            else:
                raise ValueError(f"unknown job kind {job.kind}")
            job = db.get(Job, job_id)
            job.status = "succeeded"
            job.progress = 1.0
            job.finished_at = datetime.now(timezone.utc)
            steps = dict(job.steps or {})
            for sid in steps:
                steps[sid] = {**steps[sid], "status": "done"}
            job.steps = steps
            job.message = "Complete"
            db.commit()
    except Exception as exc:
        log.exception("job %s failed", job_id)
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job is None:
                return
            retry = job.attempts < get_settings().job_max_attempts and not isinstance(exc, (ValueError,))
            job.status = "queued" if retry else "failed"
            job.error = f"{type(exc).__name__}: {exc}"
            job.message = "Retrying" if retry else "Processing failed"
            if not retry:
                job.finished_at = datetime.now(timezone.utc)
                log.error("job %s failed permanently:\n%s", job_id, traceback.format_exc())
                from .services.processing import mark_failed

                mark_failed(db, job, str(exc))
            db.commit()


def worker_loop(stop: threading.Event | None = None, once: bool = False) -> int:
    """Process jobs until ``stop`` is set. Returns the number of jobs run."""
    s = get_settings()
    worker_id = f"{socket.gethostname()}:{os.getpid()}:{threading.get_ident()}"
    n = 0
    while stop is None or not stop.is_set():
        try:
            with get_sessionmaker()() as db:
                job = claim(db, worker_id)
        except SQLAlchemyError as exc:  # database not reachable / not migrated yet
            log.warning("could not claim a job (%s); retrying", exc.__class__.__name__)
            if once:
                return n
            time.sleep(max(2.0, s.worker_poll_seconds))
            continue
        if job is None:
            if once:
                return n
            time.sleep(s.worker_poll_seconds)
            continue
        log.info("running job %s (%s) for project %s", job.id, job.kind, job.project_id)
        run_job(job.id)
        n += 1
    return n


def start_background_worker() -> threading.Event:
    """Run a worker thread inside the API process (single-process deployments / dev)."""
    stop = threading.Event()
    t = threading.Thread(target=worker_loop, args=(stop,), name="planmeasure-worker", daemon=True)
    t.start()
    return stop
