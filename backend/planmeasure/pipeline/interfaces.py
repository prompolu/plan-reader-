"""Provider interfaces. Implementations can be swapped without touching the pipeline.

* ``DocumentParser``   - opens PDFs/images, renders pages, extracts text layer + vector geometry
* ``OCRProvider``      - reads text from raster images
* ``VisionProvider``   - a vision-capable model used for ambiguous cases
* ``OpeningDetector``  - finds openings on a page view
* ``DimensionDetector``- finds dimension annotations on a page
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

import numpy as np

from .types import BBox, DimensionAnnotation, OpeningDetection, PageClassification, PageData, TagDetection, TextLine, View


@runtime_checkable
class ParsedDocument(Protocol):
    kind: str  # "pdf" | "image"
    page_count: int

    def page_size(self, i: int) -> tuple[float, float, str]:
        """(width, height, unit) of page ``i`` in page units."""

    def extract(self, i: int) -> PageData:
        """Text layer and vector geometry (no OCR)."""

    def render(self, i: int, scale: float, clip: BBox | None = None) -> np.ndarray:
        """Render to an RGB array; ``scale`` = pixels per page unit."""

    def close(self) -> None: ...


@runtime_checkable
class DocumentParser(Protocol):
    def supports(self, content_type: str) -> bool: ...

    def open(self, data: bytes, filename: str) -> ParsedDocument: ...


@runtime_checkable
class OCRProvider(Protocol):
    name: str

    def available(self) -> bool: ...

    def recognize(self, rgb: np.ndarray, unit_per_px: float, id_prefix: str) -> list[TextLine]:
        """Return text lines in page units (pixel coordinates * ``unit_per_px``)."""


@runtime_checkable
class VisionProvider(Protocol):
    name: str
    model: str | None

    def available(self) -> bool: ...

    def classify_page(self, image_png: bytes, text_excerpt: str) -> dict[str, Any] | None:
        """Return {"page_type": str, "confidence": float, "rationale": str} or None."""

    def adjudicate_association(self, image_png: bytes, question: dict[str, Any]) -> dict[str, Any] | None:
        """Choose among candidate dimension ids for an opening.

        Returns {"choice": <candidate id or "none">, "confidence": float, "rationale": str}.
        The model only ever selects from ids detected in the drawing text; it
        never supplies a numeric value itself.
        """


@runtime_checkable
class OpeningDetector(Protocol):
    name: str

    def detect(
        self,
        page: PageData,
        view: View,
        tags: list[TagDetection],
        ctx: "DetectionContext",
    ) -> list[OpeningDetection]: ...


@runtime_checkable
class DimensionDetector(Protocol):
    name: str

    def detect(self, page: PageData, views: list[View], cls: PageClassification, ctx: "DetectionContext") -> list[DimensionAnnotation]: ...


class DetectionContext:
    """Per-page scale helpers shared by detectors."""

    def __init__(self, page: PageData, view: View | None):
        self.page = page
        self.view = view
        ratio = view.scale.ratio if view and view.scale.ratio else None
        self.scale_known = ratio is not None and page.mm_per_unit is not None
        mpu = page.mm_per_unit
        if mpu is None:
            # raster page with no DPI: estimate paper size from text height (~2.5 mm)
            sizes = sorted(ln.size for ln in page.lines if ln.size > 0)
            med = sizes[len(sizes) // 2] if sizes else 10.0
            mpu = 2.5 / med
        self.mm_per_unit = mpu
        self.ratio = ratio if ratio else 100.0
        # page units per real-world millimetre
        self.upm = 1.0 / (self.ratio * self.mpu_safe)
        # geometric tolerance floor: raster geometry jitters by a few pixels
        self.raster = page.quality.kind in ("raster",) or page.unit == "px"
        self.min_tol = 3.0 if page.unit == "px" else (1.2 if self.raster else 0.0)

    @property
    def mpu_safe(self) -> float:
        return self.mm_per_unit

    def real(self, units: float) -> float:
        """Page units -> real millimetres (using the view scale or an assumed 1:100)."""
        return units * self.mm_per_unit * self.ratio

    def units(self, real_mm: float) -> float:
        return real_mm * self.upm
