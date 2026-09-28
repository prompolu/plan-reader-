"""The processing job: render pages, run the extraction pipeline, persist results."""

from __future__ import annotations

import io
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import numpy as np
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import EXTRACTION_VERSION
from ..config import get_settings
from ..models import Document, ExtractionRun, Job, Page, Project
from ..pipeline.confidence import Thresholds
from ..pipeline.document import open_document
from ..pipeline.ocr import get_ocr_provider
from ..pipeline.runner import ExtractionPipeline, InputDocument, PipelineConfig, PageResult
from ..pipeline.vision import get_vision_provider
from ..storage import get_storage
from . import audit
from .openings import merge_run

log = logging.getLogger(__name__)


def _png(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _jpeg(rgb: np.ndarray, max_w: int = 360) -> bytes:
    img = Image.fromarray(rgb)
    img.thumbnail((max_w, max_w * 2))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def render_scale(w: float, h: float, unit: str) -> float:
    s = get_settings()
    if unit == "pt":
        scale = s.render_dpi / 72.0
    else:
        scale = 1.0
    return min(scale, s.render_max_px / max(w, h))


def render_document_pages(db: Session, project: Project, doc: Document, data: bytes, start_index: int, progress=None) -> int:
    """Render page images + thumbnails and create Page rows. Returns page count."""
    storage = get_storage()
    parsed = open_document(data, doc.original_filename)
    try:
        existing = {p.page_in_document: p for p in db.scalars(select(Page).where(Page.document_id == doc.id)).all()}
        for i in range(parsed.page_count):
            w, h, unit = parsed.page_size(i)
            page = existing.get(i)
            if page is None:
                page = Page(project_id=project.id, document_id=doc.id, page_in_document=i, page_index=start_index + i, width=w, height=h, unit=unit)
                db.add(page)
                db.flush()
            page.page_index = start_index + i
            page.width, page.height, page.unit = w, h, unit
            if not page.image_key or not storage.exists(page.image_key):
                scale = render_scale(w, h, unit)
                rgb = parsed.render(i, scale)
                key = f"projects/{project.id}/pages/{page.id}.png"
                storage.put(key, _png(rgb), "image/png")
                tkey = f"projects/{project.id}/pages/{page.id}.thumb.jpg"
                storage.put(tkey, _jpeg(rgb), "image/jpeg")
                page.image_key, page.thumb_key = key, tkey
                page.image_height, page.image_width = int(rgb.shape[0]), int(rgb.shape[1])
            if progress:
                progress("rendered", (i + 1) / parsed.page_count, f"Rendered {doc.original_filename} page {i + 1} of {parsed.page_count}")
        doc.page_count = parsed.page_count
        doc.status = "rendered"
        db.commit()
        return parsed.page_count
    finally:
        parsed.close()


def _overlay(pr: PageResult) -> dict[str, Any]:
    """Compact per-page data for the drawing viewer (overlays and text search)."""
    return {
        "views": [v.to_dict() for v in pr.views],
        "dimensions": [
            {
                "id": d.id,
                "text": d.text,
                "value_mm": round(d.value_mm, 2),
                "kind": d.kind,
                "axis": d.axis,
                "text_bbox": d.text_bbox.to_dict(),
                "line": d.line.to_dict() if d.line else None,
                "extension_lines": [s.to_dict() for s in d.extension_lines],
                "chain_id": d.chain_id,
                "scale_check": d.scale_check,
            }
            for d in pr.dims
        ],
        "tags": [{"id": t.id, "text": t.text, "bbox": t.bbox.to_dict()} for t in pr.tags],
        "detections": [
            {
                "id": d.id,
                "kind": d.kind,
                "bbox": d.bbox.to_dict(),
                "tag": d.tag.text if d.tag else None,
                "confidence": round(d.confidence, 3),
                "view_type": d.view_type,
                "width_dimension_id": d.width_assoc.dimension_id if d.width_assoc else None,
                "height_dimension_id": d.height_assoc.dimension_id if d.height_assoc else None,
            }
            for d in pr.detections
        ],
        "schedule_rows": [{"id": s.id, "tag": s.tag, "row_bbox": s.row_bbox.to_dict()} for s in pr.schedules],
        "text": [{"id": ln.id, "text": ln.text, "bbox": ln.bbox.to_dict()} for ln in pr.page.lines],
    }


def build_pipeline(project: Project, pages: list[Page]) -> ExtractionPipeline:
    s = get_settings()
    cfg = PipelineConfig(
        thresholds=Thresholds.from_dict((project.settings or {}).get("thresholds")),
        ocr_dpi=s.ocr_dpi,
        max_vision_calls=s.max_vision_calls_per_run,
        manual_scales={p.page_index: p.scale_override for p in pages if p.scale_override and p.scale_override.get("ratio")},
        page_type_overrides={p.page_index: p.page_type_override for p in pages if p.page_type_override},
    )
    ocr = get_ocr_provider(s.ocr_provider)
    vision = get_vision_provider(s.vision_provider, s.anthropic_api_key, s.vision_model, s.vision_effort)
    return ExtractionPipeline(ocr, vision, cfg)


def process_project(db: Session, job: Job, progress) -> None:
    storage = get_storage()
    project = db.get(Project, job.project_id)
    if project is None:
        raise ValueError("project no longer exists")
    docs = list(db.scalars(select(Document).where(Document.project_id == project.id, Document.status != "failed").order_by(Document.created_at)).all())
    if not docs:
        raise ValueError("no documents to process")

    # 1. render pages (new documents only)
    progress("rendered", 0.0, "Rendering pages")
    datas: list[tuple[Document, bytes]] = []
    index = 0
    for doc in docs:
        data = storage.get(doc.storage_key)
        datas.append((doc, data))
        try:
            n = render_document_pages(db, project, doc, data, index, progress)
        except Exception as exc:
            doc.status = "failed"
            doc.error = f"Could not render: {exc}"
            db.commit()
            raise
        index += n
    progress("rendered", 1.0, f"{index} pages rendered")

    pages = list(db.scalars(select(Page).where(Page.project_id == project.id).order_by(Page.page_index)).all())
    by_index = {p.page_index: p for p in pages}

    # 2. extraction run
    run = ExtractionRun(project_id=project.id, version=EXTRACTION_VERSION, status="running", trigger=job.payload.get("trigger", "upload"), created_by=job.created_by)
    db.add(run)
    db.commit()
    job.run_id = run.id
    db.commit()

    pipeline = build_pipeline(project, pages)
    inputs = [InputDocument(i, d.original_filename, data) for i, (d, data) in enumerate(datas)]
    result = pipeline.run(inputs, progress)

    # 3. persist page analysis
    for pr in result.pages:
        page = by_index.get(pr.page.index)
        if page is None:
            continue
        cls = pr.cls
        page.page_type = cls.page_type
        page.classification = cls.to_dict()
        page.sheet_number = cls.sheet_number
        page.sheet_title = cls.sheet_title
        page.floor = cls.floor
        page.quality = pr.page.quality.to_dict()
        page.mm_per_unit = pr.page.mm_per_unit
        page.rotation = pr.page.rotation
        drawing_views = [v for v in pr.views if v.view_type not in ("notes", "cover")]
        primary = drawing_views[0] if drawing_views else (pr.views[0] if pr.views else None)
        page.scale = {
            "primary": primary.scale.to_dict() if primary else None,
            "views": [{"id": v.id, "title": v.title, "view_type": v.view_type, "scale": v.scale.to_dict()} for v in pr.views],
        }
        akey = f"projects/{project.id}/analysis/{page.id}.json"
        storage.put(akey, json.dumps(pr.to_dict()).encode(), "application/json")
        okey = f"projects/{project.id}/analysis/{page.id}.overlay.json"
        storage.put(okey, json.dumps(_overlay(pr)).encode(), "application/json")
        page.analysis_key, page.overlay_key = akey, okey
        page.run_id = run.id
    db.commit()

    # 4. merge opening records (never silently overwriting user edits)
    stats = merge_run(db, project, run.id, result.records, by_index)
    for doc, _ in datas:
        doc.status = "processed"
    run.status = "succeeded"
    run.finished_at = datetime.now(timezone.utc)
    run.models = result.models
    run.warnings = result.warnings
    run.stats = {
        "pages": len(result.pages),
        "records": len(result.records),
        "physical_openings": sum(r["quantity"] or 0 for r in result.records),
        "needs_review": sum(1 for r in result.records if r["status"] == "needs_review"),
        "merge": stats,
        "stages": result.stages,
        "vision_calls": result.models.get("vision_calls", 0),
    }
    project.current_run_id = run.id
    project.last_processed_at = run.finished_at
    audit.record(db, project.id, "system", "extraction_run", f"Extraction v{EXTRACTION_VERSION} completed: {len(result.records)} opening types, {stats['created']} new, {stats['updated']} updated, {stats['pending_confirmation']} awaiting confirmation")
    db.commit()


def mark_failed(db: Session, job: Job, error: str) -> None:
    if job.run_id:
        run = db.get(ExtractionRun, job.run_id)
        if run is not None:
            run.status = "failed"
            run.finished_at = datetime.now(timezone.utc)
            run.warnings = list(run.warnings or []) + [error]
