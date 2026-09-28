from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..jobs import enqueue
from ..models import Document, Opening, Page, Project, User
from ..security import sign_payload
from ..services import audit
from ..services.uploads import UploadError, validate
from ..storage import get_storage
from .deps import current_user, project_access, rate_limit
from .projects import job_out

router = APIRouter(prefix="/api/projects/{project_id}/documents", tags=["documents"])


def doc_out(d: Document) -> dict:
    return {
        "id": str(d.id),
        "filename": d.original_filename,
        "content_type": d.content_type,
        "size_bytes": d.size_bytes,
        "page_count": d.page_count,
        "status": d.status,
        "error": d.error,
        "sha256": d.sha256,
        "created_at": d.created_at.isoformat(),
    }


@router.get("")
def list_documents(project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    docs = db.scalars(select(Document).where(Document.project_id == project.id).order_by(Document.created_at)).all()
    return [doc_out(d) for d in docs]


@router.post("", status_code=201, dependencies=[Depends(rate_limit("upload", "rate_limit_upload"))])
async def upload_documents(request: Request, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_settings()
    form = await request.form(max_files=s.max_files_per_upload, max_fields=10)
    files = form.getlist("files")
    if not files:
        raise HTTPException(422, "No files uploaded")
    storage = get_storage()
    created, errors = [], []
    limit = s.max_upload_mb * 1024 * 1024
    for f in files:
        if not hasattr(f, "read"):
            continue
        name = getattr(f, "filename", None) or "upload"
        # read with a hard size cap
        chunks, total = [], 0
        while True:
            chunk = await f.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                break
            chunks.append(chunk)
        await f.close()
        if total > limit:
            errors.append({"filename": name, "error": f"File exceeds the {s.max_upload_mb} MB limit"})
            continue
        data = b"".join(chunks)
        try:
            meta = validate(name, data)
        except UploadError as exc:
            errors.append({"filename": name, "error": str(exc)})
            continue
        dup = db.scalar(select(Document).where(Document.project_id == project.id, Document.sha256 == meta["sha256"]))
        if dup is not None:
            errors.append({"filename": meta["filename"], "error": f"This file was already uploaded as {dup.original_filename}"})
            continue
        doc = Document(
            project_id=project.id,
            original_filename=meta["filename"],
            content_type=meta["content_type"],
            size_bytes=meta["size"],
            sha256=meta["sha256"],
            storage_key=f"projects/{project.id}/documents/{uuid.uuid4()}.{meta['ext']}",
            page_count=meta["page_count"],
            uploaded_by=user.id,
        )
        storage.put(doc.storage_key, data, meta["content_type"])
        db.add(doc)
        db.flush()
        audit.record(db, project.id, "user", "upload", f"Uploaded {doc.original_filename} ({doc.page_count} page{'s' if doc.page_count != 1 else ''})", user_id=user.id)
        created.append(doc)
    job = None
    if created:
        job = enqueue(db, project.id, payload={"trigger": "upload"}, user_id=user.id)
    db.commit()
    if not created and errors:
        raise HTTPException(422, {"message": "No files were accepted", "errors": errors})
    return {"documents": [doc_out(d) for d in created], "errors": errors, "job": job_out(job) if job else None}


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: uuid.UUID, project: Project = Depends(project_access("editor")), user: User = Depends(current_user), db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "Document not found")
    storage = get_storage()
    pages = db.scalars(select(Page).where(Page.document_id == doc.id)).all()
    page_ids = {p.id for p in pages}
    for p in pages:
        for k in (p.image_key, p.thumb_key, p.analysis_key, p.overlay_key):
            if k:
                storage.delete(k)
    # AI openings sourced only from this document are removed; user edits are kept but unlinked
    for o in db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.page_id.in_(page_ids))).all():
        o.page_id = None
    storage.delete(doc.storage_key)
    audit.record(db, project.id, "user", "delete_document", f"Deleted {doc.original_filename}", user_id=user.id)
    db.delete(doc)
    # renumber remaining pages
    remaining = db.scalars(select(Page).join(Document, Document.id == Page.document_id).where(Page.project_id == project.id).order_by(Document.created_at, Page.page_in_document)).all()
    for i, p in enumerate(remaining):
        p.page_index = i
    db.commit()


@router.get("/{document_id}/download")
def download_document(document_id: uuid.UUID, project: Project = Depends(project_access("viewer")), db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "Document not found")
    token = sign_payload({"k": doc.storage_key, "p": str(project.id), "ct": doc.content_type, "fn": doc.original_filename, "dl": 1})
    return {"url": f"/api/files/{token}", "expires_in": get_settings().signed_url_ttl_seconds}
