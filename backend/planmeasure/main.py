"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from . import __version__
from .api import auth, documents, exports, files, openings, pages, projects, system
from .config import get_settings
from .security import rate_limiter

log = logging.getLogger(__name__)

CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        s = get_settings()
        # global API rate limit and request size guard
        if request.url.path.startswith("/api/"):
            ip = request.client.host if request.client else "unknown"
            ok, retry = rate_limiter.hit(f"api:{ip}", s.rate_limit_api)
            if not ok:
                return JSONResponse({"detail": "Too many requests"}, status_code=429, headers={"Retry-After": str(retry)})
            cl = request.headers.get("content-length")
            max_body = s.max_upload_mb * 1024 * 1024 * s.max_files_per_upload + 1024 * 1024
            if cl and cl.isdigit() and int(cl) > max_body:
                return JSONResponse({"detail": "Request too large"}, status_code=413)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault("Content-Security-Policy", CSP)
        if s.cookie_secure:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/") and "Cache-Control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        return response


def create_app() -> FastAPI:
    s = get_settings()
    s.validate_for_production()
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        stop = None
        if s.run_worker_in_process:
            from .jobs import start_background_worker

            stop = start_background_worker()
            log.info("in-process worker started")
        yield
        if stop is not None:
            stop.set()

    app = FastAPI(
        title="PlanMeasure AI",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if not s.is_production else None,
        openapi_url="/api/openapi.json" if not s.is_production else None,
    )
    app.add_middleware(SecurityHeaders)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    for r in (
        auth.router,
        projects.router,
        documents.router,
        pages.router,
        pages.search_router,
        openings.router,
        openings.review_router,
        exports.router,
        files.router,
        system.router,
    ):
        app.include_router(r)


    # serve the built single-page frontend
    dist = Path(s.frontend_dist) if s.frontend_dist else Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if dist.is_dir():
        index = dist / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                return JSONResponse({"detail": "Not found"}, status_code=404)
            target = (dist / path).resolve()
            if path and dist in target.parents and target.is_file():
                headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
                return FileResponse(target, headers=headers)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
