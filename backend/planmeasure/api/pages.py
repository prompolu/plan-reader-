from __future__ import annotations

import io
import json
import threading
import uuid
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Document, Page, Project, User
from ..pipeline.document import open_document
from ..pipeline.scale import format_ratio, parse_scale
from ..pipeline.types import PAGE_TYPE_LABELS, PAGE_TYPES, BBox
from ..security import sign_payload, verify_signed
from ..services import audit
from ..storage import get_storage
from .deps import current_user, project_access

router = APIRouter(prefix="/api/projects/{project_id}/pages", tags=["pages"])


def file_url(key: str | None, project_id, ct: str) -> str | None:
    if not key:
        return None
    return "/api/files/" + sign_payload({"k": key, "p": str(project_id), "ct": ct})


def page_out(p: Page, doc: Document | None = None) -> dict:
    cls = p.classification or {}
    return {
        "id": str(p.id),
        "document_id": str(p.document_id),
        "document": doc.original_filename if doc else None,
        "page_index": p.page_index,
        "page": p.page_index + 1,
        "page_in_document": p.page_in_document + 1,
        "width": p.width,
        "height": p.height,
        "unit": p.unit,
        "mm_per_unit": p.mm_per_unit,
        "rotation": p.rotation,
        "image_url": file_url(p.image_key, p.project_id, "image/png"),
        "thumb_url": file_url(p.thumb_key, p.project_id, "image/jpeg"),
        "image_width": p.image_width,
        "image_height": p.image_height,
        "region_token": sign_payload({"page": str(p.id), "p": str(p.project_id)}),
        "page_type": p.page_type_override or p.page_type,
        "page_type_detected": p.page_type,
        "page_type_override": p.page_type_override,
        "page_type_label": PAGE_TYPE_LABELS.get(p.page_type_override or p.page_type or "", "Not analysed"),
        "classification_confidence": cls.get("confidence"),
        "classification_signals": cls.get("signals", []),
        "secondary_types": cls.get("secondary_types", []),
        "sheet_number": p.sheet_number,
        "sheet_title": p.sheet_title,
        "floor": p.floor,
        "scale": p.scale or {},
        "scale_override": p.scale_override,
        "quality": p.quality or {},
        "analysed": p.overlay_key is not None,
    }


@router.get("")
def list_pages(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    rows = db.execute(select(Page, Document).join(Document, Document.id == Page.document_id).where(Page.project_id == project.id).order_by(Page.page_index)).all()
    return [page_out(p, d) for p, d in rows]


def _page(db: Session, project: Project, page_id: uuid.UUID) -> Page:
    p = db.get(Page, page_id)
    if p is None or p.project_id != project.id:
        raise HTTPException(404, "Page not found")
    return p


class PagePatch(BaseModel):
    page_type_override: str | None = None
    scale_override: str | None = None  # e.g. "1:100" or '1/4" = 1\'-0"'; "" clears
    clear_page_type: bool = False


@router.patch("/{page_id}")
def update_page(page_id: uuid.UUID, body: PagePatch, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = _page(db, project, page_id)
    if body.clear_page_type:
        p.page_type_override = None
        audit.record(db, project.id, "user", "page_type", f"Page {p.page_index + 1}: page type override removed", user_id=user.id)
    elif body.page_type_override is not None:
        if body.page_type_override not in PAGE_TYPES:
            raise HTTPException(422, "unknown page type")
        p.page_type_override = body.page_type_override
        audit.record(db, project.id, "user", "page_type", f"Page {p.page_index + 1} classified as {PAGE_TYPE_LABELS[body.page_type_override]} by user", user_id=user.id, new=body.page_type_override)
    if body.scale_override is not None:
        if body.scale_override.strip() == "":
            p.scale_override = None
            audit.record(db, project.id, "user", "scale", f"Page {p.page_index + 1}: manual scale removed", user_id=user.id)
        else:
            parsed = parse_scale(body.scale_override)
            if parsed is None:
                raise HTTPException(422, "Could not read that scale - use e.g. 1:100 or 1/4\" = 1'-0\"")
            text, ratio = parsed
            p.scale_override = {"text": text if "=" in text else format_ratio(ratio), "ratio": ratio}
            audit.record(db, project.id, "user", "scale", f"Page {p.page_index + 1}: manual scale set to {p.scale_override['text']}", user_id=user.id, new=p.scale_override)
    db.commit()
    return page_out(p, db.get(Document, p.document_id))


@router.get("/{page_id}/overlay")
def page_overlay(page_id: uuid.UUID, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    p = _page(db, project, page_id)
    if not p.overlay_key:
        return {"views": [], "dimensions": [], "tags": [], "detections": [], "schedule_rows": [], "text": []}
    return Response(get_storage().get(p.overlay_key), media_type="application/json", headers={"Cache-Control": "private, no-store"})


# -- high resolution region rendering ------------------------------------------------

_doc_cache: "OrderedDict[uuid.UUID, tuple[object, threading.Lock]]" = OrderedDict()
_cache_lock = threading.Lock()


def _open_cached(doc: Document):
    with _cache_lock:
        if doc.id in _doc_cache:
            _doc_cache.move_to_end(doc.id)
            return _doc_cache[doc.id]
    data = get_storage().get(doc.storage_key)
    parsed = open_document(data, doc.original_filename)
    entry = (parsed, threading.Lock())
    with _cache_lock:
        _doc_cache[doc.id] = entry
        while len(_doc_cache) > 6:
            _, (old, _) = _doc_cache.popitem(last=False)
            try:
                old.close()
            except Exception:
                pass
    return entry


@router.get("/{page_id}/region")
def page_region(
    page_id: uuid.UUID,
    x: float,
    y: float,
    w: float = Query(gt=0),
    h: float = Query(gt=0),
    scale: float = Query(gt=0, le=12),
    t: str = Query(...),
    project: Project = Depends(project_access("viewer")),
    db: Session = Depends(get_db),
):
    """Render part of a page at high resolution (for readable small text when zoomed in)."""
    claims = verify_signed(t)
    if not claims or claims.get("page") != str(page_id) or claims.get("p") != str(project.id):
        raise HTTPException(403, "Invalid or expired link")
    p = _page(db, project, page_id)
    doc = db.get(Document, p.document_id)
    # cap output size
    scale = min(scale, 4096 / max(w, h))
    parsed, lock = _open_cached(doc)
    with lock:
        rgb = parsed.render(p.page_in_document, scale, clip=BBox(x, y, w, h))
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "private, max-age=600"})


@router.get("/{page_id}/crop")
def page_crop(page_id: uuid.UUID, bbox: str, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    """Crop with highlight (used for evidence thumbnails)."""
    from ..reports.pdf import crop_with_highlight

    p = _page(db, project, page_id)
    if not p.image_key:
        raise HTTPException(404, "Page not rendered")
    try:
        b = json.loads(bbox)
        box = {"x": float(b["x"]), "y": float(b["y"]), "width": float(b["width"]), "height": float(b["height"])}
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, "invalid bbox")
    png = crop_with_highlight(get_storage().get(p.image_key), p.width, p.height, box, [])
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=600"})


search_router = APIRouter(prefix="/api/projects/{project_id}", tags=["pages"])


@search_router.get("/search")
def search_text(q: str = Query(min_length=1, max_length=100), project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    """Search drawing text (tags, dimensions, notes) across all pages."""
    needle = q.strip().upper()
    storage = get_storage()
    out = []
    for p in db.scalars(select(Page).where(Page.project_id == project.id).order_by(Page.page_index)).all():
        if not p.overlay_key:
            continue
        ov = json.loads(storage.get(p.overlay_key))
        for t in ov.get("text", []):
            if needle in t["text"].upper():
                out.append({"page_id": str(p.id), "page_index": p.page_index, "sheet": p.sheet_number, "text": t["text"], "bbox": t["bbox"]})
                if len(out) >= 200:
                    return out
    return out
