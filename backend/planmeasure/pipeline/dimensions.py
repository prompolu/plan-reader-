"""Dimension detection.

A linear dimension is recognised from its *geometry*, not just its text:

    dimension text  ->  dimension line parallel to the text, just beside it
                    ->  terminators on that line (ticks / arrows / dots /
                        extension-line crossings) on both sides of the text
                    ->  the span between the nearest terminators
                    ->  extension lines at the span ends (and where they start)

Numbers that are not attached to a dimension line (room numbers, notes, areas)
are not treated as dimensions. Size callouts ("1200 x 1500") are kept as
callouts and only used when they sit next to an opening tag.
"""

from __future__ import annotations

import math
from collections import defaultdict

from .geometry import SegmentIndex
from .interfaces import DetectionContext
from .scale import scale_check
from .tags import RE_TAG, TAG_PREFIXES
from .types import BBox, DimensionAnnotation, PageClassification, PageData, Segment, TextLine, View
from .units import find_expressions, normalize_chars

DIMENSIONED_VIEWS = {"floor_plan", "elevation", "section", "detail", "site_plan"}


def _unit_basis(dim_explicit: bool, cls: PageClassification) -> str:
    if dim_explicit:
        return "explicit"
    return {"note": "note", "scale": "scale", "notation": "notation"}.get(cls.unit_basis, "assumed")


class LinearDimensionDetector:
    name = "linear-dimensions"

    def __init__(self, exclude: set[int] | None = None):
        # ids of segments that are not dimension graphics (e.g. tag symbols)
        self.exclude = exclude or set()

    def detect(
        self, page: PageData, views: list[View], cls: PageClassification, ctx_for_view
    ) -> tuple[list[DimensionAnnotation], set[int]]:
        """Returns (dimensions, ids of segments that belong to dimension annotations)."""
        tb = cls.title_block
        segs = [s for s in page.geometry.segments if id(s) not in self.exclude]
        self._fills = page.geometry.fills
        cell = max(page.width, page.height) / 120.0
        idx = SegmentIndex(segs, cell=cell)
        dims: list[DimensionAnnotation] = []
        used: set[int] = set()
        n = 0
        for ln in page.lines:
            if tb is not None and tb.contains(ln.bbox, tol=2):
                continue
            view = _view_of(views, ln.bbox)
            if view is None or view.view_type not in DIMENSIONED_VIEWS:
                continue
            exprs = find_expressions(ln.text, cls.default_unit)
            if not exprs:
                continue
            has_tag = bool(
                [m for m in RE_TAG.finditer(normalize_chars(ln.text)) if m.group("prefix") in TAG_PREFIXES]
            )
            ctx: DetectionContext = ctx_for_view(view)
            for e in exprs:
                if e.kind == "dim" and e.dim is not None:
                    tb_box = ln.sub_bbox(e.start, e.end)
                    d = DimensionAnnotation(
                        id=f"p{page.index}-d{n}",
                        page_index=page.index,
                        text=e.text,
                        value_mm=e.dim.value_mm,
                        unit=e.dim.unit,
                        unit_explicit=e.dim.unit_explicit,
                        unit_basis=_unit_basis(e.dim.unit_explicit, cls),
                        text_bbox=tb_box,
                        text_angle=ln.angle,
                        kind="linear",
                        confidence=0.92 if ln.source == "pdf" else 0.9 * ln.confidence,
                        source=ln.source,
                        view_id=view.id,
                    )
                    ok = self._attach_line(d, ln, idx, used, view.scale.ratio, page.mm_per_unit)
                    if ok:
                        chk = scale_check(d, view.scale.ratio, page.mm_per_unit)
                        d.scale_check = chk
                        if chk is not None:
                            if chk["consistent"]:
                                d.confidence = min(0.99, d.confidence + 0.04)
                            else:
                                d.confidence *= 0.85
                                d.notes.append(
                                    f"Drawn length measures {chk['drawn_length_mm']:.0f} mm at {view.scale.text or 'the drawing scale'}; text says {d.value_mm:.0f} mm"
                                )
                        dims.append(d)
                        n += 1
                    elif has_tag:
                        # a single size written on the same line as a tag, e.g. "D-01 900"
                        d.kind = "callout"
                        d.confidence *= 0.8
                        d.notes.append("Number written beside a tag (no dimension line)")
                        dims.append(d)
                        n += 1
                elif e.kind == "pair" and e.pair is not None:
                    pid = f"p{page.index}-c{n}"
                    for role, pd, (a, b) in zip(("width", "height"), e.pair, e.pair_spans or ((e.start, e.end), (e.start, e.end))):
                        dims.append(
                            DimensionAnnotation(
                                id=f"p{page.index}-d{n}",
                                page_index=page.index,
                                text=e.text,
                                value_mm=pd.value_mm,
                                unit=pd.unit,
                                unit_explicit=pd.unit_explicit,
                                unit_basis=_unit_basis(pd.unit_explicit, cls),
                                text_bbox=ln.sub_bbox(a, b),
                                text_angle=ln.angle,
                                kind="callout",
                                confidence=0.9 if ln.source == "pdf" else 0.88 * ln.confidence,
                                source=ln.source,
                                view_id=view.id,
                                pair_role=role,
                                pair_id=pid,
                            )
                        )
                        n += 1
        _chains(dims)
        return dims, used

    # -------------------------------------------------------------------------

    def _attach_line(
        self, d: DimensionAnnotation, ln: TextLine, idx: SegmentIndex, used: set[int], ratio: float | None = None, mpu: float | None = None
    ) -> bool:
        axis = ln.axis
        if axis is None:
            return False
        tb = d.text_bbox
        size = max(ln.size, 1.0)
        c_along = tb.cx if axis == "h" else tb.cy
        c_across = tb.cy if axis == "h" else tb.cx
        half_len = (tb.w if axis == "h" else tb.h) / 2
        reach = 2.4 * size
        tol = max(0.4, 0.12 * size)
        q = BBox.from_points(tb.x0 - reach, tb.y0 - reach, tb.x1 + reach, tb.y1 + reach)
        # candidate dimension-line pieces: parallel, close to the text, overlapping it along the axis
        pieces: list[Segment] = []
        for s in idx.query(q.expand(3 * size)):
            if s.orientation(1.5) != axis or s.dashed:
                continue
            off = s.cross_coord(axis) - c_across
            if abs(off) > reach:
                continue
            if abs(off) < 0.3 * size:
                # a line through the text is only a dimension line if it is broken around the text
                lo, hi = s.axis_range(axis)
                if lo < c_along + 0.8 * half_len and hi > c_along - 0.8 * half_len:
                    continue
            pieces.append(s)
        if not pieces:
            return False
        # evaluate every candidate line position: terminator quality, distance and
        # (when the scale is known) agreement between drawn length and written value
        by_pos: dict[int, list[Segment]] = defaultdict(list)
        for s in pieces:
            by_pos[int(round(s.cross_coord(axis) / tol))].append(s)
        options = []
        for key, items in by_pos.items():
            pos = sum(s.cross_coord(axis) for s in items) / len(items)
            lo = min(s.axis_range(axis)[0] for s in items)
            hi = max(s.axis_range(axis)[1] for s in items)
            if not (lo <= c_along - 0.3 * half_len and hi >= c_along + 0.3 * half_len):
                continue
            res = self._resolve(axis, pos, c_along, half_len, size, tol, idx)
            if res is None:
                continue
            p0, p1 = res[0], res[1]
            score = res[4] - 0.15 * abs(pos - c_across) / size
            if ratio and mpu and d.value_mm > 0:
                rel = abs((p1 - p0) * mpu * ratio - d.value_mm) / d.value_mm
                score += 0.6 if rel <= 0.03 else -0.4
            options.append((score, pos, res))
        if not options:
            return False
        _, line_pos, (p0, p1, terms, run, quality, fallback) = max(options, key=lambda o: o[0])
        if fallback:
            d.notes.append("No terminators found; span taken from dimension line ends")
            d.confidence *= 0.8
        kinds = {t[1] for t in terms if abs(t[0] - p0) < 2 * tol or abs(t[0] - p1) < 2 * tol}
        ext = [t[2] for t in terms if t[1] in ("extension", "corner") and t[2] is not None and (abs(t[0] - p0) < 2 * tol or abs(t[0] - p1) < 2 * tol)]
        d.axis = axis
        d.span = (p0, p1)
        d.line_pos = line_pos
        d.line = _axis_seg(axis, p0, p1, line_pos)
        d.terminators = [{"pos": round(t[0], 2), "kind": t[1]} for t in terms if abs(t[0] - p0) < 2 * tol or abs(t[0] - p1) < 2 * tol]
        d.extension_lines = ext
        if quality < 0.5:
            d.confidence *= 0.8
            d.notes.append("Weak terminators (no ticks, arrows or extension lines)")
        elif not ({"tick", "arrow", "dot", "extension"} & kinds):
            d.confidence *= 0.85
        # remember pure dimension graphics so they are not mistaken for building geometry;
        # heavier lines doubling as extension lines (ground lines, wall faces) stay
        host_w = max((s.width for s in run), default=0.0)
        for s in run:
            used.add(id(s))
        for t in terms:
            if t[2] is not None and t[2].width <= 1.5 * host_w + 0.01:
                used.add(id(t[2]))
        return True

    def _resolve(self, axis: str, line_pos: float, c_along: float, half_len: float, size: float, tol: float, idx: SegmentIndex):
        """Span of the dimension on the line at ``line_pos``: (p0, p1, terms, run, quality, fallback)."""
        host = [
            s
            for s in idx.query(_axis_box(axis, c_along - 400 * size, c_along + 400 * size, line_pos - tol, line_pos + tol))
            if s.orientation(1.5) == axis and abs(s.cross_coord(axis) - line_pos) <= tol and not s.dashed
        ]
        host.sort(key=lambda s: s.axis_range(axis)[0])
        # connected run containing the text
        run: list[Segment] = []
        for s in host:
            lo, hi = s.axis_range(axis)
            if not run:
                run = [s]
                continue
            rhi = max(r.axis_range(axis)[1] for r in run)
            if lo <= rhi + 2 * half_len + 2 * size:
                run.append(s)
            else:
                if min(r.axis_range(axis)[0] for r in run) <= c_along <= rhi:
                    break
                run = [s]
        if not run:
            return None
        run_lo = min(r.axis_range(axis)[0] for r in run)
        run_hi = max(r.axis_range(axis)[1] for r in run)
        if not (run_lo - size <= c_along <= run_hi + size):
            return None

        terms: list[tuple[float, str, Segment | None]] = []
        band = _axis_box(axis, run_lo - size, run_hi + size, line_pos - 3 * size, line_pos + 3 * size)
        for s in idx.query(band):
            if s in run:
                continue
            o = s.orientation(3.0)
            if o is not None and o != axis:
                lo, hi = s.axis_range(o)
                # extension lines stop just past the dimension line; a line running
                # through it on both sides (e.g. a crossing dimension) is not a terminator
                if min(line_pos - lo, hi - line_pos) > 1.6 * size:
                    continue
                if lo - tol <= line_pos <= hi + tol:
                    p = s.cross_coord(o)
                    if run_lo - tol <= p <= run_hi + tol:
                        overshoot = min(line_pos - lo, hi - line_pos)
                        if s.length < 1.2 * size:
                            kind = "tick"
                        elif overshoot > 0.2 * size:
                            kind = "extension"
                        else:
                            kind = "corner"  # a line merely meeting the dimension line (e.g. a frame corner)
                        terms.append((p, kind, s))
            elif o is None and s.length <= 4.5 * size:
                ang = s.angle % 90
                if 25 <= ang <= 65:
                    mx, my = s.mid
                    if abs((my if axis == "h" else mx) - line_pos) <= 1.2 * size:
                        p = mx if axis == "h" else my
                        if run_lo - size <= p <= run_hi + size:
                            terms.append((p, "tick", s))
        for f in self._fills_near(band):
            pts = f.points
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if abs((cy if axis == "h" else cx) - line_pos) > 1.5 * size:
                continue
            if f.kind == "triangle" and len(pts) == 3:
                apex = max(pts, key=lambda p: math.hypot(p[0] - cx, p[1] - cy))
                terms.append(((apex[0] if axis == "h" else apex[1]), "arrow", None))
            else:
                terms.append(((cx if axis == "h" else cy), "dot", None))
        if len(run) > 1:
            for s in run:
                lo, hi = s.axis_range(axis)
                terms.append((lo, "line_end", None))
                terms.append((hi, "line_end", None))
        left = [t for t in terms if t[0] < c_along - 0.2 * half_len]
        right = [t for t in terms if t[0] > c_along + 0.2 * half_len]
        fallback = False
        if not left or not right:
            if len(run) == 1 and not terms:
                p0, p1 = run_lo, run_hi
                fallback = True
            else:
                return None
        else:
            p0 = max(left, key=lambda t: t[0])[0]
            p1 = min(right, key=lambda t: t[0])[0]
        if p1 - p0 < 0.4 * half_len:
            return None
        strength = {"tick": 1.0, "arrow": 1.0, "dot": 1.0, "extension": 0.8, "line_end": 0.6, "corner": 0.2}

        def end_strength(p: float) -> float:
            ks = [strength[t[1]] for t in terms if abs(t[0] - p) < 2 * tol]
            return max(ks) if ks else 0.3

        quality = 0.35 if fallback else (end_strength(p0) + end_strength(p1)) / 2
        return p0, p1, terms, run, quality, fallback

    def _fills_near(self, band: BBox):
        return [f for f in self._fills if band.contains_point(*f.center)]


def _axis_box(axis: str, a0: float, a1: float, c0: float, c1: float) -> BBox:
    if axis == "h":
        return BBox.from_points(a0, c0, a1, c1)
    return BBox.from_points(c0, a0, c1, a1)


def _axis_seg(axis: str, a0: float, a1: float, c: float) -> Segment:
    if axis == "h":
        return Segment(a0, c, a1, c)
    return Segment(c, a0, c, a1)


def _chains(dims: list[DimensionAnnotation]) -> None:
    """Group dimensions that share one dimension line into chains."""
    groups: dict[tuple, list[DimensionAnnotation]] = defaultdict(list)
    for d in dims:
        if d.kind != "linear" or d.span is None or d.line_pos is None:
            continue
        groups[(d.view_id, d.axis, round(d.line_pos, 0))].append(d)
    k = 0
    for key, items in groups.items():
        items.sort(key=lambda d: d.span[0])
        # consecutive spans that touch form a chain
        chain = [items[0]]
        chains = []
        for d in items[1:]:
            if abs(d.span[0] - chain[-1].span[1]) < 1.0:
                chain.append(d)
            else:
                chains.append(chain)
                chain = [d]
        chains.append(chain)
        for ch in chains:
            if len(ch) < 2:
                continue
            cid = f"{ch[0].view_id}-ch{k}"
            k += 1
            for d in ch:
                d.chain_id = cid
                d.chain_size = len(ch)


def _view_of(views: list[View], b: BBox) -> View | None:
    inside = [v for v in views if v.bbox.contains_point(b.cx, b.cy)]
    if inside:
        return min(inside, key=lambda v: v.bbox.area)
    near = [v for v in views if v.bbox.distance_to(b) < 20]
    return min(near, key=lambda v: v.bbox.distance_to(b)) if near else None
