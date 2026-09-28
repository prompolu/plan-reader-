"""Shared API dependencies: authentication, CSRF, project authorization, rate limits."""

from __future__ import annotations

import hmac
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Project, ProjectMember, User, UserSession
from ..security import CSRF_HEADER, SESSION_COOKIE, rate_limiter, token_hash

ROLE_RANK = {"viewer": 0, "editor": 1, "owner": 2}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str, spec_attr: str):
    def dep(request: Request) -> None:
        spec = getattr(get_settings(), spec_attr)
        who = client_ip(request)
        ok, retry = rate_limiter.hit(f"{bucket}:{who}", spec)
        if not ok:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests - please slow down", headers={"Retry-After": str(retry)})

    return dep


def current_session(request: Request, db: Session = Depends(get_db)) -> UserSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == token_hash(token)))
    now = datetime.now(timezone.utc)
    if sess is None or sess.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired - please sign in again")
    user = db.get(User, sess.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account disabled")
    # CSRF: state-changing requests must echo the per-session token in a header
    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not hmac.compare_digest(sent, sess.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")
    # sliding expiry (at most one write per minute), keeping the session's own lifetime
    if now - sess.last_seen_at > timedelta(minutes=1):
        ttl = max(sess.expires_at - sess.last_seen_at, timedelta(hours=get_settings().session_ttl_hours))
        sess.last_seen_at = now
        sess.expires_at = now + ttl
        db.commit()
    request.state.user = user
    return sess


def current_user(sess: UserSession = Depends(current_session), db: Session = Depends(get_db)) -> User:
    user = db.get(User, sess.user_id)
    assert user is not None
    return user


def project_access(min_role: str = "viewer"):
    def dep(project_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Project:
        m = db.get(ProjectMember, (project_id, user.id))
        project = db.get(Project, project_id)
        # the same 404 for "does not exist" and "not yours": do not leak project ids
        if project is None or m is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        if ROLE_RANK[m.role] < ROLE_RANK[min_role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"This action needs {min_role} access to the project")
        return project

    return dep


def member_role(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
    m = db.get(ProjectMember, (project_id, user_id))
    return m.role if m else None
