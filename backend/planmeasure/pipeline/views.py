"""Split a sheet into drawing views (a sheet often holds several elevations,
or a plan plus a schedule) and determine each view's type and scale."""

from __future__ import annotations

import re

import numpy as np

from .classify import classify_type_from_text, find_view_titles
from .scale import find_scale_mentions, no_scale
from .types import BBox, PageClassification, PageData, ScaleInfo, SCHEDULE_TYPES, TextLine, View

RE_ENLARGED = re.compile(r"\bENLARGED|\bPART\s+PLAN|\bDETAIL", re.I)
RE_AS_SHOWN = re.compile(r"\bAS\s+(SHOWN|NOTED|INDICATED)\b", re.I)


def _frame_segments(page: PageData):
    out = set()
    for i, s in enumerate(page.geometry.segments):
        o = s.orientation()
        if o == "h" and s.length > 0.7 * page.width:
            out.add(i)
        elif o == "v" and s.length > 0.7 * page.height:
            out.add(i)
    return out


def sheet_scale(page: PageData, cls: PageClassification) -> tuple[ScaleInfo, list[dict]]:
    mentions = find_scale_mentions(page.lines)
    tb = cls.title_block
    in_tb = [m for m in mentions if tb is not None and tb.contains(m["bbox"], tol=2)]
    info = no_scale()
    for m in in_tb:
        if m["ratio"]:
            info = ScaleInfo(m["text"], m["ratio"], "detected", 0.9 if m["labelled"] else 0.75, m["bbox"])
            break
        if m["nts"]:
            info = ScaleInfo(m["text"], None, "detected", 0.9, m["bbox"], not_to_scale=True)
    if tb is not None and info.ratio is None and not info.not_to_scale:
        for ln in page.lines:
            if tb.contains(ln.bbox, tol=2) and RE_AS_SHOWN.search(ln.text):
                info.notes.append("Title block scale: AS SHOWN (per view)")
    return info, mentions


def segment_views(page: PageData, cls: PageClassification) -> list[View]:
    import cv2

    tb = cls.title_block
    sheet_info, mentions = sheet_scale(page, cls)
    cell = max(page.width, page.height) / 200.0
    gw, gh = int(page.width / cell) + 2, int(page.height / cell) + 2
    grid = np.zeros((gh, gw), dtype=np.uint8)
    frame = _frame_segments(page)

    def excluded(b: BBox) -> bool:
        return tb is not None and tb.expand(2).contains(b)

    for i, s in enumerate(page.geometry.segments):
        if i in frame or excluded(s.bbox):
            continue
        cv2.line(grid, (int(s.x0 / cell), int(s.y0 / cell)), (int(s.x1 / cell), int(s.y1 / cell)), 255, 1)
    for a in page.geometry.arcs:
        b = a.bbox
        if not excluded(b):
            cv2.rectangle(grid, (int(b.x0 / cell), int(b.y0 / cell)), (int(b.x1 / cell), int(b.y1 / cell)), 255, -1)
    for cx, cy, r in page.geometry.circles:
        if not excluded(BBox(cx - r, cy - r, 2 * r, 2 * r)):
            cv2.circle(grid, (int(cx / cell), int(cy / cell)), max(int(r / cell), 1), 255, 1)
    for ln in page.lines:
        if excluded(ln.bbox):
            continue
        b = ln.bbox
        cv2.rectangle(grid, (int(b.x0 / cell), int(b.y0 / cell)), (int(b.x1 / cell), int(b.y1 / cell)), 255, -1)
    grid = cv2.dilate(grid, np.ones((3, 3), np.uint8), iterations=2)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grid, connectivity=8)
    regions: list[BBox] = []
    for k in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[k])
        # undo dilation margin (2 cells)
        bb = BBox(float((x + 2) * cell), float((y + 2) * cell), float(max(w - 4, 1) * cell), float(max(h - 4, 1) * cell))
        regions.append(bb)

    titles = find_view_titles(page, tb)
    # region membership
    title_region: dict[int, int] = {}
    for ti, t in enumerate(titles):
        typ = classify_type_from_text(t.text) or "other"
        best, best_d = None, None
        for ri, r in enumerate(regions):
            if r.contains(t.bbox, tol=cell) and r.area > 4 * t.bbox.area * 4:
                # a real drawing region containing the title (e.g. table with title inside)
                d = 0.0
            elif typ in SCHEDULE_TYPES:
                # schedule titles sit above their table
                if r.y0 < t.bbox.y1 - cell or r.y0 - t.bbox.y1 > 0.08 * page.height:
                    continue
                if min(r.x1, t.bbox.x1 + page.width * 0.3) < max(r.x0, t.bbox.x0 - cell):
                    continue
                d = r.y0 - t.bbox.y1
            else:
                # drawing views sit above their title
                if r.y1 > t.bbox.y0 + cell or t.bbox.y0 - r.y1 > 0.12 * page.height:
                    continue
                if min(r.x1, t.bbox.x1) < max(r.x0, t.bbox.x0) - 0.1 * page.width:
                    continue
                d = t.bbox.y0 - r.y1
            if r.area < 2 * t.bbox.area * 4:
                continue  # the title's own little component
            if best_d is None or d < best_d:
                best, best_d = ri, d
        if best is not None:
            title_region[ti] = best

    views: list[View] = []
    used_regions = set()
    for ti, ri in title_region.items():
        if ri in used_regions:
            # two titles for one region: keep the closer / first
            continue
        used_regions.add(ri)
        t = titles[ti]
        typ = classify_type_from_text(t.text) or cls.page_type
        if typ == "floor_plan" and cls.page_type == "detail":
            typ = "detail"
        vb = regions[ri].union(t.bbox)
        scale = _view_scale(t, mentions, sheet_info, page)
        views.append(
            View(
                id=f"p{page.index}-v{len(views)}",
                bbox=vb,
                view_type=typ,
                title=t.text.strip(),
                title_bbox=t.bbox,
                scale=scale,
                enlarged=bool(RE_ENLARGED.search(t.text)),
            )
        )
    # untitled regions: attach to the page type if they carry drawing geometry
    title_boxes = [t.bbox for t in titles]
    for ri, r in enumerate(regions):
        if ri in used_regions:
            continue
        if any(r.contains(tb_, tol=cell) for tb_ in title_boxes) and r.area < 6 * max(tb_.area for tb_ in title_boxes):
            continue  # just a title / scale caption
        if r.w < 3 * cell and r.h < 3 * cell:
            continue
        segs = sum(1 for s in page.geometry.segments if r.contains(s.bbox, tol=cell))
        texts = [ln for ln in page.lines if r.contains(ln.bbox, tol=cell)]
        if segs < 6 and texts:
            vtype = "notes"
        else:
            vtype = cls.page_type
        # fold into an existing titled view it overlaps
        merged = False
        for v in views:
            if v.bbox.intersection_area(r) > 0.5 * r.area:
                v.bbox = v.bbox.union(r)
                merged = True
                break
        if merged:
            continue
        views.append(
            View(
                id=f"p{page.index}-v{len(views)}",
                bbox=r,
                view_type=vtype,
                title=None,
                title_bbox=None,
                scale=sheet_info if vtype not in ("notes",) else no_scale(),
                enlarged=cls.page_type == "detail",
            )
        )
    if not views:
        views.append(
            View(
                id=f"p{page.index}-v0",
                bbox=BBox(0, 0, page.width, page.height),
                view_type=cls.page_type,
                title=cls.sheet_title,
                title_bbox=None,
                scale=sheet_info,
                enlarged=cls.page_type == "detail",
            )
        )
    return views


def _view_scale(title: TextLine, mentions: list[dict], sheet_info: ScaleInfo, page: PageData) -> ScaleInfo:
    """Scale written in / right under the view title, else the sheet scale."""
    best = None
    for m in mentions:
        b: BBox = m["bbox"]
        if m["line"] is title or (
            0 <= b.cy - title.bbox.cy < 4 * max(title.size, 1) and abs(b.x0 - title.bbox.x0) < 0.25 * page.width
        ) or (abs(b.cy - title.bbox.cy) < title.size and 0 <= b.x0 - title.bbox.x1 < 0.2 * page.width):
            d = abs(b.cy - title.bbox.cy) + abs(b.x0 - title.bbox.x0) * 0.1
            if best is None or d < best[0]:
                best = (d, m)
    if best is not None:
        m = best[1]
        return ScaleInfo(m["text"], m["ratio"], "detected", 0.92 if m["ratio"] else 0.8, m["bbox"], not_to_scale=m["nts"])
    return sheet_info


def view_for(views: list[View], b: BBox) -> View:
    cx, cy = b.cx, b.cy
    inside = [v for v in views if v.bbox.contains_point(cx, cy)]
    if inside:
        return min(inside, key=lambda v: v.bbox.area)
    return min(views, key=lambda v: v.bbox.distance_to(b))
