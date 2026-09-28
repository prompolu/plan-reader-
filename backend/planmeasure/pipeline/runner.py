"""Pipeline orchestration.

    PDF / image
    -> page rendering + text layer / OCR + geometry           (document, ocr, geometry)
    -> page classification                                     (classify)
    -> view segmentation + scale detection                     (views, scale)
    -> dimension detection (text + line + terminators)         (dimensions)
    -> scale calibration against dimensions                    (scale)
    -> tag detection                                           (tags)
    -> opening detection                                       (openings)
    -> tag and dimension association                           (association, vision)
    -> schedule extraction                                     (schedules)
    -> cross-reference, duplicates, conflicts, confidence      (crossref, confidence)

Every stage is a plain function over dataclasses so it can be tested and
debugged on its own; the runner records per-stage timings and outputs.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from planmeasure import EXTRACTION_VERSION

from .association import assign_tags, associate_dimensions
from .classify import classify_page
from .confidence import Thresholds
from .crossref import PageContext, build_records
from .dimensions import LinearDimensionDetector
from .document import ImageDocument, PdfDocument, open_document, png_bytes
from .geometry import extract_raster_geometry
from .interfaces import DetectionContext, OCRProvider, VisionProvider
from .ocr import NullOCR
from .openings import ElevationOpeningDetector, PlanOpeningDetector
from .quality import assess_raster
from .scale import calibrate_from_dimensions, format_ratio, scale_check
from .schedules import extract_schedules
from .tags import detect_tags, symbol_segment_ids
from .types import (
    SCHEDULE_TYPES,
    BBox,
    DimensionAnnotation,
    OpeningDetection,
    PageClassification,
    PageData,
    ScaleInfo,
    ScheduleEntry,
    TagDetection,
    View,
    evidence,
)
from .vision import NullVisionProvider

log = logging.getLogger(__name__)

DRAWING_VIEWS = {"floor_plan", "elevation", "detail", "section"}

# user-facing processing steps (id, label)
STEPS = [
    ("uploaded", "Uploaded"),
    ("rendered", "PDF rendered"),
    ("analyzed", "Pages analyzed"),
    ("classified", "Relevant pages identified"),
    ("dimensions", "Extracting dimensions"),
    ("openings", "Openings detected"),
    ("associated", "Associating dimensions with openings"),
    ("schedules", "Cross-checking schedules"),
    ("crossref", "Detecting duplicates and conflicts"),
    ("scored", "Scoring confidence"),
]


@dataclass
class InputDocument:
    index: int
    filename: str
    data: bytes


@dataclass
class PipelineConfig:
    thresholds: Thresholds = field(default_factory=Thresholds)
    ocr_dpi: int = 300
    max_vision_calls: int = 40
    vision_classify_below: float = 0.6
    # user overrides keyed by global page index
    manual_scales: dict[int, dict[str, Any]] = field(default_factory=dict)
    page_type_overrides: dict[int, str] = field(default_factory=dict)


@dataclass
class PageResult:
    page: PageData
    cls: PageClassification
    views: list[View]
    dims: list[DimensionAnnotation]
    tags: list[TagDetection]
    detections: list[OpeningDetection]
    orphan_tags: list[TagDetection]
    schedules: list[ScheduleEntry]
    stage_seconds: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        p = self.page
        return {
            "index": p.index,
            "document_index": p.document_index,
            "page_in_document": p.page_in_document,
            "width": p.width,
            "height": p.height,
            "unit": p.unit,
            "mm_per_unit": p.mm_per_unit,
            "rotation": p.rotation,
            "label": p.label,
            "has_text_layer": p.has_text_layer,
            "quality": p.quality.to_dict(),
            "classification": self.cls.to_dict(),
            "views": [v.to_dict() for v in self.views],
            "dimensions": [d.to_dict() for d in self.dims],
            "tags": [t.to_dict() for t in self.tags],
            "detections": [d.to_dict() for d in self.detections],
            "orphan_tags": [t.to_dict() for t in self.orphan_tags],
            "schedules": [s.to_dict() for s in self.schedules],
            "stage_seconds": {k: round(v, 3) for k, v in self.stage_seconds.items()},
        }


@dataclass
class ExtractionResult:
    pages: list[PageResult]
    records: list[dict[str, Any]]
    version: str
    models: dict[str, Any]
    stages: list[dict[str, Any]]
    vision_log: list[dict[str, Any]]
    warnings: list[str]


ProgressFn = Callable[[str, float, str], None]


class ExtractionPipeline:
    def __init__(self, ocr: OCRProvider | None = None, vision: VisionProvider | None = None, config: PipelineConfig | None = None):
        self.ocr = ocr or NullOCR()
        self.vision = vision or NullVisionProvider()
        self.config = config or PipelineConfig()
        self.vision_calls = 0
        self.vision_log: list[dict[str, Any]] = []
        self.warnings: list[str] = []

    # -- stage: per page -------------------------------------------------------

    def analyze_page(self, doc, i: int, index: int, document_index: int) -> PageData:
        """Text layer + geometry; OCR and raster geometry when needed."""
        pd = doc.extract(i, index=index, document_index=document_index)
        needs_ocr = isinstance(doc, ImageDocument) or pd.quality.kind in ("raster", "vector_outlined_text")
        if not needs_ocr:
            return pd
        import cv2

        if isinstance(doc, PdfDocument):
            scale = self.config.ocr_dpi / 72.0
        else:
            # upscale so small annotation text has enough pixels per character
            dpi = doc.dpi or 150.0
            scale = max(1.0, min(3.0, self.config.ocr_dpi / dpi))
            if max(pd.width, pd.height) * scale > 12000:
                scale = max(1.0, 12000 / max(pd.width, pd.height))
        rgb = doc.render(i, scale)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        if self.ocr.available():
            from .geometry import remove_long_lines

            clean = remove_long_lines(gray, max(40, int(min(gray.shape) * 0.012)))
            pd.lines = self.ocr.recognize(clean, 1.0 / scale, f"p{index}")
            if getattr(self.ocr, "name", "") == "tesseract":
                import statistics as _st

                from .ocr import read_symbol_tags

                heights = [ln.size * scale for ln in pd.lines if ln.size > 0 and len(ln.text) >= 3]
                text_px = _st.median(heights) if heights else 20.0
                tag_lines, symbol_boxes = read_symbol_tags(gray, 1.0 / scale, f"p{index}", text_px)
                # symbol reads replace overlapping general OCR fragments
                keep = [ln for ln in pd.lines if not any(sb.contains(ln.bbox, tol=2 / scale) for sb in symbol_boxes)]
                pd.lines = keep + tag_lines
                self._symbol_boxes = symbol_boxes
        else:
            self.warnings.append(f"{pd.label}: OCR is not available, text could not be read from this raster page")
        if pd.quality.kind == "raster" or isinstance(doc, ImageDocument):
            pd.geometry = extract_raster_geometry(gray, 1.0 / scale, mask_boxes=[ln.bbox for ln in pd.lines])
            # tag symbols found by the symbol pass become closed outlines (enclosures)
            for sb in getattr(self, "_symbol_boxes", []):
                pd.geometry.polygons.append([(sb.x0, sb.y0), (sb.x1, sb.y0), (sb.x1, sb.y1), (sb.x0, sb.y1)])
            self._symbol_boxes = []
        dpi = None
        if isinstance(doc, ImageDocument):
            dpi = doc.dpi
        pd.quality = assess_raster(gray, pd.lines, scale, dpi, kind=pd.quality.kind)
        return pd

    def classify(self, doc, pd: PageData) -> PageClassification:
        from .scale import find_scale_mentions

        mentions = [m["text"] for m in find_scale_mentions(pd.lines) if m["ratio"]]
        cls = classify_page(pd, mentions)
        override = self.config.page_type_overrides.get(pd.index)
        if override:
            cls.signals.append({"type": override, "weight": 99, "code": "manual", "detail": "Page type set by user"})
            cls.page_type = override
            cls.confidence = 1.0
            return cls
        if cls.confidence < self.config.vision_classify_below and self._vision_budget():
            try:
                thumb = self._thumb(doc, pd)
                excerpt = "\n".join(ln.text for ln in pd.lines[:200])
                ans = self.vision.classify_page(thumb, excerpt)
                self.vision_log.append({"page": pd.index, "task": "classify", "answer": ans})
                if ans and ans.get("page_type") and float(ans.get("confidence", 0)) >= 0.7:
                    cls.signals.append({"type": ans["page_type"], "weight": 2.0, "code": "vision", "detail": f"Vision model: {ans.get('rationale', '')[:200]}"})
                    if ans["page_type"] != cls.page_type:
                        cls.secondary_types = [cls.page_type] + [t for t in cls.secondary_types if t != ans["page_type"]]
                        cls.page_type = ans["page_type"]
                    cls.confidence = max(cls.confidence, min(0.85, float(ans["confidence"])))
            except Exception as exc:  # optional
                self.vision_log.append({"page": pd.index, "task": "classify", "error": str(exc)})
        return cls

    def _vision_budget(self) -> bool:
        if not self.vision.available() or self.vision_calls >= self.config.max_vision_calls:
            return False
        self.vision_calls += 1
        return True

    def _thumb(self, doc, pd: PageData) -> bytes:
        s = 1600.0 / max(pd.width, pd.height)
        return png_bytes(doc.render(pd.page_in_document, s))

    def apply_scales(self, pd: PageData, views: list[View]) -> None:
        manual = self.config.manual_scales.get(pd.index)
        if not manual:
            return
        for v in views:
            if v.view_type in ("notes", "cover") or v.view_type in SCHEDULE_TYPES:
                continue
            det = v.scale
            v.scale = ScaleInfo(
                text=manual.get("text") or format_ratio(float(manual["ratio"])),
                ratio=float(manual["ratio"]),
                source="manual",
                confidence=1.0,
                bbox=det.bbox,
                notes=[f"Detected: {det.text}" if det.text else "No scale detected"],
            )

    def calibrate(self, pd: PageData, views: list[View], dims: list[DimensionAnnotation]) -> None:
        """Check / derive each view's scale from its dimension lines."""
        for v in views:
            vd = [d for d in dims if d.view_id == v.id]
            cal = calibrate_from_dimensions(vd, pd.mm_per_unit)
            if cal is None:
                continue
            ratio, n, agreement = cal
            if v.scale.source == "manual":
                continue
            if v.scale.ratio is None and not v.scale.not_to_scale:
                v.scale = ScaleInfo(format_ratio(ratio, imperial=abs(ratio - round(ratio)) > 0 or ratio in (48, 96, 64, 24, 32, 16, 192, 128)), ratio, "calibrated", min(0.85, 0.5 + 0.05 * n), None, notes=[f"No scale notation found; derived from {n} dimension lines"])
            elif v.scale.ratio is not None and abs(v.scale.ratio - ratio) / ratio > 0.02 and agreement > 0.6:
                v.scale.notes.append(f"Stated {v.scale.text} but {n} dimension lines indicate {format_ratio(ratio)}; using {format_ratio(ratio)}")
                v.scale = ScaleInfo(format_ratio(ratio), ratio, "calibrated", 0.8, v.scale.bbox, notes=v.scale.notes)
            elif v.scale.ratio is not None:
                v.scale.confidence = min(0.99, v.scale.confidence + 0.08)
                v.scale.notes.append(f"Verified against {n} dimension lines")
            for d in vd:
                d.scale_check = scale_check(d, v.scale.ratio, pd.mm_per_unit)

    def process_page(self, doc, i: int, index: int, document_index: int) -> PageResult:
        t = {}
        t0 = time.perf_counter()
        pd = self.analyze_page(doc, i, index, document_index)
        t["analyze"] = time.perf_counter() - t0
        t0 = time.perf_counter()
        cls = self.classify(doc, pd)
        t["classify"] = time.perf_counter() - t0
        t0 = time.perf_counter()
        from .views import segment_views

        views = segment_views(pd, cls)
        self.apply_scales(pd, views)
        t["views"] = time.perf_counter() - t0

        def ctx_for(v: View) -> DetectionContext:
            return DetectionContext(pd, v)

        t0 = time.perf_counter()
        tags = detect_tags(pd, views, cls.title_block, DRAWING_VIEWS)
        symbols = symbol_segment_ids(pd, tags)
        t["tags"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        dims, used = LinearDimensionDetector(exclude=symbols).detect(pd, views, cls, ctx_for)
        self.calibrate(pd, views, dims)
        t["dimensions"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        # annotation graphics (dimensions, tag symbols) are not building geometry
        used = used | symbols
        detections: list[OpeningDetection] = []
        orphans: list[TagDetection] = []
        for v in views:
            ctx = ctx_for(v)
            vt = [tg for tg in tags if tg.view_id == v.id]
            if v.view_type in ("floor_plan", "detail"):
                dets = PlanOpeningDetector(used).detect(pd, v, vt, ctx)
            elif v.view_type == "elevation":
                dets = ElevationOpeningDetector(used).detect(pd, v, vt, ctx)
            else:
                dets = []
            left = assign_tags(dets, vt, ctx)
            if ctx.raster:
                # scanned geometry is noisy: an untagged empty gap is not reliable evidence,
                # and everything found on a raster page is marked for verification
                dets = [d for d in dets if not (d.kind == "opening" and d.tag is None)]
                for d in dets:
                    d.confidence = round(d.confidence * 0.8, 3)
                    d.evidence.append(
                        evidence("raster", "Detected on a raster image (OCR + line detection) - verify against the drawing", None, page_index=d.page_index, bbox=d.bbox)
                    )
            orphans += left
            detections += dets
        t["openings"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        for v in views:
            vd = [d for d in detections if d.view_id == v.id]
            if not vd:
                continue
            ctx = ctx_for(v)

            def crop(box: BBox, _doc=doc, _pd=pd) -> bytes:
                s = min(4.0, 1400.0 / max(box.w, box.h, 1.0))
                return png_bytes(_doc.render(_pd.page_in_document, s, clip=box))

            vision = self.vision if self.vision.available() and self.vision_calls < self.config.max_vision_calls else None
            before = len(self.vision_log)
            self.vision_log += associate_dimensions(vd, dims, v, ctx, vision, crop)
            self.vision_calls += len(self.vision_log) - before
        t["associate"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        schedules: list[ScheduleEntry] = []
        if cls.page_type in SCHEDULE_TYPES or set(cls.secondary_types) & SCHEDULE_TYPES or any(v.view_type in SCHEDULE_TYPES for v in views):
            schedules = extract_schedules(pd, views, cls)
        t["schedules"] = time.perf_counter() - t0
        return PageResult(pd, cls, views, dims, tags, detections, orphans, schedules, t)

    # -- whole set -------------------------------------------------------------

    def run(self, docs: list[InputDocument], progress: ProgressFn | None = None) -> ExtractionResult:
        progress = progress or (lambda step, frac, msg: None)
        stages: list[dict[str, Any]] = []
        opened = []
        total_pages = 0
        for d in docs:
            doc = open_document(d.data, d.filename)
            opened.append((d, doc))
            total_pages += doc.page_count
        results: list[PageResult] = []
        index = 0
        t_start = time.perf_counter()
        try:
            for d, doc in opened:
                for i in range(doc.page_count):
                    progress("analyzed", index / max(total_pages, 1), f"Analyzing page {index + 1} of {total_pages}")
                    try:
                        results.append(self.process_page(doc, i, index, d.index))
                    except Exception as exc:  # one bad page must not sink the set
                        log.exception("page %s failed", index)
                        self.warnings.append(f"{d.filename} page {i + 1}: analysis failed ({exc})")
                    index += 1
        finally:
            for _, doc in opened:
                doc.close()
        stages.append({"name": "per_page", "seconds": round(time.perf_counter() - t_start, 3)})
        progress("classified", 1.0, "Pages classified")
        progress("dimensions", 1.0, f"{sum(len(r.dims) for r in results)} dimensions found")
        progress("openings", 1.0, f"{sum(len(r.detections) for r in results)} opening appearances found")
        progress("associated", 1.0, "Dimensions associated")

        t0 = time.perf_counter()
        progress("schedules", 0.5, "Cross-checking schedules")
        records = self.cross_reference(results)
        stages.append({"name": "crossref", "seconds": round(time.perf_counter() - t0, 3)})
        progress("crossref", 1.0, f"{len(records)} opening types")
        progress("scored", 1.0, "Confidence scored")
        return ExtractionResult(
            pages=results,
            records=records,
            version=EXTRACTION_VERSION,
            models={
                "ocr": getattr(self.ocr, "name", "none"),
                "vision_provider": getattr(self.vision, "name", "none"),
                "vision_model": getattr(self.vision, "model", None),
                "vision_calls": self.vision_calls,
            },
            stages=stages,
            vision_log=self.vision_log,
            warnings=self.warnings,
        )

    def cross_reference(self, results: list[PageResult]) -> list[dict[str, Any]]:
        pages: dict[int, PageContext] = {}
        dims: dict[str, DimensionAnnotation] = {}
        detections: list[OpeningDetection] = []
        orphans: list[tuple[TagDetection, str]] = []
        schedules: list[ScheduleEntry] = []
        for r in results:
            pages[r.page.index] = PageContext(
                index=r.page.index,
                page_type=r.cls.page_type,
                sheet_number=r.cls.sheet_number,
                sheet_title=r.cls.sheet_title,
                floor=r.cls.floor,
                views={v.id: v for v in r.views},
                poor_quality=r.page.quality.poor,
                quality_reasons=r.page.quality.reasons,
                label=r.page.label,
            )
            for d in r.dims:
                dims[d.id] = d
            detections += r.detections
            for t in r.orphan_tags:
                v = pages[r.page.index].views.get(t.view_id or "")
                orphans.append((t, v.view_type if v else r.cls.page_type))
            schedules += r.schedules
        return build_records(pages, detections, orphans, dims, schedules, self.config.thresholds)


def run_on_bytes(files: list[tuple[str, bytes]], ocr=None, vision=None, config=None, progress=None) -> ExtractionResult:
    docs = [InputDocument(i, name, data) for i, (name, data) in enumerate(files)]
    return ExtractionPipeline(ocr, vision, config).run(docs, progress)
