from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Opening, Page, Project, User
from ..reports.pdf import build_pdf, crop_with_highlight
from ..services import audit
from ..services import openings as osvc
from ..services.schedule import GROUP_BY, build_schedule
from ..storage import get_storage
from .deps import current_user, project_access, rate_limit

router = APIRouter(prefix="/api/projects/{project_id}", tags=["export"])

UNITS = ("original", "mm", "cm", "m", "ft_in")


def _openings(db: Session, project: Project) -> list[Opening]:
    return list(db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.deleted_at.is_(None)).order_by(Opening.sort_index, Opening.ref)).all())


@router.get("/schedule")
def schedule(group_by: str = "type", unit: str = "mm", include_unverified: bool = True, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    if group_by not in GROUP_BY:
        raise HTTPException(422, f"group_by must be one of {', '.join(GROUP_BY)}")
    if unit not in UNITS:
        raise HTTPException(422, "unknown unit")
    return build_schedule(_openings(db, project), group_by, unit, include_unverified)


class ExportIn(BaseModel):
    kind: str = "summary"  # summary | detailed
    page_size: str = "A4"
    orientation: str = "portrait"
    group_by: str = "type"
    unit: str = "mm"
    include_unverified: bool = True
    include_notes: bool = True
    info: dict[str, Any] | None = None  # overrides for this export (saved to the project)


@router.post("/export/pdf", dependencies=[Depends(rate_limit("export", "rate_limit_export"))])
def export_pdf(body: ExportIn, project: Project = Depends(project_access("viewer")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.kind not in ("summary", "detailed"):
        raise HTTPException(422, "kind must be summary or detailed")
    if body.page_size.upper() not in ("A4", "A3", "LETTER") or body.orientation not in ("portrait", "landscape"):
        raise HTTPException(422, "unsupported page size or orientation")
    if body.group_by not in GROUP_BY or body.unit not in UNITS:
        raise HTTPException(422, "invalid grouping or unit")
    info = dict(project.info or {})
    if body.info:
        for k, v in body.info.items():
            if k in ("project_name", "drawing_set_name", "project_address", "prepared_by", "date", "notes") and (v is None or len(str(v)) <= 5000):
                info[k] = v
        from .deps import member_role

        if member_role(db, project.id, user.id) in ("owner", "editor"):
            project.info = info
    ops = _openings(db, project)
    sched = build_schedule(ops, body.group_by, body.unit, body.include_unverified)
    included = [o for o in ops if body.include_unverified or o.verified]
    pages = {p.page_index: p for p in db.scalars(select(Page).where(Page.project_id == project.id)).all()}
    storage = get_storage()
    image_cache: dict[int, bytes] = {}

    def crop(o: dict[str, Any]) -> bytes | None:
        if o.get("page_index") is None or not o.get("bbox"):
            return None
        p = pages.get(o["page_index"])
        if p is None or not p.image_key:
            return None
        if p.page_index not in image_cache:
            image_cache[p.page_index] = storage.get(p.image_key)
        dims = []
        for f in ("width", "height"):
            m = o.get(f)
            if m and m.get("page_index") == o["page_index"] and m.get("bbox"):
                dims.append({"bbox": m["bbox"], "line": m.get("line")})
        return crop_with_highlight(image_cache[p.page_index], p.width, p.height, o["bbox"], dims)

    pdf = build_pdf(
        project={"name": project.name},
        info=info,
        schedule=sched,
        openings=[osvc.to_dict(o) for o in included],
        kind=body.kind,
        page_size=body.page_size,
        orientation=body.orientation,
        include_notes=body.include_notes,
        crop_provider=crop if body.kind == "detailed" else None,
        generated_by=user.name or user.email,
    )
    audit.record(db, project.id, "user", "export_pdf", f"{body.kind.title()} PDF exported ({body.page_size.upper()} {body.orientation}, {len(included)} opening types)", user_id=user.id)
    db.commit()
    fname = re.sub(r"[^A-Za-z0-9._-]+", "_", (info.get("project_name") or project.name))[:60] or "project"
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}_measurement_schedule_{body.kind}.pdf"', "Cache-Control": "no-store"},
    )
