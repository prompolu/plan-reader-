"""Opening tag detection (D-01, W03, SD-1, GD-01, ...)."""

from __future__ import annotations

import math
import re

from .types import BBox, PageData, TagDetection, TextLine, View
from .units import normalize_chars

# prefix -> opening class hint
TAG_PREFIXES = {
    "D": "door",
    "DR": "door",
    "DD": "double_door",
    "ED": "door",
    "FD": "door",
    "SD": "sliding_door",
    "GD": "garage_door",
    "RD": "garage_door",  # roller door
    "W": "window",
    "WN": "window",
    "WD": "window",
    "WIN": "window",
    "SW": "sliding_window",
    "CW": "curtain_wall",
    "OP": "opening",
}
PREFIX_ALIASES = {"DR": "D", "WN": "W", "WD": "W", "WIN": "W"}

RE_TAG = re.compile(r"(?<![A-Za-z0-9])(?P<prefix>[A-Z]{1,3})[-.\s]?(?P<num>\d{1,3})(?P<suffix>[A-Z]?)(?![A-Za-z0-9])")


def tag_key(prefix: str, num: str, suffix: str = "") -> str:
    p = PREFIX_ALIASES.get(prefix.upper(), prefix.upper())
    return f"{p}{int(num)}{suffix.upper()}"


def parse_tag(text: str) -> tuple[str, str, str] | None:
    """Return (prefix, key, text) if ``text`` is exactly one tag."""
    t = normalize_chars(text).strip()
    m = RE_TAG.fullmatch(t)
    if not m or m.group("prefix") not in TAG_PREFIXES:
        return None
    return m.group("prefix"), tag_key(m.group("prefix"), m.group("num"), m.group("suffix")), t


def tag_class(prefix: str) -> str:
    return TAG_PREFIXES.get(prefix.upper(), "other")


def _enclosure(page: PageData, b: BBox) -> tuple[str, BBox] | None:
    """The tag symbol (circle / hexagon / diamond / box) drawn around tag text."""
    cx, cy = b.cx, b.cy
    half = max(b.w, b.h) / 2
    for (ex, ey, r) in page.geometry.circles:
        if math.hypot(ex - cx, ey - cy) < 0.35 * r + 1 and half * 0.8 <= r <= half * 3.5 + 2:
            return "circle", BBox(ex - r, ey - r, 2 * r, 2 * r)
    for poly in page.geometry.polygons:
        pb = BBox.around(poly)
        if pb.contains(b, tol=1.0) and pb.area < 12 * max(b.area, 1):
            return "polygon", pb
    for r in page.geometry.rects:
        if r.contains(b, tol=1.0) and r.area < 8 * max(b.area, 1):
            return "rect", r
    return None


def detect_tags(page: PageData, views: list[View], title_block: BBox | None, drawing_views: set[str]) -> list[TagDetection]:
    """Find tag tokens in drawing views (not in title blocks, notes or schedules)."""
    out: list[TagDetection] = []
    n = 0
    for ln in page.lines:
        if title_block is not None and title_block.contains(ln.bbox, tol=2):
            continue
        view = _view_of(views, ln.bbox)
        if view is None or view.view_type not in drawing_views:
            continue
        norm = normalize_chars(ln.text)
        for m in RE_TAG.finditer(norm):
            prefix = m.group("prefix")
            if prefix not in TAG_PREFIXES:
                continue
            # a tag token is short; long sentences mentioning "W1" are notes
            if len(norm.strip()) > 14 and not _stands_alone(norm, m):
                continue
            bb = ln.sub_bbox(m.start(), m.end())
            found = _enclosure(page, bb)
            enc, enc_box = (found if found else (None, None))
            conf = 0.97 if enc else 0.82
            if ln.source == "ocr":
                conf *= max(0.5, ln.confidence)
            text = ln.text[m.start() : m.end()]
            out.append(
                TagDetection(
                    id=f"p{page.index}-t{n}",
                    page_index=page.index,
                    text=text,
                    key=tag_key(prefix, m.group("num"), m.group("suffix")),
                    prefix=PREFIX_ALIASES.get(prefix, prefix),
                    bbox=bb,
                    confidence=conf,
                    enclosure=enc,
                    line_id=ln.id,
                    view_id=view.id,
                    enclosure_bbox=enc_box,
                )
            )
            n += 1
    return out


def _stands_alone(s: str, m: re.Match) -> bool:
    before = s[: m.start()].strip()
    after = s[m.end() :].strip()
    return len(before) <= 2 and len(after) <= 12


def _view_of(views: list[View], b: BBox) -> View | None:
    inside = [v for v in views if v.bbox.contains_point(b.cx, b.cy)]
    if inside:
        return min(inside, key=lambda v: v.bbox.area)
    near = [v for v in views if v.bbox.distance_to(b) < 20]
    return min(near, key=lambda v: v.bbox.distance_to(b)) if near else None


def is_tag_text(ln: TextLine) -> bool:
    return parse_tag(ln.text) is not None


def symbol_segment_ids(page: PageData, tags: list[TagDetection]) -> set[int]:
    """Segments that form tag symbols - annotation, not building geometry."""
    boxes = [t.enclosure_bbox.expand(0.5) for t in tags if t.enclosure_bbox is not None]
    if not boxes:
        return set()
    out = set()
    for s in page.geometry.segments:
        sb = s.bbox
        for b in boxes:
            if b.contains(sb):
                out.add(id(s))
                break
    return out
