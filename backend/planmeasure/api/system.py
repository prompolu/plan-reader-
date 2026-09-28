from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import EXTRACTION_VERSION, __version__
from ..config import get_settings
from ..db import get_db
from ..models import User
from ..pipeline.ocr import get_ocr_provider
from ..pipeline.types import OPENING_TYPE_LABELS, PAGE_TYPE_LABELS
from .deps import current_user

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@router.get("/system")
def system_info(user: User = Depends(current_user)):
    s = get_settings()
    ocr = get_ocr_provider(s.ocr_provider)
    return {
        "app_version": __version__,
        "extraction_version": EXTRACTION_VERSION,
        "ocr": {"provider": ocr.name, "available": ocr.available(), "version": getattr(ocr, "version", lambda: None)()},
        "vision": {
            "provider": s.vision_provider,
            "model": s.vision_model if s.vision_provider != "none" else None,
            "configured": s.vision_provider != "none" and bool(s.anthropic_api_key),
            "used_for": "ambiguous page classification and dimension associations only; it can only pick among values read from the drawing",
        },
        "limits": {"max_upload_mb": s.max_upload_mb, "max_pages_per_document": s.max_pages_per_document, "max_files_per_upload": s.max_files_per_upload},
        "opening_types": OPENING_TYPE_LABELS,
        "page_types": PAGE_TYPE_LABELS,
        "storage": s.storage_backend,
    }
