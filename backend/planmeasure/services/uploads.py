"""Safe handling of uploaded drawings."""

from __future__ import annotations

import hashlib
import io
import re
import unicodedata

from ..config import get_settings
from ..pipeline.document import sniff_type

ALLOWED = {"application/pdf": {".pdf"}, "image/png": {".png"}, "image/jpeg": {".jpg", ".jpeg"}}
EXT_FOR = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}


class UploadError(ValueError):
    pass


def safe_filename(name: str) -> str:
    name = (name or "upload").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFKC", name)
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*')
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name or "upload")[:200]


def validate(filename: str, data: bytes) -> dict:
    """Validate type (by content, not just extension), size and structure."""
    s = get_settings()
    if not data:
        raise UploadError("File is empty")
    if len(data) > s.max_upload_mb * 1024 * 1024:
        raise UploadError(f"File exceeds the {s.max_upload_mb} MB limit")
    ctype = sniff_type(data)
    if ctype is None:
        raise UploadError("Unsupported file type - upload PDF, PNG or JPG drawings")
    name = safe_filename(filename)
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext not in ALLOWED[ctype]:
        raise UploadError(f"File extension does not match its content ({ctype})")
    pages = 1
    if ctype == "application/pdf":
        import pymupdf

        try:
            doc = pymupdf.open(stream=data, filetype="pdf")
        except Exception:
            raise UploadError("The PDF could not be read (damaged or not a PDF)")
        try:
            if doc.needs_pass or doc.is_encrypted:
                raise UploadError("Password-protected PDFs are not supported - remove the password and upload again")
            pages = doc.page_count
            if pages == 0:
                raise UploadError("The PDF has no pages")
            if pages > s.max_pages_per_document:
                raise UploadError(f"The PDF has {pages} pages; the limit is {s.max_pages_per_document}")
            for p in doc:
                r = p.rect
                if r.width <= 0 or r.height <= 0 or max(r.width, r.height) > 14400:  # 200 in
                    raise UploadError("The PDF has an invalid page size")
        finally:
            doc.close()
    else:
        from PIL import Image

        try:
            with Image.open(io.BytesIO(data)) as img:
                w, h = img.size
                if w * h > s.max_image_pixels:
                    raise UploadError("Image resolution is too large")
                img.verify()
        except UploadError:
            raise
        except Exception:
            raise UploadError("The image could not be read (damaged or unsupported)")
    return {
        "content_type": ctype,
        "filename": name,
        "page_count": pages,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "ext": EXT_FOR[ctype],
    }
