"""Core data structures shared by all pipeline stages.

Coordinate system
-----------------
Every page has its own coordinate space measured in *page units*, with the
origin at the top-left corner of the page as displayed (after rotation) and
the y axis pointing down:

* vector PDF pages use PDF points (1/72 inch of paper)
* raster images use pixels

``PageData.mm_per_unit`` converts page units to millimetres *on paper*
(when known), which together with the drawing scale converts to real-world
millimetres.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Literal

Axis = Literal["h", "v"]


# ---------------------------------------------------------------------------
# Geometry primitives
# ---------------------------------------------------------------------------


@dataclass
class BBox:
    x: float
    y: float
    w: float
    h: float

    @classmethod
    def from_points(cls, x0: float, y0: float, x1: float, y1: float) -> "BBox":
        return cls(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))

    @classmethod
    def around(cls, pts: Iterable[tuple[float, float]]) -> "BBox":
        pts = list(pts)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return cls.from_points(min(xs), min(ys), max(xs), max(ys))

    @property
    def x0(self) -> float:
        return self.x

    @property
    def y0(self) -> float:
        return self.y

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def y1(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def area(self) -> float:
        return max(self.w, 0.0) * max(self.h, 0.0)

    def union(self, other: "BBox") -> "BBox":
        return BBox.from_points(
            min(self.x0, other.x0), min(self.y0, other.y0), max(self.x1, other.x1), max(self.y1, other.y1)
        )

    def intersection_area(self, other: "BBox") -> float:
        ix = min(self.x1, other.x1) - max(self.x0, other.x0)
        iy = min(self.y1, other.y1) - max(self.y0, other.y0)
        if ix <= 0 or iy <= 0:
            return 0.0
        return ix * iy

    def iou(self, other: "BBox") -> float:
        inter = self.intersection_area(other)
        if inter <= 0:
            return 0.0
        return inter / (self.area + other.area - inter)

    def contains_point(self, x: float, y: float, tol: float = 0.0) -> bool:
        return self.x0 - tol <= x <= self.x1 + tol and self.y0 - tol <= y <= self.y1 + tol

    def contains(self, other: "BBox", tol: float = 0.0) -> bool:
        return (
            other.x0 >= self.x0 - tol
            and other.y0 >= self.y0 - tol
            and other.x1 <= self.x1 + tol
            and other.y1 <= self.y1 + tol
        )

    def expand(self, d: float) -> "BBox":
        return BBox(self.x - d, self.y - d, self.w + 2 * d, self.h + 2 * d)

    def distance_to(self, other: "BBox") -> float:
        dx = max(other.x0 - self.x1, self.x0 - other.x1, 0.0)
        dy = max(other.y0 - self.y1, self.y0 - other.y1, 0.0)
        return math.hypot(dx, dy)

    def distance_to_point(self, x: float, y: float) -> float:
        dx = max(self.x0 - x, 0.0, x - self.x1)
        dy = max(self.y0 - y, 0.0, y - self.y1)
        return math.hypot(dx, dy)

    def to_dict(self, nd: int = 2) -> dict[str, float]:
        return {"x": round(self.x, nd), "y": round(self.y, nd), "width": round(self.w, nd), "height": round(self.h, nd)}

    @classmethod
    def from_dict(cls, d: dict[str, float]) -> "BBox":
        return cls(d["x"], d["y"], d["width"], d["height"])


@dataclass
class Segment:
    x0: float
    y0: float
    x1: float
    y1: float
    width: float = 0.0
    dashed: bool = False
    path_id: int = -1

    @property
    def length(self) -> float:
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)

    @property
    def angle(self) -> float:
        """Undirected angle in degrees in [0, 180)."""
        a = math.degrees(math.atan2(-(self.y1 - self.y0), self.x1 - self.x0))
        return a % 180.0

    def orientation(self, tol_deg: float = 2.0) -> Axis | None:
        a = self.angle
        if a <= tol_deg or a >= 180 - tol_deg:
            return "h"
        if abs(a - 90) <= tol_deg:
            return "v"
        return None

    @property
    def mid(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)

    @property
    def bbox(self) -> BBox:
        return BBox.from_points(self.x0, self.y0, self.x1, self.y1)

    def axis_range(self, axis: Axis) -> tuple[float, float]:
        if axis == "h":
            return (min(self.x0, self.x1), max(self.x0, self.x1))
        return (min(self.y0, self.y1), max(self.y0, self.y1))

    def cross_coord(self, axis: Axis) -> float:
        """Coordinate perpendicular to ``axis`` (y for horizontal lines)."""
        if axis == "h":
            return (self.y0 + self.y1) / 2
        return (self.x0 + self.x1) / 2

    def endpoints(self) -> tuple[tuple[float, float], tuple[float, float]]:
        return (self.x0, self.y0), (self.x1, self.y1)

    def distance_to_point(self, px: float, py: float) -> float:
        dx, dy = self.x1 - self.x0, self.y1 - self.y0
        l2 = dx * dx + dy * dy
        if l2 == 0:
            return math.hypot(px - self.x0, py - self.y0)
        t = max(0.0, min(1.0, ((px - self.x0) * dx + (py - self.y0) * dy) / l2))
        return math.hypot(px - (self.x0 + t * dx), py - (self.y0 + t * dy))

    def to_dict(self) -> dict[str, float]:
        return {"x0": round(self.x0, 2), "y0": round(self.y0, 2), "x1": round(self.x1, 2), "y1": round(self.y1, 2)}


@dataclass
class Arc:
    cx: float
    cy: float
    r: float
    start: tuple[float, float]
    end: tuple[float, float]
    sweep_deg: float
    path_id: int = -1

    @property
    def bbox(self) -> BBox:
        # bounding box of the quarter/partial circle, approximated by sampling
        a0 = math.atan2(self.start[1] - self.cy, self.start[0] - self.cx)
        a1 = math.atan2(self.end[1] - self.cy, self.end[0] - self.cx)
        d = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        pts = [(self.cx + self.r * math.cos(a0 + d * t / 8), self.cy + self.r * math.sin(a0 + d * t / 8)) for t in range(9)]
        return BBox.around(pts)


@dataclass
class FilledShape:
    points: list[tuple[float, float]]
    kind: str  # "triangle" | "dot" | "other"

    @property
    def bbox(self) -> BBox:
        return BBox.around(self.points)

    @property
    def center(self) -> tuple[float, float]:
        b = self.bbox
        return (b.cx, b.cy)


@dataclass
class PageGeometry:
    segments: list[Segment] = field(default_factory=list)
    arcs: list[Arc] = field(default_factory=list)
    fills: list[FilledShape] = field(default_factory=list)
    rects: list[BBox] = field(default_factory=list)
    circles: list[tuple[float, float, float]] = field(default_factory=list)  # (cx, cy, r) closed circles
    polygons: list[list[tuple[float, float]]] = field(default_factory=list)  # closed outlines (tag shapes)


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------


@dataclass
class TextLine:
    id: str
    text: str
    bbox: BBox
    char_boxes: list[BBox]
    angle: float  # reading direction, degrees counter-clockwise from +x (visual)
    size: float  # text height in page units
    source: str = "pdf"  # "pdf" | "ocr"
    confidence: float = 1.0

    def sub_bbox(self, start: int, end: int) -> BBox:
        boxes = [b for b in self.char_boxes[start:end] if b.w > 0 or b.h > 0]
        if not boxes:
            return self.bbox
        out = boxes[0]
        for b in boxes[1:]:
            out = out.union(b)
        return out

    @property
    def axis(self) -> Axis | None:
        a = self.angle % 180
        if a < 10 or a > 170:
            return "h"
        if abs(a - 90) < 10:
            return "v"
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "bbox": self.bbox.to_dict(),
            "angle": round(self.angle, 1),
            "size": round(self.size, 2),
            "source": self.source,
            "confidence": round(self.confidence, 3),
        }


@dataclass
class TextSpan:
    """A matched sub-string of a text line (a tag, a dimension, ...)."""

    line_id: str
    start: int
    end: int
    text: str
    bbox: BBox
    angle: float
    size: float
    confidence: float
    source: str


# ---------------------------------------------------------------------------
# Page level
# ---------------------------------------------------------------------------


@dataclass
class PageQuality:
    kind: str  # "vector" | "raster"
    effective_dpi: float | None = None
    blur_score: float | None = None
    contrast: float | None = None
    mean_ocr_confidence: float | None = None
    poor: bool = False
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PageData:
    index: int  # 0-based index within the analysed set
    document_index: int
    page_in_document: int  # 0-based
    width: float
    height: float
    unit: str  # "pt" | "px"
    mm_per_unit: float | None  # paper millimetres per page unit, if known
    rotation: int
    lines: list[TextLine] = field(default_factory=list)
    geometry: PageGeometry = field(default_factory=PageGeometry)
    quality: PageQuality = field(default_factory=lambda: PageQuality(kind="vector"))
    has_text_layer: bool = True
    label: str = ""  # e.g. "Residential_Plans.pdf p.3"


@dataclass
class ScaleInfo:
    text: str | None  # original notation, e.g. "1:100" or '1/4" = 1\'-0"'
    ratio: float | None  # real length / paper length
    source: str  # "detected" | "calibrated" | "manual" | "none"
    confidence: float
    bbox: BBox | None = None
    not_to_scale: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "ratio": self.ratio,
            "source": self.source,
            "confidence": round(self.confidence, 3),
            "bbox": self.bbox.to_dict() if self.bbox else None,
            "not_to_scale": self.not_to_scale,
            "notes": self.notes,
        }


PAGE_TYPES = [
    "floor_plan",
    "elevation",
    "section",
    "door_schedule",
    "window_schedule",
    "opening_schedule",
    "detail",
    "site_plan",
    "cover",
    "notes",
    "other",
]

PAGE_TYPE_LABELS = {
    "floor_plan": "Floor plan",
    "elevation": "Elevation",
    "section": "Section",
    "door_schedule": "Door schedule",
    "window_schedule": "Window schedule",
    "opening_schedule": "Opening schedule",
    "detail": "Detail",
    "site_plan": "Site plan",
    "cover": "Cover page",
    "notes": "Notes/specifications",
    "other": "Other",
}

SCHEDULE_TYPES = {"door_schedule", "window_schedule", "opening_schedule"}


@dataclass
class View:
    """A drawing view on a sheet (e.g. one elevation on a sheet of four)."""

    id: str
    bbox: BBox
    view_type: str  # one of PAGE_TYPES
    title: str | None
    title_bbox: BBox | None
    scale: ScaleInfo
    enlarged: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bbox": self.bbox.to_dict(),
            "view_type": self.view_type,
            "title": self.title,
            "title_bbox": self.title_bbox.to_dict() if self.title_bbox else None,
            "scale": self.scale.to_dict(),
            "enlarged": self.enlarged,
        }


@dataclass
class PageClassification:
    page_type: str
    confidence: float
    signals: list[dict[str, Any]]
    secondary_types: list[str]
    sheet_number: str | None
    sheet_title: str | None
    floor: str | None
    title_block: BBox | None = None
    default_unit: str = "mm"
    unit_basis: str = "assumed"  # "note" | "scale" | "assumed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_type": self.page_type,
            "confidence": round(self.confidence, 3),
            "signals": self.signals,
            "secondary_types": self.secondary_types,
            "sheet_number": self.sheet_number,
            "sheet_title": self.sheet_title,
            "floor": self.floor,
            "title_block": self.title_block.to_dict() if self.title_block else None,
            "default_unit": self.default_unit,
            "unit_basis": self.unit_basis,
        }


# ---------------------------------------------------------------------------
# Detections
# ---------------------------------------------------------------------------


@dataclass
class TagDetection:
    id: str
    page_index: int
    text: str  # as written, e.g. "W-03"
    key: str  # normalised, e.g. "W3"
    prefix: str
    bbox: BBox
    confidence: float
    enclosure: str | None  # "circle" | "polygon" | "rect" | None
    line_id: str
    view_id: str | None = None
    enclosure_bbox: BBox | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page_index": self.page_index,
            "text": self.text,
            "key": self.key,
            "prefix": self.prefix,
            "bbox": self.bbox.to_dict(),
            "confidence": round(self.confidence, 3),
            "enclosure": self.enclosure,
            "view_id": self.view_id,
        }


@dataclass
class DimensionAnnotation:
    id: str
    page_index: int
    text: str  # original text exactly as detected
    value_mm: float
    unit: str
    unit_explicit: bool
    unit_basis: str  # "explicit" | "note" | "scale" | "assumed"
    text_bbox: BBox
    text_angle: float
    kind: str  # "linear" | "callout"
    confidence: float
    source: str  # "pdf" | "ocr"
    axis: Axis | None = None
    span: tuple[float, float] | None = None
    line_pos: float | None = None  # perpendicular coordinate of the dimension line
    line: Segment | None = None
    terminators: list[dict[str, Any]] = field(default_factory=list)
    extension_lines: list[Segment] = field(default_factory=list)
    chain_id: str | None = None
    chain_size: int = 1
    scale_check: dict[str, Any] | None = None
    view_id: str | None = None
    # for callout pairs "1200 x 1500"
    pair_role: str | None = None  # "width" | "height"
    pair_id: str | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page_index": self.page_index,
            "text": self.text,
            "value_mm": round(self.value_mm, 2),
            "unit": self.unit,
            "unit_explicit": self.unit_explicit,
            "unit_basis": self.unit_basis,
            "text_bbox": self.text_bbox.to_dict(),
            "text_angle": round(self.text_angle, 1),
            "kind": self.kind,
            "confidence": round(self.confidence, 3),
            "source": self.source,
            "axis": self.axis,
            "span": [round(self.span[0], 2), round(self.span[1], 2)] if self.span else None,
            "line_pos": round(self.line_pos, 2) if self.line_pos is not None else None,
            "line": self.line.to_dict() if self.line else None,
            "terminators": self.terminators,
            "extension_lines": [s.to_dict() for s in self.extension_lines],
            "chain_id": self.chain_id,
            "chain_size": self.chain_size,
            "scale_check": self.scale_check,
            "view_id": self.view_id,
            "pair_role": self.pair_role,
            "pair_id": self.pair_id,
            "notes": self.notes,
        }


OPENING_TYPES = [
    "door",
    "double_door",
    "sliding_door",
    "window",
    "sliding_window",
    "garage_door",
    "curtain_wall",
    "opening",
    "other",
]

OPENING_TYPE_LABELS = {
    "door": "Door",
    "double_door": "Double door",
    "sliding_door": "Sliding door",
    "window": "Window",
    "sliding_window": "Sliding window",
    "garage_door": "Garage door",
    "curtain_wall": "Curtain wall",
    "opening": "Opening",
    "other": "Other",
}


@dataclass
class Association:
    dimension_id: str
    role: str  # "width" | "height"
    score: float
    signals: list[dict[str, Any]]
    shared_with: list[str] = field(default_factory=list)  # other opening ids sharing a level dimension


@dataclass
class OpeningDetection:
    id: str
    page_index: int
    view_id: str | None
    view_type: str
    kind: str
    bbox: BBox
    axis: Axis  # axis along which the width is measured
    edges: tuple[float, float]  # width edges along ``axis``
    cross: tuple[float, float]  # extent perpendicular to ``axis`` (wall faces / top-bottom)
    detector: str
    confidence: float
    evidence: list[dict[str, Any]] = field(default_factory=list)
    features: dict[str, Any] = field(default_factory=dict)
    tag: TagDetection | None = None
    tag_score: float = 0.0
    tag_evidence: list[dict[str, Any]] = field(default_factory=list)
    width_assoc: Association | None = None
    height_assoc: Association | None = None
    candidate_assocs: list[Association] = field(default_factory=list)
    room: str | None = None
    kind_votes: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page_index": self.page_index,
            "view_id": self.view_id,
            "view_type": self.view_type,
            "kind": self.kind,
            "bbox": self.bbox.to_dict(),
            "axis": self.axis,
            "edges": [round(self.edges[0], 2), round(self.edges[1], 2)],
            "cross": [round(self.cross[0], 2), round(self.cross[1], 2)],
            "detector": self.detector,
            "confidence": round(self.confidence, 3),
            "evidence": self.evidence,
            "features": self.features,
            "tag": self.tag.to_dict() if self.tag else None,
            "tag_score": round(self.tag_score, 3),
            "room": self.room,
            "width_assoc": _assoc_dict(self.width_assoc),
            "height_assoc": _assoc_dict(self.height_assoc),
        }


def _assoc_dict(a: Association | None) -> dict[str, Any] | None:
    if a is None:
        return None
    return {
        "dimension_id": a.dimension_id,
        "role": a.role,
        "score": round(a.score, 3),
        "signals": a.signals,
        "shared_with": a.shared_with,
    }


@dataclass
class ScheduleEntry:
    id: str
    page_index: int
    schedule_kind: str  # "door" | "window" | "opening"
    schedule_title: str
    tag: str
    tag_key: str
    type_text: str | None
    width: dict[str, Any] | None  # parsed measurement {value_mm, unit, original_text}
    height: dict[str, Any] | None
    quantity: int | None
    quantity_text: str | None
    remarks: str | None
    row_bbox: BBox
    cells: dict[str, str]
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page_index": self.page_index,
            "schedule_kind": self.schedule_kind,
            "schedule_title": self.schedule_title,
            "tag": self.tag,
            "tag_key": self.tag_key,
            "type_text": self.type_text,
            "width": self.width,
            "height": self.height,
            "quantity": self.quantity,
            "quantity_text": self.quantity_text,
            "remarks": self.remarks,
            "row_bbox": self.row_bbox.to_dict(),
            "cells": self.cells,
            "confidence": round(self.confidence, 3),
        }


def evidence(
    code: str,
    label: str,
    passed: bool | None,
    *,
    detail: str | None = None,
    score: float | None = None,
    page_index: int | None = None,
    bbox: BBox | None = None,
    target: str | None = None,
) -> dict[str, Any]:
    """Build one evidence item. ``passed`` is None for neutral/informational items."""
    return {
        "code": code,
        "label": label,
        "passed": passed,
        "detail": detail,
        "score": round(score, 3) if score is not None else None,
        "page_index": page_index,
        "bbox": bbox.to_dict() if bbox else None,
        "target": target,
    }
