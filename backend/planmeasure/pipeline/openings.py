"""Opening detection.

Floor plans
    An opening is a gap in a wall bounded by two *jambs* (short lines across
    the wall thickness) with the wall faces continuing outside the gap. The
    contents of the gap determine the kind: glazing lines (window), a swing
    arc (door), two arcs (double door), staggered panels (sliding), dashed
    overhead lines (garage door), nothing (cased opening). Door swings that
    are not bounded by two jambs are found from the arc itself.

Elevations
    Openings are rectangular frames (often with an inner glazing/panel
    rectangle). They are references to openings shown on plans.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass

from .geometry import SegmentIndex, merge_collinear, typical_wall_width
from .interfaces import DetectionContext
from .tags import parse_tag
from .types import Arc, BBox, OpeningDetection, PageData, Segment, TagDetection, View, evidence
from .units import find_expressions


@dataclass
class Jamb:
    pos: float  # coordinate along the wall axis
    v0: float
    v1: float
    wall_axis: str  # "h" | "v"
    seg: Segment


def _in_view(b: BBox, view: View, margin: float = 0.0) -> bool:
    return view.bbox.expand(margin).contains_point(b.cx, b.cy)


def _along(axis: str, x: float, y: float) -> float:
    return x if axis == "h" else y


def _across(axis: str, x: float, y: float) -> float:
    return y if axis == "h" else x


def _box(axis: str, a0: float, a1: float, c0: float, c1: float) -> BBox:
    if axis == "h":
        return BBox.from_points(a0, c0, a1, c1)
    return BBox.from_points(c0, a0, c1, a1)


class PlanOpeningDetector:
    name = "plan-geometry"

    def __init__(self, exclude: set[int] | None = None):
        # ids of segments that belong to dimension annotations (not building geometry)
        self.exclude = exclude or set()

    def detect(self, page: PageData, view: View, tags: list[TagDetection], ctx: DetectionContext) -> list[OpeningDetection]:
        margin = ctx.units(300)
        segs = [s for s in page.geometry.segments if id(s) not in self.exclude and _in_view(s.bbox, view, margin)]
        if not segs:
            return []
        self.ctx = ctx
        self.tol = max(0.6, ctx.units(25), ctx.min_tol)
        self.idx = SegmentIndex(segs, cell=max(ctx.units(600), 4.0))
        self.wall_w = typical_wall_width(segs)
        arcs = [a for a in page.geometry.arcs if _in_view(a.bbox, view, margin)]
        t_min, t_max = ctx.units(60), ctx.units(700)
        w_min, w_max = ctx.units(300), ctx.units(7500)

        jambs: list[Jamb] = []
        for s in segs:
            o = s.orientation(2.0)
            if o is None or s.dashed or not (t_min <= s.length <= t_max):
                continue
            wall_axis = "h" if o == "v" else "v"
            lo, hi = s.axis_range(o)
            jambs.append(Jamb(s.cross_coord(o), lo, hi, wall_axis, s))

        groups: dict[tuple[str, int, int], list[Jamb]] = defaultdict(list)
        q = self.tol * 2
        for j in jambs:
            groups[(j.wall_axis, int(round(j.v0 / q)), int(round(j.v1 / q)))].append(j)

        found: list[OpeningDetection] = []
        used_arcs: set[int] = set()
        for (axis, _, _), items in groups.items():
            items.sort(key=lambda j: j.pos)
            # collapse duplicates (overlapping jamb strokes)
            uniq: list[Jamb] = []
            for j in items:
                if uniq and abs(j.pos - uniq[-1].pos) < self.tol:
                    continue
                uniq.append(j)
            for j1, j2 in zip(uniq, uniq[1:]):
                g = j2.pos - j1.pos
                if not (w_min <= g <= w_max):
                    continue
                det = self._evaluate_gap(page, view, axis, j1, j2, arcs, used_arcs)
                if det is not None:
                    found.append(det)

        found += self._arc_doors(page, view, arcs, used_arcs, found)
        found = dedupe_detections(found, self.tol)
        for i, d in enumerate(found):
            d.id = f"{view.id}-o{i}"
            d.room = nearest_room(page, view, d, ctx)
        return found

    # -- helpers -----------------------------------------------------------------

    def _parallel_at(self, axis: str, cross: float, a0: float, a1: float) -> list[Segment]:
        """Segments parallel to ``axis`` at cross coordinate ``cross`` overlapping [a0, a1]."""
        t = self.tol
        box = _box(axis, min(a0, a1) - t, max(a0, a1) + t, cross - t, cross + t)
        out = []
        for s in self.idx.query(box):
            if s.orientation(2.0) != axis:
                continue
            if abs(s.cross_coord(axis) - cross) > t:
                continue
            out.append(s)
        return out

    def _face_continues(self, axis: str, j: Jamb, direction: int) -> int:
        """How many wall faces continue from jamb ``j`` away from the gap (0..2)."""
        n = 0
        min_len = self.ctx.units(40)
        for face in (j.v0, j.v1):
            for s in self._parallel_at(axis, face, j.pos - self.tol, j.pos + self.tol):
                lo, hi = s.axis_range(axis)
                # the face reaches the jamb and runs on away from the gap (in scans the
                # face line may also continue through the gap - that is handled by the caller)
                if direction < 0 and hi >= j.pos - self.tol and j.pos - lo >= min_len:
                    n += 1
                    break
                if direction > 0 and lo <= j.pos + self.tol and hi - j.pos >= min_len:
                    n += 1
                    break
        return n

    def _evaluate_gap(self, page, view, axis, j1: Jamb, j2: Jamb, arcs: list[Arc], used_arcs: set[int]) -> OpeningDetection | None:
        t = self.tol
        p1, p2 = j1.pos, j2.pos
        v0, v1 = min(j1.v0, j2.v0), max(j1.v1, j2.v1)
        g = p2 - p1
        c1 = self._face_continues(axis, j1, -1)
        c2 = self._face_continues(axis, j2, +1)
        if c1 == 0 and c2 == 0:
            return None
        # face lines running straight through both jambs (typical of scans, where the wall
        # face and a window's face line merge) count as face lines across the gap
        through = []
        for face in (v0, v1):
            for s in self._parallel_at(axis, face, p1, p2):
                lo, hi = s.axis_range(axis)
                if lo < p1 - 2 * t and hi > p2 + 2 * t:
                    through.append(s)
                    break

        box = _box(axis, p1, p2, v0, v1)
        full_face, full_inner, partial_inner = list(through), [], []
        for s in self.idx.query(box.expand(t)):
            if s.orientation(2.0) != axis or s is j1.seg or s is j2.seg:
                continue
            lo, hi = s.axis_range(axis)
            c = s.cross_coord(axis)
            if not (v0 - t <= c <= v1 + t) or lo < p1 - t or hi > p2 + t:
                continue
            full = abs(lo - p1) < t and abs(hi - p2) < t
            at_face = abs(c - v0) < t or abs(c - v1) < t
            if full and at_face:
                full_face.append(s)
            elif full:
                full_inner.append(s)
            elif not at_face and (hi - lo) >= 0.3 * g:
                partial_inner.append(s)

        ev = [
            evidence(
                "jambs",
                "Wall gap bounded by two jambs",
                True,
                detail=f"Gap of {self.ctx.real(g):.0f} mm (at drawing scale) with wall faces continuing on {c1 + c2} side(s)",
                page_index=page.index,
                bbox=box,
            )
        ]
        conf = 0.6 + 0.05 * (c1 + c2)
        kind = None
        features: dict = {"face_continuations": c1 + c2}
        arc_items: list[Arc] = []

        # doors: swing arcs hinged at a jamb that close onto the *other* jamb of this gap
        # (a door gap has no wall faces running across it)
        singles, halves = [], []
        for ai, a in enumerate(arcs):
            if full_face or ai in used_arcs or not (70 <= a.sweep_deg <= 110):
                continue
            ca, cc = _along(axis, a.cx, a.cy), _across(axis, a.cx, a.cy)
            if not (v0 - 3 * t <= cc <= v1 + 3 * t):
                continue
            near1, near2 = abs(ca - p1) < 2 * t, abs(ca - p2) < 2 * t
            if not (near1 or near2):
                continue
            ends_along = [_along(axis, *a.start), _along(axis, *a.end)]
            if abs(a.r - g) < 0.1 * g:
                target = p2 if near1 else p1
                if min(abs(e - target) for e in ends_along) < max(2 * t, 0.1 * g):
                    singles.append((ai, a, 1 if near1 else 2))
            elif abs(a.r - g / 2) < 0.1 * g / 2:
                mid = (p1 + p2) / 2
                if min(abs(e - mid) for e in ends_along) < max(2 * t, 0.1 * g):
                    halves.append((ai, a, 1 if near1 else 2))
        if singles:
            ai, a, hinge = singles[0]
            used_arcs.add(ai)
            arc_items = [a]
            kind = "door"
            conf = 0.9 + 0.02 * (c1 + c2)
            leaf = self._leaf(a)
            ev.append(evidence("swing_arc", "Door swing arc hinged at jamb", True, detail=f"Arc radius equals gap width; hinge at {'first' if hinge == 1 else 'second'} jamb", page_index=page.index, bbox=a.bbox))
            if leaf:
                ev.append(evidence("door_leaf", "Door leaf line drawn from hinge", True, page_index=page.index, bbox=leaf.bbox))
                conf += 0.02
        elif {h for _, _, h in halves} == {1, 2}:
            picks = [next(x for x in halves if x[2] == 1), next(x for x in halves if x[2] == 2)]
            for ai, a, _ in picks:
                used_arcs.add(ai)
                arc_items.append(a)
            kind = "double_door"
            conf = 0.9 + 0.02 * (c1 + c2)
            ev.append(evidence("swing_arc", "Two swing arcs meeting at centre (pair of leaves)", True, page_index=page.index, bbox=arc_items[0].bbox.union(arc_items[1].bbox)))

        if kind is None and len(partial_inner) >= 2:
            touches1 = [s for s in partial_inner if abs(s.axis_range(axis)[0] - p1) < t]
            touches2 = [s for s in partial_inner if abs(s.axis_range(axis)[1] - p2) < t]
            if touches1 and touches2:
                s1, s2 = touches1[0], touches2[0]
                overlap = s1.axis_range(axis)[1] - s2.axis_range(axis)[0]
                if overlap > 0 and abs(s1.cross_coord(axis) - s2.cross_coord(axis)) > 0.5 * t:
                    kind = "sliding_window" if full_face else "sliding_door"
                    conf = 0.85
                    ev.append(evidence("sliding_panels", "Two overlapping staggered panels (sliding)", True, page_index=page.index, bbox=box))
        if kind is None:
            dashed = self._dashed_near(axis, p1, p2, v0, v1)
            if dashed:
                kind = "garage_door"
                conf = 0.8
                ev.append(evidence("overhead_door", "Dashed overhead-door lines across the gap", True, page_index=page.index, bbox=dashed[0].bbox))
        if kind is None and full_inner:
            kind = "window"
            conf = 0.86 + (0.04 if full_face else 0.0) + 0.02 * min(c1 + c2, 2)
            ev.append(
                evidence(
                    "glazing_lines",
                    "Glazing lines span jamb to jamb",
                    True,
                    detail=f"{len(full_inner)} inner + {len(full_face)} face line(s)",
                    page_index=page.index,
                    bbox=box,
                )
            )
        if kind is None and len(full_face) >= 2:
            thin = all(s.width and self.wall_w and s.width < 0.6 * self.wall_w for s in full_face)
            if not thin:
                return None  # solid wall between two openings (a pier)
            kind = "window"
            conf = 0.62
            ev.append(evidence("thin_lines", "Thin lines across wall gap (window convention without glazing line)", None, page_index=page.index, bbox=box))
        if kind is None:
            if full_face or partial_inner:
                return None
            # an empty gap only counts as an opening when both wall faces continue on both sides
            if c1 + c2 < 4 or g > self.ctx.units(4500):
                return None
            kind = "opening"
            conf = 0.5 + 0.05 * (c1 + c2)
            ev.append(evidence("empty_gap", "Empty wall gap (cased opening or passage)", None, page_index=page.index, bbox=box))

        bbox = box
        for a in arc_items:
            bbox = bbox.union(a.bbox)
        features.update({"inner_lines": len(full_inner), "face_lines": len(full_face), "arcs": len(arc_items)})
        return OpeningDetection(
            id="",
            page_index=page.index,
            view_id=view.id,
            view_type=view.view_type,
            kind=kind,
            bbox=bbox,
            axis=axis,
            edges=(p1, p2),
            cross=(v0, v1),
            detector="jamb-pair",
            confidence=min(conf, 0.99),
            evidence=ev,
            features=features,
        )

    def _leaf(self, a: Arc) -> Segment | None:
        box = BBox(a.cx - a.r - 2, a.cy - a.r - 2, 2 * a.r + 4, 2 * a.r + 4)
        for s in self.idx.query(box):
            for (x, y), (ox, oy) in (((s.x0, s.y0), (s.x1, s.y1)), ((s.x1, s.y1), (s.x0, s.y0))):
                if math.hypot(x - a.cx, y - a.cy) < 2 * self.tol and abs(math.hypot(ox - a.cx, oy - a.cy) - a.r) < 0.06 * a.r + self.tol:
                    return s
        return None

    def _dashed_near(self, axis, p1, p2, v0, v1) -> list[Segment]:
        reach = self.ctx.units(900)
        box = _box(axis, p1, p2, v0 - reach, v1 + reach)
        out = []
        g = p2 - p1
        for s in self.idx.query(box):
            if not s.dashed or s.orientation(2.0) != axis:
                continue
            lo, hi = s.axis_range(axis)
            if hi - lo >= 0.7 * g and lo >= p1 - 2 * self.tol and hi <= p2 + 2 * self.tol:
                out.append(s)
        return out

    def _arc_doors(self, page, view, arcs: list[Arc], used: set[int], existing: list[OpeningDetection]) -> list[OpeningDetection]:
        """Door swings not bounded by two jambs (e.g. a door beside a perpendicular wall)."""
        out: list[OpeningDetection] = []
        d_min, d_max = self.ctx.units(450), self.ctx.units(1400)
        for ai, a in enumerate(arcs):
            if ai in used or not (75 <= a.sweep_deg <= 105) or not (d_min <= a.r <= d_max):
                continue
            if any(e.bbox.contains_point(a.cx, a.cy, tol=self.tol) for e in existing + out):
                continue
            leaf = self._leaf(a)
            if leaf is None:
                continue
            ends = [a.start, a.end]
            leaf_far = max(((leaf.x0, leaf.y0), (leaf.x1, leaf.y1)), key=lambda p: math.hypot(p[0] - a.cx, p[1] - a.cy))
            closed = max(ends, key=lambda p: math.hypot(p[0] - leaf_far[0], p[1] - leaf_far[1]))
            dx, dy = closed[0] - a.cx, closed[1] - a.cy
            axis = "h" if abs(dx) >= abs(dy) else "v"
            a0, a1 = sorted((_along(axis, a.cx, a.cy), _along(axis, *closed)))
            c = _across(axis, a.cx, a.cy)
            half_t = self.ctx.units(60)
            used.add(ai)
            box = _box(axis, a0, a1, c - half_t, c + half_t)
            out.append(
                OpeningDetection(
                    id="",
                    page_index=page.index,
                    view_id=view.id,
                    view_type=view.view_type,
                    kind="door",
                    bbox=box.union(a.bbox),
                    axis=axis,
                    edges=(a0, a1),
                    cross=(c - half_t, c + half_t),
                    detector="swing-arc",
                    confidence=0.72,
                    evidence=[
                        evidence("swing_arc", "Door swing arc with leaf line", True, page_index=page.index, bbox=a.bbox),
                        evidence("jambs", "Jambs not found on both sides of the opening", False, page_index=page.index, bbox=box),
                    ],
                    features={"arcs": 1},
                )
            )
        return out


def dedupe_detections(dets: list[OpeningDetection], tol: float) -> list[OpeningDetection]:
    """Drop detections describing the same wall gap twice (keep the most confident)."""
    out: list[OpeningDetection] = []
    for d in sorted(dets, key=lambda d: -d.confidence):
        dup = False
        for k in out:
            if k.axis == d.axis and abs(k.edges[0] - d.edges[0]) < 2 * tol and abs(k.edges[1] - d.edges[1]) < 2 * tol and abs(k.cross[0] - d.cross[0]) < 4 * tol:
                dup = True
                break
        if not dup:
            out.append(d)
    return out


# ---------------------------------------------------------------------------
# Elevations
# ---------------------------------------------------------------------------


def find_rectangles(segs: list[Segment], tol: float, min_side: float, max_side: float) -> list[BBox]:
    """Axis-aligned rectangles formed by horizontal/vertical segments."""
    merged = merge_collinear([s for s in segs if s.orientation(1.5)], tol=tol / 2, gap=tol)
    hs = [s for s in merged if s.orientation(1.5) == "h" and s.length >= min_side * 0.9]
    vs = [s for s in merged if s.orientation(1.5) == "v" and s.length >= min_side * 0.9]
    vidx = SegmentIndex(vs, cell=max(max_side / 4, 1.0))
    by_x: dict[int, list[Segment]] = defaultdict(list)
    q = max(tol, 0.5)
    for s in hs:
        x0, x1 = s.axis_range("h")
        by_x[int(round(x0 / q))].append(s)
    out: list[BBox] = []
    for key, items in by_x.items():
        cands = items + by_x.get(key - 1, []) + by_x.get(key + 1, [])
        for i, top in enumerate(items):
            tx0, tx1 = top.axis_range("h")
            for bot in cands:
                if bot is top:
                    continue
                bx0, bx1 = bot.axis_range("h")
                if abs(bx0 - tx0) > tol or abs(bx1 - tx1) > tol:
                    continue
                y0, y1 = top.cross_coord("h"), bot.cross_coord("h")
                if y1 <= y0 + min_side * 0.9 or y1 - y0 > max_side:
                    continue
                w = tx1 - tx0
                if not (min_side * 0.9 <= w <= max_side):
                    continue
                if _vertical_cover(vidx, tx0, y0, y1, tol) and _vertical_cover(vidx, tx1, y0, y1, tol):
                    out.append(BBox.from_points(tx0, y0, tx1, y1))
    # dedupe
    uniq: list[BBox] = []
    for r in out:
        if not any(abs(r.x0 - u.x0) < tol and abs(r.x1 - u.x1) < tol and abs(r.y0 - u.y0) < tol and abs(r.y1 - u.y1) < tol for u in uniq):
            uniq.append(r)
    return uniq


def _vertical_cover(vidx: SegmentIndex, x: float, y0: float, y1: float, tol: float) -> bool:
    for s in vidx.query(BBox(x - tol, y0, 2 * tol, y1 - y0)):
        if abs(s.cross_coord("v") - x) > tol:
            continue
        lo, hi = s.axis_range("v")
        if lo <= y0 + tol and hi >= y1 - tol:
            return True
    return False


class ElevationOpeningDetector:
    name = "elevation-frames"

    def __init__(self, exclude: set[int] | None = None):
        self.exclude = exclude or set()

    def detect(self, page: PageData, view: View, tags: list[TagDetection], ctx: DetectionContext) -> list[OpeningDetection]:
        tol = max(0.6, ctx.units(20))
        min_side, max_side = ctx.units(250), ctx.units(7000)
        segs = [s for s in page.geometry.segments if id(s) not in self.exclude and view.bbox.contains(s.bbox, tol=tol)]
        rects = [r for r in page.geometry.rects if view.bbox.contains(r, tol=tol) and min_side <= r.w <= max_side and min_side <= r.h <= max_side]
        rects += find_rectangles(segs, tol, min_side, max_side)
        uniq: list[BBox] = []
        for r in rects:
            if not any(abs(r.x0 - u.x0) < tol and abs(r.x1 - u.x1) < tol and abs(r.y0 - u.y0) < tol and abs(r.y1 - u.y1) < tol for u in uniq):
                uniq.append(r)
        rects = uniq
        # ground line: the longest heavy horizontal line in the view
        hs = [s for s in segs if s.orientation() == "h"]
        ground = max(hs, key=lambda s: (s.width, s.length)).y0 if hs else None

        # nested frames: keep the outer rectangle, remember the inner one
        rects.sort(key=lambda r: -r.area)
        inner_of: dict[int, int] = {}
        for i, outer in enumerate(rects):
            for j in range(i + 1, len(rects)):
                inner = rects[j]
                if j in inner_of or not outer.contains(inner, tol=tol * 0.5):
                    continue
                inset = min(inner.x0 - outer.x0, outer.x1 - inner.x1, inner.y0 - outer.y0, outer.y1 - inner.y1)
                if -tol <= inset <= 0.25 * min(outer.w, outer.h):
                    inner_of[j] = i
        outers = [i for i in range(len(rects)) if i not in inner_of]
        # a rectangle containing several candidate openings is a facade/panel, not an opening
        big = set()
        for i in outers:
            contained = sum(1 for k in outers if k != i and rects[i].contains(rects[k], tol=tol))
            if contained >= 2:
                big.add(i)
        out: list[OpeningDetection] = []
        for i in outers:
            if i in big:
                continue
            r = rects[i]
            nested = any(v == i for v in inner_of.values())
            touches_ground = ground is not None and abs(r.y1 - ground) < 2 * tol
            # garage door panels: full-width horizontal lines (inner glazing frames are inset)
            panel_lines = sum(
                1 for s in hs if r.contains(s.bbox, tol=tol * 0.5) and s.length > r.w - 2 * tol and r.y0 + tol < s.y0 < r.y1 - tol
            )
            if touches_ground and panel_lines >= 2:
                kind = "garage_door"
            elif touches_ground:
                kind = "door"
            else:
                kind = "window"
            conf = 0.8 if nested else 0.6
            ev = [
                evidence(
                    "frame",
                    "Rectangular frame" + (" with inner glazing/panel line" if nested else ""),
                    True,
                    page_index=page.index,
                    bbox=r,
                )
            ]
            if touches_ground:
                ev.append(evidence("ground", "Frame starts at ground/floor line", None, page_index=page.index, bbox=r))
            out.append(
                OpeningDetection(
                    id="",
                    page_index=page.index,
                    view_id=view.id,
                    view_type=view.view_type,
                    kind=kind,
                    bbox=r,
                    axis="h",
                    edges=(r.x0, r.x1),
                    cross=(r.y0, r.y1),
                    detector=self.name,
                    confidence=conf,
                    evidence=ev,
                    features={"nested": nested, "touches_ground": touches_ground, "panel_lines": panel_lines},
                )
            )
        for k, d in enumerate(out):
            d.id = f"{view.id}-e{k}"
        return out


# ---------------------------------------------------------------------------
# Room names (location hint)
# ---------------------------------------------------------------------------

ROOM_WORDS = re.compile(
    r"\b(BED(ROOM)?|MASTER|KITCHEN|LIVING|LOUNGE|DINING|FAMILY|BATH(ROOM)?|ENSUITE|WC|TOILET|POWDER|LAUNDRY|GARAGE|CARPORT|HALL(WAY)?|ENTRY|FOYER|LOBBY|OFFICE|STUDY|STORE|STORAGE|CLOSET|WIR|ROBE|PANTRY|CORRIDOR|STAIR|MEETING|RECEPTION|CONFERENCE|BREAKOUT|PLANT|UTILITY|RUMPUS|GUEST|NURSERY|DECK|PATIO|BALCONY|ROOM|SUITE|WORKSHOP|CLASSROOM|LAB)\b",
    re.I,
)


def nearest_room(page: PageData, view: View, d: OpeningDetection, ctx: DetectionContext) -> str | None:
    best = None
    reach = ctx.units(5000)
    for ln in page.lines:
        t = ln.text.strip()
        if not ROOM_WORDS.search(t) or parse_tag(t) or len(t) > 32:
            continue
        if any(e.kind in ("dim", "pair") for e in find_expressions(t)) and not re.search(r"[A-Za-z]{3}", t):
            continue
        if not view.bbox.contains(ln.bbox, tol=2):
            continue
        dist = d.bbox.distance_to(ln.bbox)
        if dist > reach:
            continue
        if best is None or dist < best[0]:
            best = (dist, t)
    return best[1] if best else None
