from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditEvent, Opening, Project, User
from ..services import openings as svc
from .deps import current_user, project_access
from .projects import audit_out

router = APIRouter(prefix="/api/projects/{project_id}/openings", tags=["openings"])
review_router = APIRouter(prefix="/api/projects/{project_id}", tags=["openings"])


def _users(db: Session, ops: list[Opening]) -> dict[uuid.UUID, str]:
    ids = {o.verified_by for o in ops if o.verified_by}
    if not ids:
        return {}
    return {u.id: (u.name or u.email) for u in db.scalars(select(User).where(User.id.in_(ids))).all()}


def _get(db: Session, project: Project, opening_id: uuid.UUID, include_deleted: bool = False) -> Opening:
    o = db.get(Opening, opening_id)
    if o is None or o.project_id != project.id or (o.deleted_at is not None and not include_deleted):
        raise HTTPException(404, "Opening not found")
    return o


@router.get("")
def list_openings(include_deleted: bool = False, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    q = select(Opening).where(Opening.project_id == project.id)
    if not include_deleted:
        q = q.where(Opening.deleted_at.is_(None))
    ops = list(db.scalars(q.order_by(Opening.sort_index, Opening.ref)).all())
    users = _users(db, ops)
    return [svc.to_dict(o, users) for o in ops]


class OpeningIn(BaseModel):
    type: str = "window"
    tag: str | None = None
    width: dict[str, Any] | None = None
    height: dict[str, Any] | None = None
    quantity: int | None = 1
    page_index: int | None = None
    drawing_reference: str | None = None
    floor: str | None = None
    room: str | None = None
    notes: str | None = None
    bbox: dict[str, float] | None = None


@router.post("", status_code=201)
def add_opening(body: OpeningIn, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        o = svc.create_manual(db, project, body.model_dump(exclude_none=True), user)
    except svc.EditError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return svc.to_dict(o)


class OpeningPatch(BaseModel):
    changes: dict[str, Any]
    version: int | None = None  # optimistic concurrency


@router.patch("/{opening_id}")
def edit_opening(opening_id: uuid.UUID, body: OpeningPatch, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id)
    if body.version is not None and body.version != o.version:
        raise HTTPException(409, "This opening was changed by someone else - reload to see the latest values")
    try:
        svc.apply_edits(db, project, o, body.changes, user)
    except svc.EditError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return svc.to_dict(o, _users(db, [o]))


class VerifyIn(BaseModel):
    verified: bool = True


@router.post("/{opening_id}/verify")
def verify_opening(opening_id: uuid.UUID, body: VerifyIn | None = None, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id)
    svc.verify(db, project, o, user, True if body is None else body.verified)
    db.commit()
    return svc.to_dict(o, _users(db, [o]))


class ResolveIn(BaseModel):
    field: str
    candidate_index: int


@router.post("/{opening_id}/resolve-conflict")
def resolve(opening_id: uuid.UUID, body: ResolveIn, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.field not in ("width", "height"):
        raise HTTPException(422, "field must be width or height")
    o = _get(db, project, opening_id)
    try:
        svc.resolve_conflict(db, project, o, body.field, body.candidate_index, user)
    except svc.EditError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return svc.to_dict(o)


class PendingIn(BaseModel):
    accept: bool


@router.post("/{opening_id}/ai-update")
def pending_update(opening_id: uuid.UUID, body: PendingIn, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id)
    try:
        svc.accept_pending(db, project, o, user, body.accept)
    except svc.EditError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return svc.to_dict(o)


@router.delete("/{opening_id}", status_code=204)
def delete_opening(opening_id: uuid.UUID, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id)
    svc.soft_delete(db, project, o, user)
    db.commit()


@router.post("/{opening_id}/restore")
def restore_opening(opening_id: uuid.UUID, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id, include_deleted=True)
    svc.restore(db, project, o, user)
    db.commit()
    return svc.to_dict(o)


@router.get("/{opening_id}/audit")
def opening_audit(opening_id: uuid.UUID, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    o = _get(db, project, opening_id, include_deleted=True)
    rows = db.execute(
        select(AuditEvent, User.email, User.name).outerjoin(User, User.id == AuditEvent.user_id).where(AuditEvent.opening_id == o.id).order_by(AuditEvent.id)
    ).all()
    return [audit_out(e, email, name) for e, email, name in rows]


@review_router.get("/review")
def review_queue(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    ops = list(db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.deleted_at.is_(None))).all())
    items = svc.review_items(ops)
    return {"count": len({i["opening_id"] for i in items}), "items": items}
