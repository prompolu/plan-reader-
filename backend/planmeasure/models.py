"""Database models (PostgreSQL)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(300))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)

    user: Mapped[User] = relationship()


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    info: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # project name, drawing set, address, prepared by, date, notes
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # thresholds, display unit
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    current_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    last_processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ProjectMember(Base):
    __tablename__ = "project_members"
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(20), default="owner")  # owner | editor | viewer
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(500))
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="uploaded")  # uploaded | rendered | processed | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (UniqueConstraint("document_id", "page_in_document"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    page_index: Mapped[int] = mapped_column(Integer)  # order within the project
    page_in_document: Mapped[int] = mapped_column(Integer)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(8))
    mm_per_unit: Mapped[float | None] = mapped_column(Float, nullable=True)
    rotation: Mapped[int] = mapped_column(Integer, default=0)
    image_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    image_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thumb_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    page_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    page_type_override: Mapped[str | None] = mapped_column(String(32), nullable=True)
    classification: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    sheet_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sheet_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    floor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scale: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # effective scale info per view
    scale_override: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # user-entered
    quality: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    analysis_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    overlay_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ExtractionRun(Base):
    __tablename__ = "extraction_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(32))
    models: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="running")
    trigger: Mapped[str] = mapped_column(String(20), default="upload")
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    warnings: Mapped[list[str]] = mapped_column(JSONB, default=list)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_created", "status", "created_at"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), default="process_project")
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued | running | succeeded | failed
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    step: Mapped[str | None] = mapped_column(String(32), nullable=True)
    steps: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Opening(Base):
    __tablename__ = "openings"
    __table_args__ = (Index("ix_openings_project_active", "project_id", "deleted_at"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    ref: Mapped[str] = mapped_column(String(32))
    type: Mapped[str] = mapped_column(String(32))
    tag: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tag_key: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    width: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    height: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quantity_basis: Mapped[str | None] = mapped_column(String(32), nullable=True)
    page_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pages.id", ondelete="SET NULL"), nullable=True)
    page_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    drawing_reference: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bbox: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    floor: Mapped[str | None] = mapped_column(String(120), nullable=True)
    room: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="extracted")  # extracted | needs_review | verified
    source: Mapped[str] = mapped_column(String(10), default="ai")  # ai | user
    confidence: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    flags: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    instances: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    references: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    schedule: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    source_detections: Mapped[list[str]] = mapped_column(JSONB, default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    ai_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # original AI result, never modified by edits
    pending_ai: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # newer AI result awaiting user confirmation
    edited_fields: Mapped[list[str]] = mapped_column(JSONB, default=list)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sort_index: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    opening_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    opening_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor: Mapped[str] = mapped_column(String(10))  # ai | user | system
    action: Mapped[str] = mapped_column(String(40))
    field: Mapped[str | None] = mapped_column(String(40), nullable=True)
    old_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    new_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
