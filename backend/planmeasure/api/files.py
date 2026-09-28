"""Serving private files through short-lived signed URLs.

A signed URL alone is not enough: the request must also carry a valid session
for a member of the file's project. Nothing in storage is publicly reachable.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, Response
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User
from ..security import verify_signed
from ..storage import get_storage
from .deps import current_user, member_role

router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("/{token}")
def serve(token: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    claims = verify_signed(token)
    if not claims or "k" not in claims or "p" not in claims:
        raise HTTPException(403, "Invalid or expired link")
    try:
        pid = uuid.UUID(claims["p"])
    except ValueError:
        raise HTTPException(403, "Invalid link")
    if member_role(db, pid, user.id) is None:
        raise HTTPException(404, "Not found")
    key = claims["k"]
    if not key.startswith(f"projects/{pid}/"):
        raise HTTPException(403, "Invalid link")
    storage = get_storage()
    ct = claims.get("ct", "application/octet-stream")
    fn = claims.get("fn")
    direct = storage.presigned_url(key, min(get_settings().signed_url_ttl_seconds, 300), ct, fn)
    if direct:
        return RedirectResponse(direct, status_code=302)
    try:
        data = storage.get(key)
    except FileNotFoundError:
        raise HTTPException(404, "Not found")
    headers = {"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"}
    if claims.get("dl") and fn:
        safe = fn.replace('"', "")
        headers["Content-Disposition"] = f'attachment; filename="{safe}"'
    return Response(data, media_type=ct, headers=headers)
