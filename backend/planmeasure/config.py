"""Application settings (environment variables prefixed with ``PM_``)."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-insecure-secret-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PM_", env_file=".env", extra="ignore")

    env: str = "development"  # development | production | test
    database_url: str = "postgresql+psycopg://planmeasure:planmeasure@localhost:5432/planmeasure"
    secret_key: str = DEV_SECRET

    # storage
    storage_backend: str = "local"  # local | s3
    storage_dir: str = "./storage"
    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None
    s3_region: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None

    # upload limits
    max_upload_mb: int = 200
    max_pages_per_document: int = 300
    max_files_per_upload: int = 20
    max_image_pixels: int = 120_000_000

    # auth / sessions
    allow_registration: bool = True
    cookie_secure: bool = False
    session_ttl_hours: int = 12
    # sign-in free browser workspaces: sliding lifetime of the workspace cookie
    workspace_session_days: int = 365
    signed_url_ttl_seconds: int = 900

    # rate limits ("<count>/<second|minute|hour>")
    rate_limit_auth: str = "10/minute"
    rate_limit_upload: str = "60/hour"
    rate_limit_api: str = "1200/minute"
    rate_limit_export: str = "60/hour"
    redis_url: str | None = None

    # processing
    ocr_provider: str = "tesseract"  # tesseract | none
    ocr_dpi: int = 300
    vision_provider: str = "none"  # none | anthropic
    anthropic_api_key: str | None = None
    vision_model: str = "claude-opus-5-5"
    vision_effort: str = "medium"
    max_vision_calls_per_run: int = 40
    render_dpi: int = 200
    render_max_px: int = 6000
    run_worker_in_process: bool = False
    worker_poll_seconds: float = 1.0
    job_max_attempts: int = 2

    # web
    frontend_dist: str | None = None
    cors_origins: list[str] = Field(default_factory=list)

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    def validate_for_production(self) -> None:
        if self.is_production:
            if self.secret_key == DEV_SECRET or len(self.secret_key) < 32:
                raise RuntimeError("PM_SECRET_KEY must be set to a random value of at least 32 characters in production")
            if not self.cookie_secure:
                raise RuntimeError("PM_COOKIE_SECURE must be true in production (HTTPS only)")


@lru_cache
def get_settings() -> Settings:
    return Settings()
