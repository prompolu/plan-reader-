"""Authentication primitives, CSRF, signed URLs and rate limiting."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .config import get_settings

_ph = PasswordHasher()

SESSION_COOKIE = "pm_session"
CSRF_COOKIE = "pm_csrf"
CSRF_HEADER = "x-csrf-token"


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, pw)
    except (VerificationError, InvalidHashError):
        return False


def validate_password_strength(pw: str) -> str | None:
    if len(pw) < 10:
        return "Password must be at least 10 characters"
    if pw.lower() == pw or pw.upper() == pw or not any(c.isdigit() for c in pw):
        return "Password must mix upper and lower case letters and include a digit"
    return None


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Signed URLs
# ---------------------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_payload(payload: dict, ttl: int | None = None) -> str:
    s = get_settings()
    body = dict(payload)
    body["exp"] = int(time.time()) + (ttl or s.signed_url_ttl_seconds)
    raw = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())
    sig = hmac.new(s.secret_key.encode(), raw.encode(), hashlib.sha256).digest()
    return f"{raw}.{_b64(sig)}"


def verify_signed(token: str) -> dict | None:
    s = get_settings()
    try:
        raw, sig = token.split(".", 1)
        expected = hmac.new(s.secret_key.encode(), raw.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(sig)):
            return None
        body = json.loads(_unb64(raw))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(body.get("exp", 0)) < time.time():
        return None
    return body


# ---------------------------------------------------------------------------
# Rate limiting (sliding window; Redis-backed when PM_REDIS_URL is set)
# ---------------------------------------------------------------------------


def parse_rate(spec: str) -> tuple[int, int]:
    count, per = spec.split("/")
    seconds = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[per.strip()]
    return int(count), seconds


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()
        self._redis = None
        url = get_settings().redis_url
        if url:
            try:
                import redis

                self._redis = redis.Redis.from_url(url)
            except Exception:  # pragma: no cover - optional dependency
                self._redis = None

    def hit(self, key: str, spec: str) -> tuple[bool, int]:
        """Record a hit. Returns (allowed, retry_after_seconds)."""
        limit, window = parse_rate(spec)
        now = time.time()
        if self._redis is not None:
            k = f"pm:rl:{key}:{int(now // window)}"
            n = self._redis.incr(k)
            if n == 1:
                self._redis.expire(k, window)
            return (n <= limit, int(window - now % window) + 1)
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                return False, int(q[0] + window - now) + 1
            q.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = RateLimiter()
