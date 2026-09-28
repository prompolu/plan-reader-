"""Geometry extraction (vector PDF paths and raster line detection) and spatial indexing."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable

import numpy as np

from .types import Arc, BBox, FilledShape, PageGeometry, Segment

# ---------------------------------------------------------------------------
# Spatial index
# ---------------------------------------------------------------------------


class SegmentIndex:
    """Uniform grid index over segments for fast neighbourhood queries."""

    def __init__(self, segments: list[Segment], cell: float):
        self.segments = segments
        self.cell = max(cell, 1e-3)
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i, s in enumerate(segments):
            for key in self._cells(s.bbox):
                self.grid[key].append(i)

    def _cells(self, b: BBox) -> Iterable[tuple[int, int]]:
        c = self.cell
        x0, x1 = int(math.floor(b.x0 / c)), int(math.floor(b.x1 / c))
        y0, y1 = int(math.floor(b.y0 / c)), int(math.floor(b.y1 / c))
        # guard against pathological very long segments
        if (x1 - x0 + 1) * (y1 - y0 + 1) > 20000:
            x1 = min(x1, x0 + 140)
            y1 = min(y1, y0 + 140)
        for gx in range(x0, x1 + 1):
            for gy in range(y0, y1 + 1):
                yield (gx, gy)

    def query(self, b: BBox) -> list[Segment]:
        seen: set[int] = set()
        out = []
        for key in self._cells(b):
            for i in self.grid.get(key, ()):
                if i in seen:
                    continue
                seen.add(i)
                s = self.segments[i]
                sb = s.bbox
                if sb.x1 >= b.x0 and sb.x0 <= b.x1 and sb.y1 >= b.y0 and sb.y0 <= b.y1:
                    out.append(s)
        return out


# ---------------------------------------------------------------------------
# Vector extraction (PyMuPDF drawings)
# ---------------------------------------------------------------------------


def _pt(p, m) -> tuple[float, float]:
    q = p * m if m is not None else p
    return (float(q.x), float(q.y))


def _circle_from_3(p1, p2, p3):
    ax, ay = p1
    bx, by = p2
    cx, cy = p3
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def _bezier(p0, p1, p2, p3, t):
    mt = 1 - t
    x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
    y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
    return (x, y)


def _fit_curve_circle(ctrl) -> tuple[float, float, float, float] | None:
    """Fit a circle to a cubic Bezier. Returns (cx, cy, r, sweep_deg) or None."""
    p0, p1, p2, p3 = ctrl
    pts = [_bezier(p0, p1, p2, p3, t) for t in (0.0, 0.25, 0.5, 0.75, 1.0)]
    c = _circle_from_3(pts[0], pts[2], pts[4])
    if c is None:
        return None
    cx, cy, r = c
    if r <= 0:
        return None
    err = max(abs(math.hypot(x - cx, y - cy) - r) for x, y in pts)
    if err > max(0.02 * r, 0.05):
        return None
    a0 = math.atan2(pts[0][1] - cy, pts[0][0] - cx)
    am = math.atan2(pts[2][1] - cy, pts[2][0] - cx)
    a1 = math.atan2(pts[4][1] - cy, pts[4][0] - cx)
    d1 = (am - a0 + math.pi) % (2 * math.pi) - math.pi
    d2 = (a1 - am + math.pi) % (2 * math.pi) - math.pi
    return cx, cy, r, math.degrees(abs(d1 + d2))


def _is_dashed(dashes) -> bool:
    if not dashes:
        return False
    s = str(dashes).strip()
    return not (s.startswith("[]") or s == "" or s == "[] 0")


def extract_vector_geometry(drawings: list[dict], matrix=None) -> PageGeometry:
    """Convert PyMuPDF ``page.get_drawings()`` output into pipeline geometry.

    ``matrix`` maps unrotated page coordinates into displayed coordinates.
    """
    g = PageGeometry()
    for pid, path in enumerate(drawings):
        width = path.get("width") or 0.0
        dashed = _is_dashed(path.get("dashes"))
        fill = path.get("fill")
        items = path.get("items", [])
        curves: list[tuple] = []
        pts_chain: list[tuple[float, float]] = []
        path_segs: list[Segment] = []
        for it in items:
            op = it[0]
            if op == "l":
                a, b = _pt(it[1], matrix), _pt(it[2], matrix)
                if a != b:
                    path_segs.append(Segment(a[0], a[1], b[0], b[1], width, dashed, pid))
                if not pts_chain or pts_chain[-1] != a:
                    pts_chain.append(a)
                pts_chain.append(b)
            elif op == "re":
                r = it[1]
                corners = [_pt(r.tl, matrix), _pt(r.tr, matrix), _pt(r.br, matrix), _pt(r.bl, matrix)]
                bb = BBox.around(corners)
                if fill is not None and bb.w * bb.h < 4.0:
                    g.fills.append(FilledShape(corners, "dot"))
                    continue
                g.rects.append(bb)
                for i in range(4):
                    a, b = corners[i], corners[(i + 1) % 4]
                    g.segments.append(Segment(a[0], a[1], b[0], b[1], width, dashed, pid))
            elif op == "qu":
                q = it[1]
                corners = [_pt(q.ul, matrix), _pt(q.ur, matrix), _pt(q.lr, matrix), _pt(q.ll, matrix)]
                for i in range(4):
                    a, b = corners[i], corners[(i + 1) % 4]
                    if a != b:
                        g.segments.append(Segment(a[0], a[1], b[0], b[1], width, dashed, pid))
            elif op == "c":
                ctrl = tuple(_pt(p, matrix) for p in it[1:5])
                curves.append(ctrl)
        closed = bool(path.get("closePath"))
        is_arrowhead = False
        if pts_chain and len(pts_chain) >= 3 and (closed or pts_chain[0] == pts_chain[-1]):
            poly = pts_chain[:-1] if pts_chain[0] == pts_chain[-1] else pts_chain
            if closed and pts_chain[0] != pts_chain[-1]:
                a, b = pts_chain[-1], pts_chain[0]
                path_segs.append(Segment(a[0], a[1], b[0], b[1], width, dashed, pid))
            if fill is not None and len(poly) == 3:
                # filled triangles are dimension arrowheads: terminators, not lines
                g.fills.append(FilledShape(list(poly), "triangle"))
                is_arrowhead = BBox.around(poly).area < 400
            elif 4 <= len(poly) <= 12 and fill is None:
                g.polygons.append(list(poly))
        if not is_arrowhead:
            g.segments.extend(path_segs)
        if curves:
            _curves_to_arcs(curves, g, pid, fill is not None)
    return g


def _curves_to_arcs(curves, g: PageGeometry, pid: int, filled: bool) -> None:
    fits = [_fit_curve_circle(c) for c in curves]
    # group consecutive curves on the same circle
    groups: list[list[int]] = []
    for i, f in enumerate(fits):
        if f is None:
            groups.append([])
            continue
        if groups and groups[-1]:
            j = groups[-1][-1]
            fj = fits[j]
            if (
                fj is not None
                and math.hypot(f[0] - fj[0], f[1] - fj[1]) < 0.03 * f[2] + 0.05
                and abs(f[2] - fj[2]) < 0.03 * f[2] + 0.05
                and curves[j][3] == curves[i][0]
            ):
                groups[-1].append(i)
                continue
        groups.append([i])
    for grp in groups:
        if not grp:
            continue
        cx = sum(fits[i][0] for i in grp) / len(grp)
        cy = sum(fits[i][1] for i in grp) / len(grp)
        r = sum(fits[i][2] for i in grp) / len(grp)
        sweep = sum(fits[i][3] for i in grp)
        start = curves[grp[0]][0]
        end = curves[grp[-1]][3]
        if sweep >= 350:
            if filled and r < 3.0:
                g.fills.append(FilledShape([(cx - r, cy - r), (cx + r, cy + r)], "dot"))
            else:
                g.circles.append((cx, cy, r))
        else:
            g.arcs.append(Arc(cx, cy, r, start, end, sweep, pid))


# ---------------------------------------------------------------------------
# Raster extraction (scans / images)
# ---------------------------------------------------------------------------


def binarize(gray: np.ndarray) -> np.ndarray:
    """Ink mask. Drawings are dark ink on a light background; thin anti-aliased
    lines are light grey, so the Otsu threshold is raised to keep them."""
    import cv2

    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thr = min(max(otsu + 60, 170), 235)
    return np.where(gray < thr, 255, 0).astype(np.uint8)


def remove_long_lines(gray: np.ndarray, min_len: int) -> np.ndarray:
    """Erase long straight lines (walls, dimension lines, frames) so OCR sees isolated text."""
    import cv2

    bw = binarize(gray)
    mask = np.zeros_like(bw)
    for ksize in ((min_len, 1), (1, min_len)):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, ksize)
        mask |= cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel)
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
    out = gray.copy()
    out[mask > 0] = 255
    return out


def extract_raster_geometry(gray: np.ndarray, unit_per_px: float = 1.0, mask_boxes: list[BBox] | None = None) -> PageGeometry:
    """Detect line segments, arcs, arrowheads and circles in a raster drawing.

    ``mask_boxes`` (in output units) are blanked before line detection - used
    to remove OCR'd text so characters are not mistaken for short lines.
    """
    import cv2

    bw = binarize(gray)
    if mask_boxes:
        for b in mask_boxes:
            x0, y0 = int(b.x0 / unit_per_px) - 1, int(b.y0 / unit_per_px) - 1
            x1, y1 = int(b.x1 / unit_per_px) + 1, int(b.y1 / unit_per_px) + 1
            bw[max(y0, 0) : max(y1, 0), max(x0, 0) : max(x1, 0)] = 0
    g = PageGeometry()
    h, w = bw.shape
    min_len = max(8, int(min(h, w) * 0.004))

    # straight horizontal / vertical structure via morphology (robust to thick walls)
    segs: list[Segment] = []
    for axis, ksize in (("h", (min_len, 1)), ("v", (1, min_len))):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, ksize)
        lines = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(lines, connectivity=8)
        for i in range(1, n):
            x, y, ww, hh, area = stats[i]
            if axis == "h":
                if ww < min_len:
                    continue
                # thick bands (e.g. walls drawn solid) produce two edge lines
                if hh > 4:
                    segs.append(Segment(x, y, x + ww, y, float(1)))
                    segs.append(Segment(x, y + hh, x + ww, y + hh, float(1)))
                else:
                    cy = y + hh / 2
                    segs.append(Segment(x, cy, x + ww, cy, float(hh)))
            else:
                if hh < min_len:
                    continue
                if ww > 4:
                    segs.append(Segment(x, y, x, y + hh, float(1)))
                    segs.append(Segment(x + ww, y, x + ww, y + hh, float(1)))
                else:
                    cx = x + ww / 2
                    segs.append(Segment(cx, y, cx, y + hh, float(ww)))

    # oblique short segments (dimension ticks) via probabilistic Hough on the residual
    residual = bw.copy()
    for s in segs:
        cv2.line(residual, (int(s.x0), int(s.y0)), (int(s.x1), int(s.y1)), 0, thickness=max(3, int(s.width) + 2))
    hl = cv2.HoughLinesP(residual, 1, np.pi / 180, threshold=8, minLineLength=max(5, min_len // 2), maxLineGap=2)
    if hl is not None:
        for x0, y0, x1, y1 in np.asarray(hl).reshape(-1, 4):
            s = Segment(float(x0), float(y0), float(x1), float(y1), 1.0)
            if s.orientation(8) is None and s.length < min_len * 4:
                segs.append(s)

    # arcs and circles from the residual curve pixels
    arc_img = residual.copy()
    contours, _ = cv2.findContours(arc_img, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    for c in contours:
        if len(c) < 20:
            continue
        pts = c[:, 0, :].astype(np.float64)
        x, y, ww, hh = cv2.boundingRect(c)
        if max(ww, hh) < min_len:
            continue
        fit = _lsq_circle(pts)
        if fit is None:
            continue
        cx, cy, r, resid = fit
        if resid > max(1.5, 0.04 * r) or r < min_len * 0.7:
            continue
        ang = np.degrees(np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx))
        sweep = _angular_extent(ang)
        if sweep > 340:
            g.circles.append((cx * unit_per_px, cy * unit_per_px, r * unit_per_px))
        elif 60 <= sweep <= 120:
            a_sorted = _arc_endpoints(ang)
            p_start = (cx + r * math.cos(math.radians(a_sorted[0])), cy + r * math.sin(math.radians(a_sorted[0])))
            p_end = (cx + r * math.cos(math.radians(a_sorted[1])), cy + r * math.sin(math.radians(a_sorted[1])))
            g.arcs.append(
                Arc(
                    cx * unit_per_px,
                    cy * unit_per_px,
                    r * unit_per_px,
                    (p_start[0] * unit_per_px, p_start[1] * unit_per_px),
                    (p_end[0] * unit_per_px, p_end[1] * unit_per_px),
                    float(sweep),
                )
            )

    # small filled triangles (arrowheads)
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        area = cv2.contourArea(c)
        if area < 6 or area > (min_len * 1.5) ** 2:
            continue
        approx = cv2.approxPolyDP(c, 0.12 * cv2.arcLength(c, True), True)
        x, y, ww, hh = cv2.boundingRect(c)
        fill_ratio = area / max(ww * hh, 1)
        if len(approx) == 3 and fill_ratio > 0.3:
            g.fills.append(FilledShape([(float(p[0][0]) * unit_per_px, float(p[0][1]) * unit_per_px) for p in approx], "triangle"))

    merged = split_at_intersections(merge_collinear(segs, tol=1.5, gap=2.0), tol=2.5)
    g.segments = [
        Segment(s.x0 * unit_per_px, s.y0 * unit_per_px, s.x1 * unit_per_px, s.y1 * unit_per_px, s.width * unit_per_px)
        for s in merged
    ]
    return g


def split_at_intersections(segs: list[Segment], tol: float = 2.0) -> list[Segment]:
    """Split horizontal/vertical segments where perpendicular segments cross or meet them.

    In scans, strokes that touch (a jamb and the extension line below it, a wall
    face and a window sill line) come out as one line; splitting at junctions
    recovers the individual pieces (e.g. the jamb between two wall faces).
    """
    hs = [s for s in segs if s.orientation(1.0) == "h"]
    vs = [s for s in segs if s.orientation(1.0) == "v"]
    others = [s for s in segs if s.orientation(1.0) is None]
    if not hs or not vs:
        return segs
    cell = 64.0
    vidx = SegmentIndex(vs, cell)
    hidx = SegmentIndex(hs, cell)

    def cuts_for(s: Segment, axis: str, idx: SegmentIndex) -> list[float]:
        lo, hi = s.axis_range(axis)
        c = s.cross_coord(axis)
        box = BBox.from_points(lo, c - tol, hi, c + tol) if axis == "h" else BBox.from_points(c - tol, lo, c + tol, hi)
        out = []
        for p in idx.query(box):
            po = "v" if axis == "h" else "h"
            plo, phi = p.axis_range(po)
            if plo - tol <= c <= phi + tol:
                pos = p.cross_coord(po)
                if lo + tol < pos < hi - tol:
                    out.append(pos)
        return sorted(set(round(x, 1) for x in out))

    out: list[Segment] = list(others)
    for s in hs:
        cuts = cuts_for(s, "h", vidx)
        xs = [s.axis_range("h")[0]] + cuts + [s.axis_range("h")[1]]
        y = s.cross_coord("h")
        out += [Segment(a, y, b, y, s.width) for a, b in zip(xs, xs[1:]) if b - a > 0.5]
    for s in vs:
        cuts = cuts_for(s, "v", hidx)
        ys = [s.axis_range("v")[0]] + cuts + [s.axis_range("v")[1]]
        x = s.cross_coord("v")
        out += [Segment(x, a, x, b, s.width) for a, b in zip(ys, ys[1:]) if b - a > 0.5]
    return out


def _lsq_circle(pts: np.ndarray):
    x, y = pts[:, 0], pts[:, 1]
    A = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy = sol[0] / 2, sol[1] / 2
    r2 = sol[2] + cx * cx + cy * cy
    if r2 <= 0:
        return None
    r = math.sqrt(r2)
    resid = float(np.mean(np.abs(np.hypot(x - cx, y - cy) - r)))
    return float(cx), float(cy), r, resid


def _angular_extent(ang: np.ndarray) -> float:
    a = np.sort(np.mod(ang, 360))
    if len(a) < 2:
        return 0.0
    gaps = np.diff(np.concatenate([a, [a[0] + 360]]))
    return float(360 - gaps.max())


def _arc_endpoints(ang: np.ndarray) -> tuple[float, float]:
    a = np.sort(np.mod(ang, 360))
    gaps = np.diff(np.concatenate([a, [a[0] + 360]]))
    k = int(gaps.argmax())
    start = a[(k + 1) % len(a)]
    end = a[k]
    return float(start), float(end)


def merge_collinear(segs: list[Segment], tol: float = 0.5, gap: float = 0.5) -> list[Segment]:
    """Merge overlapping/adjacent collinear horizontal and vertical segments."""
    out: list[Segment] = []
    buckets: dict[tuple[str, int], list[Segment]] = defaultdict(list)
    for s in segs:
        o = s.orientation(1.0)
        if o is None:
            out.append(s)
            continue
        key = (o, int(round(s.cross_coord(o) / tol)))
        buckets[key].append(s)
    for (o, _), items in buckets.items():
        items.sort(key=lambda s: s.axis_range(o)[0])
        cur_lo, cur_hi = items[0].axis_range(o)
        cc = [items[0].cross_coord(o)]
        width = items[0].width
        for s in items[1:]:
            lo, hi = s.axis_range(o)
            if lo <= cur_hi + gap:
                cur_hi = max(cur_hi, hi)
                cc.append(s.cross_coord(o))
                width = max(width, s.width)
            else:
                out.append(_mk(o, cur_lo, cur_hi, sum(cc) / len(cc), width))
                cur_lo, cur_hi, cc, width = lo, hi, [s.cross_coord(o)], s.width
        out.append(_mk(o, cur_lo, cur_hi, sum(cc) / len(cc), width))
    return out


def _mk(o: str, lo: float, hi: float, c: float, width: float) -> Segment:
    if o == "h":
        return Segment(lo, c, hi, c, width)
    return Segment(c, lo, c, hi, width)


def typical_wall_width(segs: list[Segment]) -> float:
    """Most common stroke width among long segments (wall lines are usually the heaviest)."""
    widths = [round(s.width, 2) for s in segs if s.length > 20 and s.width > 0]
    if not widths:
        return 0.0
    vals, counts = np.unique(widths, return_counts=True)
    order = np.argsort(-vals)
    # the heaviest width that is reasonably common
    total = counts.sum()
    for i in order:
        if counts[i] >= max(4, 0.03 * total):
            return float(vals[i])
    return float(vals[order[0]])
