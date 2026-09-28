from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import EXTRACTION_VERSION
from ..db import get_db
from ..jobs import enqueue
from ..models import AuditEvent, Document, ExtractionRun, Job, Opening, Page, Project, ProjectMember, User
from ..pipeline.confidence import Thresholds
from ..services import audit
from ..services.openings import refresh_status, thresholds_for
from ..storage import get_storage
from .deps import current_user, project_access

router = APIRouter(prefix="/api/projects", tags=["projects"])

INFO_KEYS = ("project_name", "drawing_set_name", "project_address", "prepared_by", "date", "notes")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    info: dict[str, str | None] | None = None
    settings: dict[str, Any] | None = None


def project_stats(db: Session, project: Project) -> dict[str, Any]:
    pages = db.scalar(select(func.count()).select_from(Page).where(Page.project_id == project.id)) or 0
    ops = list(db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.deleted_at.is_(None))).all())
    job = db.scalar(select(Job).where(Job.project_id == project.id).order_by(Job.created_at.desc()).limit(1))
    return {
        "pages": pages,
        "opening_types": len(ops),
        "openings": sum(o.quantity or 0 for o in ops),
        "needs_review": sum(1 for o in ops if o.status == "needs_review"),
        "verified": sum(1 for o in ops if o.verified),
        "documents": db.scalar(select(func.count()).select_from(Document).where(Document.project_id == project.id)) or 0,
        "job": job_out(job) if job else None,
    }


def job_out(j: Job) -> dict[str, Any]:
    return {
        "id": str(j.id),
        "status": j.status,
        "progress": round(j.progress or 0.0, 3),
        "step": j.step,
        "steps": j.steps,
        "message": j.message,
        "error": j.error,
        "created_at": j.created_at.isoformat(),
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        "run_id": str(j.run_id) if j.run_id else None,
    }


def project_out(db: Session, p: Project, role: str | None = None, stats: bool = True) -> dict[str, Any]:
    out = {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "info": p.info or {},
        "settings": {**{"thresholds": {"high": 0.85, "medium": 0.6}, "display_unit": "mm", "default_unit": "mm"}, **(p.settings or {})},
        "is_demo": p.is_demo,
        "role": role,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        "last_processed_at": p.last_processed_at.isoformat() if p.last_processed_at else None,
        "current_run_id": str(p.current_run_id) if p.current_run_id else None,
    }
    if stats:
        out["stats"] = project_stats(db, p)
    return out


@router.get("")
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Project, ProjectMember.role).join(ProjectMember, ProjectMember.project_id == Project.id).where(ProjectMember.user_id == user.id).order_by(Project.updated_at.desc())
    ).all()
    return [project_out(db, p, role) for p, role in rows]


@router.post("", status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    prefs = user.preferences or {}
    p = Project(
        name=body.name.strip(),
        description=body.description,
        created_by=user.id,
        info={"project_name": body.name.strip()},
        settings={"thresholds": prefs.get("thresholds", {"high": 0.85, "medium": 0.6}), "display_unit": prefs.get("display_unit", "mm"), "default_unit": "mm"},
    )
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    audit.record(db, p.id, "user", "create_project", f"Project created by {user.name or user.email}", user_id=user.id)
    db.commit()
    return project_out(db, p, "owner")


@router.post("/demo", status_code=201)
def create_demo(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Create the sample project: a generated 10-page residential drawing set, processed by the real pipeline."""
    from ..demo.sets import demo_set
    from ..services.uploads import validate

    pdf, _truth = demo_set()
    meta = validate("Residential_Plans.pdf", pdf)
    p = Project(
        name="Residential Building (Demo)",
        description="Sample project - a generated 10-page residential drawing set with plans, elevations and schedules.",
        created_by=user.id,
        is_demo=True,
        info={
            "project_name": "Residential Building",
            "drawing_set_name": "Residential_Plans.pdf - Construction Issue Rev B",
            "project_address": "14 Harbour Street, Northbridge",
            "prepared_by": user.name or user.email,
            "date": "",
            "notes": "",
        },
        settings={"thresholds": {"high": 0.85, "medium": 0.6}, "display_unit": "mm", "default_unit": "mm"},
    )
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    doc = Document(
        project_id=p.id,
        original_filename=meta["filename"],
        content_type=meta["content_type"],
        size_bytes=meta["size"],
        sha256=meta["sha256"],
        storage_key=f"projects/{p.id}/documents/{uuid.uuid4()}.pdf",
        page_count=meta["page_count"],
        uploaded_by=user.id,
    )
    get_storage().put(doc.storage_key, pdf, meta["content_type"])
    db.add(doc)
    audit.record(db, p.id, "user", "create_project", "Demo project created", user_id=user.id)
    job = enqueue(db, p.id, payload={"trigger": "demo"}, user_id=user.id)
    db.commit()
    return {**project_out(db, p, "owner"), "job": job_out(job)}


@router.get("/{project_id}")
def get_project(project: Project = Depends(project_access("viewer")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = db.get(ProjectMember, (project.id, user.id))
    return project_out(db, project, m.role if m else None)


@router.patch("/{project_id}")
def update_project(body: ProjectPatch, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(422, "Name cannot be empty")
        project.name = body.name.strip()
    if body.description is not None:
        project.description = body.description
    if body.info is not None:
        info = dict(project.info or {})
        for k, v in body.info.items():
            if k not in INFO_KEYS:
                raise HTTPException(422, f"unknown project info field '{k}'")
            if v is not None and len(v) > (5000 if k == "notes" else 300):
                raise HTTPException(422, f"{k} is too long")
            info[k] = v
        project.info = info
    thresholds_changed = False
    if body.settings is not None:
        st = dict(project.settings or {})
        for k, v in body.settings.items():
            if k == "thresholds":
                t = Thresholds.from_dict(v)
                if (t.high, t.medium) != (float(v.get("high", t.high)), float(v.get("medium", t.medium))):
                    raise HTTPException(422, "Thresholds must satisfy 0 < medium < high <= 1")
                st["thresholds"] = {"high": t.high, "medium": t.medium}
                thresholds_changed = True
            elif k in ("display_unit",):
                if v not in ("original", "mm", "cm", "m", "ft_in"):
                    raise HTTPException(422, "unknown display unit")
                st[k] = v
            elif k == "default_unit":
                if v not in ("mm", "cm", "m", "in"):
                    raise HTTPException(422, "unknown default unit")
                st[k] = v
            else:
                raise HTTPException(422, f"unknown setting '{k}'")
        project.settings = st
    if thresholds_changed:
        thr = thresholds_for(project)
        for o in db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.deleted_at.is_(None))).all():
            refresh_status(o, thr)
    audit.record(db, project.id, "user", "update_project", "Project details updated", user_id=user.id)
    db.commit()
    return project_out(db, project, db.get(ProjectMember, (project.id, user.id)).role)


@router.delete("/{project_id}", status_code=204)
def delete_project(project: Project = Depends(project_access("owner")), db: Session = Depends(get_db)):
    pid = project.id
    db.delete(project)
    db.commit()
    get_storage().delete_prefix(f"projects/{pid}/")


# -- members ---------------------------------------------------------------------


class MemberIn(BaseModel):
    email: str
    role: str = "viewer"


@router.get("/{project_id}/members")
def list_members(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    rows = db.execute(select(User, ProjectMember.role).join(ProjectMember, ProjectMember.user_id == User.id).where(ProjectMember.project_id == project.id)).all()
    return [{"user_id": str(u.id), "email": u.email, "name": u.name, "role": r} for u, r in rows]


@router.post("/{project_id}/members", status_code=201)
def add_member(body: MemberIn, project: Project = Depends(project_access("owner")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.role not in ("viewer", "editor", "owner"):
        raise HTTPException(422, "role must be viewer, editor or owner")
    other = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if other is None:
        raise HTTPException(404, "No user with that email - they need to create an account first")
    m = db.get(ProjectMember, (project.id, other.id))
    if m:
        m.role = body.role
    else:
        db.add(ProjectMember(project_id=project.id, user_id=other.id, role=body.role))
    audit.record(db, project.id, "user", "share", f"{other.email} given {body.role} access", user_id=user.id)
    db.commit()
    return {"user_id": str(other.id), "email": other.email, "role": body.role}


@router.delete("/{project_id}/members/{user_id}", status_code=204)
def remove_member(user_id: uuid.UUID, project: Project = Depends(project_access("owner")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = db.get(ProjectMember, (project.id, user_id))
    if m is None:
        raise HTTPException(404, "Member not found")
    owners = db.scalar(select(func.count()).select_from(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.role == "owner"))
    if m.role == "owner" and owners <= 1:
        raise HTTPException(409, "A project needs at least one owner")
    db.delete(m)
    audit.record(db, project.id, "user", "unshare", "Member removed", user_id=user.id)
    db.commit()


# -- runs, jobs, audit -----------------------------------------------------------


@router.get("/{project_id}/runs")
def list_runs(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    runs = db.scalars(select(ExtractionRun).where(ExtractionRun.project_id == project.id).order_by(ExtractionRun.started_at.desc())).all()
    return [
        {
            "id": str(r.id),
            "version": r.version,
            "models": r.models,
            "status": r.status,
            "trigger": r.trigger,
            "stats": r.stats,
            "warnings": r.warnings,
            "started_at": r.started_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "current": r.id == project.current_run_id,
        }
        for r in runs
    ]


@router.get("/{project_id}/jobs")
def list_jobs(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    jobs = db.scalars(select(Job).where(Job.project_id == project.id).order_by(Job.created_at.desc()).limit(20)).all()
    return [job_out(j) for j in jobs]


@router.post("/{project_id}/process", status_code=202)
def reprocess(project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Re-run extraction (e.g. after a pipeline upgrade or a scale/page-type correction).
    Edited or verified openings are never overwritten without confirmation."""
    if not db.scalar(select(func.count()).select_from(Document).where(Document.project_id == project.id)):
        raise HTTPException(409, "Upload drawings first")
    running = db.scalar(select(Job).where(Job.project_id == project.id, Job.status == "running"))
    job = enqueue(db, project.id, payload={"trigger": "reprocess"}, user_id=user.id)
    audit.record(db, project.id, "user", "reprocess", f"Re-extraction requested (pipeline v{EXTRACTION_VERSION})", user_id=user.id)
    db.commit()
    return {"job": job_out(job), "queued_behind_running_job": running is not None}


@router.get("/{project_id}/audit")
def project_audit(project: Project = Depends(project_access("viewer")), limit: int = 200, db: Session = Depends(get_db)):
    limit = max(1, min(limit, 1000))
    rows = db.execute(
        select(AuditEvent, User.email, User.name).outerjoin(User, User.id == AuditEvent.user_id).where(AuditEvent.project_id == project.id).order_by(AuditEvent.id.desc()).limit(limit)
    ).all()
    return [audit_out(e, email, name) for e, email, name in rows]


def audit_out(e: AuditEvent, email: str | None, name: str | None) -> dict[str, Any]:
    return {
        "id": e.id,
        "opening_id": str(e.opening_id) if e.opening_id else None,
        "opening_ref": e.opening_ref,
        "actor": e.actor,
        "user": (name or email) if (name or email) else None,
        "action": e.action,
        "field": e.field,
        "old_value": e.old_value,
        "new_value": e.new_value,
        "message": e.message,
        "created_at": e.created_at.isoformat(),
    }
