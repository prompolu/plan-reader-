from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from ..models import AuditEvent, Opening


def record(
    db: Session,
    project_id: uuid.UUID,
    actor: str,
    action: str,
    message: str,
    *,
    opening: Opening | None = None,
    user_id: uuid.UUID | None = None,
    field: str | None = None,
    old: Any = None,
    new: Any = None,
) -> AuditEvent:
    ev = AuditEvent(
        project_id=project_id,
        opening_id=opening.id if opening else None,
        opening_ref=(f"{opening.ref}" + (f" {opening.tag}" if opening.tag else "")) if opening else None,
        user_id=user_id,
        actor=actor,
        action=action,
        field=field,
        old_value=old,
        new_value=new,
        message=message,
    )
    db.add(ev)
    return ev
