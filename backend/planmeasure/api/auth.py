from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User, UserSession
from ..security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    hash_password,
    new_token,
    token_hash,
    validate_password_strength,
    verify_password,
)
from .deps import client_ip, current_session, current_user, rate_limit

router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")
WORKSPACE_DOMAIN = "@workspace.local"


class RegisterIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=200)
    name: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=200)


def is_workspace(u: User) -> bool:
    return u.email.endswith(WORKSPACE_DOMAIN)


def user_out(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name, "preferences": u.preferences or {}, "workspace": is_workspace(u)}


def _start_session(db: Session, user: User, request: Request, response: Response, ttl: timedelta | None = None) -> dict:
    s = get_settings()
    ttl = ttl or timedelta(hours=s.session_ttl_hours)
    token = new_token()
    csrf = new_token()
    now = datetime.now(timezone.utc)
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=token_hash(token),
            csrf_token=csrf,
            last_seen_at=now,
            expires_at=now + ttl,
            ip=client_ip(request),
            user_agent=(request.headers.get("user-agent") or "")[:300],
        )
    )
    # prune this user's expired sessions
    db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.expires_at < now))
    db.commit()
    max_age = int(ttl.total_seconds())
    response.set_cookie(SESSION_COOKIE, token, httponly=True, secure=s.cookie_secure, samesite="lax", max_age=max_age, path="/")
    response.set_cookie(CSRF_COOKIE, csrf, httponly=False, secure=s.cookie_secure, samesite="strict", max_age=max_age, path="/")
    return {"user": user_out(user), "csrf_token": csrf}


@router.post("/register", dependencies=[Depends(rate_limit("auth", "rate_limit_auth"))])
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    if not get_settings().allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is disabled - ask an administrator for an account")
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email) or email.endswith(WORKSPACE_DOMAIN):
        raise HTTPException(422, "Enter a valid email address")
    problem = validate_password_strength(body.password)
    if problem:
        raise HTTPException(422, problem)
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    user = User(email=email, name=body.name.strip()[:200], password_hash=hash_password(body.password), preferences={})
    db.add(user)
    db.flush()
    return _start_session(db, user, request, response)


@router.post("/login", dependencies=[Depends(rate_limit("auth", "rate_limit_auth"))])
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    # constant-ish work whether or not the user exists
    ok = verify_password(body.password, user.password_hash if user else "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$YWJj")
    if not user or not ok or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    return _start_session(db, user, request, response)


@router.post("/workspace")
def workspace(request: Request, response: Response, db: Session = Depends(get_db)):
    """Sign-in free access: give this browser its own private workspace.

    Projects and uploaded drawings belong to the workspace user and are only
    reachable with its session cookie (httpOnly, 256-bit token), exactly like
    a registered account - there is simply no password to type.
    """
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        sess = db.scalar(select(UserSession).where(UserSession.token_hash == token_hash(token)))
        if sess is not None and sess.expires_at > datetime.now(timezone.utc):
            user = db.get(User, sess.user_id)
            if user is not None and user.is_active:
                return {"user": user_out(user), "csrf_token": sess.csrf_token}
    # only creating a workspace is rate limited; reopening an existing one is free
    rate_limit("auth", "rate_limit_auth")(request)
    # "!" is not a valid argon2 hash, so a workspace can never be signed into with a password
    user = User(email=f"{uuid.uuid4().hex}{WORKSPACE_DOMAIN}", name="", password_hash="!", preferences={})
    db.add(user)
    db.flush()
    return _start_session(db, user, request, response, ttl=timedelta(days=get_settings().workspace_session_days))


@router.post("/logout")
def logout(response: Response, sess: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    db.delete(sess)
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(sess: UserSession = Depends(current_session), user: User = Depends(current_user)):
    return {"user": user_out(user), "csrf_token": sess.csrf_token}


class PrefsIn(BaseModel):
    display_unit: str | None = None
    thresholds: dict | None = None


@router.patch("/me/preferences")
def update_prefs(body: PrefsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    prefs = dict(user.preferences or {})
    if body.display_unit is not None:
        if body.display_unit not in ("original", "mm", "cm", "m", "ft_in"):
            raise HTTPException(422, "unknown display unit")
        prefs["display_unit"] = body.display_unit
    if body.thresholds is not None:
        from ..pipeline.confidence import Thresholds

        t = Thresholds.from_dict(body.thresholds)
        prefs["thresholds"] = {"high": t.high, "medium": t.medium}
    user.preferences = prefs
    db.commit()
    return user_out(user)
