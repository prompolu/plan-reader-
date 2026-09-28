"""Document parsing: PDF (PyMuPDF) and raster images (Pillow).

Both produce :class:`PageData` in displayed (rotation-applied) page units.
"""

from __future__ import annotations

import io
import math

import numpy as np
import pymupdf
from PIL import Image, ImageOps

from .geometry import extract_vector_geometry
from .types import BBox, PageData, PageGeometry, PageQuality, TextLine

# decompression-bomb guard for images (about 16k x 12k)
Image.MAX_IMAGE_PIXELS = 200_000_000

PDF_MM_PER_PT = 25.4 / 72.0


class PdfDocument:
    kind = "pdf"

    def __init__(self, data: bytes, filename: str = "document.pdf"):
        self.doc = pymupdf.open(stream=data, filetype="pdf")
        if self.doc.needs_pass:
            raise ValueError("PDF is password protected")
        self.filename = filename
        self.page_count = self.doc.page_count

    def page_size(self, i: int) -> tuple[float, float, str]:
        r = self.doc[i].rect
        return (r.width, r.height, "pt")

    def extract(self, i: int, index: int = 0, document_index: int = 0) -> PageData:
        page = self.doc[i]
        m = page.rotation_matrix
        rect = page.rect
        lines = _pdf_lines(page, m, f"p{index}")
        drawings = page.get_drawings()
        geom = extract_vector_geometry(drawings, m)
        n_chars = sum(len(ln.text) for ln in lines)
        quality = PageQuality(kind="vector")
        has_text = n_chars >= 20
        if not has_text and len(geom.segments) < 50:
            # scanned sheet embedded as an image: needs OCR and raster geometry
            quality.kind = "raster"
        elif not has_text:
            # vector geometry with outlined (non-text) lettering: OCR needed for text
            quality.kind = "vector_outlined_text"
        return PageData(
            index=index,
            document_index=document_index,
            page_in_document=i,
            width=rect.width,
            height=rect.height,
            unit="pt",
            mm_per_unit=PDF_MM_PER_PT,
            rotation=page.rotation,
            lines=lines,
            geometry=geom,
            quality=quality,
            has_text_layer=has_text,
            label=f"{self.filename} p.{i + 1}",
        )

    def render(self, i: int, scale: float, clip: BBox | None = None) -> np.ndarray:
        page = self.doc[i]
        mat = pymupdf.Matrix(scale, scale)
        kwargs = {}
        if clip is not None:
            # clip is given in displayed coordinates; PyMuPDF expects unrotated ones
            r = pymupdf.Rect(clip.x0, clip.y0, clip.x1, clip.y1) * page.derotation_matrix
            r.normalize()
            r = r & page.cropbox  # intersect with page
            if r.is_empty:
                return np.zeros((1, 1, 3), dtype=np.uint8)
            kwargs["clip"] = r
        pix = page.get_pixmap(matrix=mat, alpha=False, colorspace=pymupdf.csRGB, **kwargs)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        return arr[:, :, :3].copy()

    def close(self) -> None:
        self.doc.close()


def _transform_dir(m: pymupdf.Matrix, d: tuple[float, float]) -> tuple[float, float]:
    dx, dy = d
    return (m.a * dx + m.c * dy, m.b * dx + m.d * dy)


def _pdf_lines(page: pymupdf.Page, m: pymupdf.Matrix, id_prefix: str) -> list[TextLine]:
    raw = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    out: list[TextLine] = []
    n = 0
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            dx, dy = _transform_dir(m, line.get("dir", (1.0, 0.0)))
            angle = math.degrees(math.atan2(-dy, dx))
            chars: list[tuple[str, BBox, float]] = []
            for span in line.get("spans", []):
                size = float(span.get("size", 0.0))
                for ch in span.get("chars", []):
                    r = pymupdf.Rect(ch["bbox"]) * m
                    r.normalize()
                    chars.append((ch["c"], BBox(r.x0, r.y0, r.width, r.height), size))
            for piece in _split_on_gaps(chars, (dx, dy)):
                text = "".join(c for c, _, _ in piece)
                # trim whitespace
                lo, hi = 0, len(piece)
                while lo < hi and piece[lo][0].isspace():
                    lo += 1
                while hi > lo and piece[hi - 1][0].isspace():
                    hi -= 1
                if lo >= hi:
                    continue
                piece = piece[lo:hi]
                text = "".join(c for c, _, _ in piece)
                boxes = [b for _, b, _ in piece]
                bb = boxes[0]
                for b in boxes[1:]:
                    bb = bb.union(b)
                size = max(s for _, _, s in piece)
                out.append(TextLine(f"{id_prefix}-l{n}", text, bb, boxes, angle, size, "pdf", 1.0))
                n += 1
    return out


def _split_on_gaps(chars: list[tuple[str, BBox, float]], d: tuple[float, float]):
    """Split a PDF text line where characters are far apart (separate annotations)."""
    if not chars:
        return []
    norm = math.hypot(*d) or 1.0
    ux, uy = d[0] / norm, d[1] / norm
    pieces = [[chars[0]]]
    for prev, cur in zip(chars, chars[1:]):
        pb, cb = prev[1], cur[1]
        size = max(prev[2], cur[2], 1.0)
        # extent of each box along the reading direction
        p_hi = max((pb.x0 * ux + pb.y0 * uy), (pb.x1 * ux + pb.y1 * uy), (pb.x0 * ux + pb.y1 * uy), (pb.x1 * ux + pb.y0 * uy))
        c_lo = min((cb.x0 * ux + cb.y0 * uy), (cb.x1 * ux + cb.y1 * uy), (cb.x0 * ux + cb.y1 * uy), (cb.x1 * ux + cb.y0 * uy))
        gap = c_lo - p_hi
        if gap > 0.9 * size or gap < -3 * size:
            pieces.append([cur])
        else:
            pieces[-1].append(cur)
    return pieces


class ImageDocument:
    kind = "image"

    def __init__(self, data: bytes, filename: str = "image.png"):
        img = Image.open(io.BytesIO(data))
        img.load()
        dpi = img.info.get("dpi")
        img = ImageOps.exif_transpose(img)
        self.rgb = np.array(img.convert("RGB"))
        self.filename = filename
        self.page_count = 1
        self.dpi: float | None = None
        if dpi and isinstance(dpi, tuple) and dpi[0] and float(dpi[0]) > 30:
            self.dpi = float(dpi[0])

    def page_size(self, i: int) -> tuple[float, float, str]:
        h, w = self.rgb.shape[:2]
        return (float(w), float(h), "px")

    def extract(self, i: int, index: int = 0, document_index: int = 0) -> PageData:
        h, w = self.rgb.shape[:2]
        return PageData(
            index=index,
            document_index=document_index,
            page_in_document=0,
            width=float(w),
            height=float(h),
            unit="px",
            mm_per_unit=(25.4 / self.dpi) if self.dpi else None,
            rotation=0,
            lines=[],
            geometry=PageGeometry(),
            quality=PageQuality(kind="raster", effective_dpi=self.dpi),
            has_text_layer=False,
            label=self.filename,
        )

    def render(self, i: int, scale: float, clip: BBox | None = None) -> np.ndarray:
        import cv2

        img = self.rgb
        if clip is not None:
            h, w = img.shape[:2]
            x0, y0 = max(int(clip.x0), 0), max(int(clip.y0), 0)
            x1, y1 = min(int(math.ceil(clip.x1)), w), min(int(math.ceil(clip.y1)), h)
            if x1 <= x0 or y1 <= y0:
                return np.zeros((1, 1, 3), dtype=np.uint8)
            img = img[y0:y1, x0:x1]
        if abs(scale - 1.0) > 1e-6:
            nh, nw = max(1, int(round(img.shape[0] * scale))), max(1, int(round(img.shape[1] * scale)))
            img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        return np.ascontiguousarray(img)

    def close(self) -> None:
        self.rgb = np.zeros((1, 1, 3), dtype=np.uint8)


def sniff_type(data: bytes) -> str | None:
    """Identify file type by magic bytes (never trust the extension alone)."""
    if data[:5] == b"%PDF-":
        return "application/pdf"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return None


def open_document(data: bytes, filename: str):
    kind = sniff_type(data)
    if kind == "application/pdf":
        return PdfDocument(data, filename)
    if kind in ("image/png", "image/jpeg"):
        return ImageDocument(data, filename)
    raise ValueError("Unsupported file type")


def png_bytes(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def jpeg_bytes(rgb: np.ndarray, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()
