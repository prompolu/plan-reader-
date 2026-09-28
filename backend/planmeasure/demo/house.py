"""Parametric building model and sheet drawing (plans, elevations, schedules).

The same model produces both the drawing and its ground truth, so the
benchmark can measure the extraction pipeline against known values.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .drawing import BLACK, GREY, Sheet, TableSpec, View, draw_table, mm, tag_symbol

WINDOW_KINDS = {"window", "sliding_window"}
DOOR_KINDS = {"door", "double_door", "sliding_door", "garage_door"}


@dataclass
class OpeningType:
    tag: str | None
    kind: str
    width: float
    height: float
    sill: float = 0.0
    description: str = ""
    in_schedule: bool = True
    schedule_width: float | None = None
    schedule_height: float | None = None
    schedule_qty: int | None = None


@dataclass
class Placement:
    type_key: str  # key into Building.types
    wall: str
    offset: float
    dim: bool = True
    hinge: str = "start"
    swing: int = 0  # +1/-1 along the wall-normal axis; 0 = default
    dup_tag: bool = False
    tag_shape: str | None = None
    elev_height_dim: bool = False  # individual height dimension on the elevation
    elev_width_dim: bool = False


@dataclass
class Partition:
    id: str
    axis: str  # "x" (runs along x) | "y"
    at: float
    start: float
    end: float
    t: float = 110.0


@dataclass
class Floor:
    name: str  # e.g. "GROUND FLOOR"
    level: float
    sheet_number: str
    placements: list[Placement]
    partitions: list[Partition] = field(default_factory=list)
    rooms: list[tuple[str, float, float]] = field(default_factory=list)
    chain_levels: dict[str, list[float]] = field(default_factory=dict)  # facade -> [sill, head] used in level chain


@dataclass
class Style:
    dim_style: str = "tick"  # tick | arrow | dot
    continuous: bool = False
    window_tag: str = "hexagon"
    door_tag: str = "circle"
    units: str = "metric"  # metric | imperial
    tag_format: str = "{p}-{n:02d}"


@dataclass
class Building:
    W: float
    D: float
    T: float
    floors: list[Floor]
    types: dict[str, OpeningType]
    floor_height: float = 3000.0
    parapet: float = 300.0
    project: str = "RESIDENTIAL BUILDING"
    address: str = "14 HARBOUR STREET, NORTHBRIDGE"
    style: Style = field(default_factory=Style)

    @property
    def top(self) -> float:
        return len(self.floors) * self.floor_height + self.parapet


@dataclass
class WallGeom:
    id: str
    axis: str
    fa: float
    fb: float
    fa_range: tuple[float, float]
    fb_range: tuple[float, float]
    start: float
    out: int  # outward normal sign (exterior walls), 0 for partitions

    def M(self, u: float, v: float) -> tuple[float, float]:
        return (u, v) if self.axis == "x" else (v, u)

    @property
    def lo(self) -> float:
        return min(self.fa, self.fb)

    @property
    def hi(self) -> float:
        return max(self.fa, self.fb)


def walls_for(b: Building, fl: Floor) -> dict[str, WallGeom]:
    W, D, T = b.W, b.D, b.T
    walls = {
        "S": WallGeom("S", "x", 0, T, (0, W), (T, W - T), 0, -1),
        "N": WallGeom("N", "x", D, D - T, (0, W), (T, W - T), 0, 1),
        "W": WallGeom("W", "y", 0, T, (0, D), (T, D - T), 0, -1),
        "E": WallGeom("E", "y", W, W - T, (0, D), (T, D - T), 0, 1),
    }
    for p in fl.partitions:
        walls[p.id] = WallGeom(p.id, p.axis, p.at - p.t / 2, p.at + p.t / 2, (p.start, p.end), (p.start, p.end), p.start, 0)
    return walls


def _subtract(rng: tuple[float, float], holes: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = [rng]
    for h0, h1 in sorted(holes):
        nxt = []
        for a, b in out:
            if h1 <= a or h0 >= b:
                nxt.append((a, b))
                continue
            if h0 > a:
                nxt.append((a, h0))
            if h1 < b:
                nxt.append((h1, b))
        out = nxt
    return [(a, b) for a, b in out if b - a > 1]


def fmt_value(v: float, units: str) -> str:
    if units == "imperial":
        from planmeasure.pipeline.units import format_ft_in

        return format_ft_in(v)
    return f"{round(v):d}"


# ---------------------------------------------------------------------------
# Ground truth containers
# ---------------------------------------------------------------------------


@dataclass
class GTInstance:
    type_key: str
    tag: str | None
    kind: str
    page_index: int
    floor: str | None
    gap_bbox: tuple[float, float, float, float]  # paper pt (x0, y0, x1, y1), wall-gap rectangle
    width_dim_text: str | None
    counted: bool = True  # False for references (enlarged plans)
    dup_tag: bool = False


@dataclass
class GTReference:
    type_key: str
    tag: str | None
    page_index: int
    view: str
    bbox: tuple[float, float, float, float]
    height_dim_text: str | None
    width_dim_text: str | None
    height_explicit: bool


# ---------------------------------------------------------------------------
# Plan drawing
# ---------------------------------------------------------------------------


def _ptbox(view: View, pts: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    ps = [view.P(*p) for p in pts]
    xs, ys = [p[0] for p in ps], [p[1] for p in ps]
    return (min(xs), min(ys), max(xs), max(ys))


def draw_plan(
    sheet: Sheet,
    view: View,
    b: Building,
    fl: Floor,
    page_index: int,
    *,
    clip: tuple[float, float, float, float] | None = None,
    counted: bool = True,
    exterior_dims: bool = True,
) -> list[GTInstance]:
    """Draw a floor plan (optionally clipped to a model region, for enlarged plans)."""
    walls = walls_for(b, fl)
    style = b.style
    inst: list[GTInstance] = []

    def inside(pt) -> bool:
        if clip is None:
            return True
        x0, y0, x1, y1 = clip
        return x0 - 1 <= pt[0] <= x1 + 1 and y0 - 1 <= pt[1] <= y1 + 1

    def seg(p0, p1, width=0.2, dashes=None):
        if clip is not None:
            c = _clip_segment(p0, p1, clip)
            if c is None:
                return
            p0, p1 = c
        sheet.line(view.P(*p0), view.P(*p1), width, dashes=dashes)

    # opening intervals per wall
    by_wall: dict[str, list[tuple[Placement, OpeningType, float, float]]] = {}
    for pl in fl.placements:
        ot = b.types[pl.type_key]
        wg = walls[pl.wall]
        u0 = wg.start + pl.offset
        by_wall.setdefault(pl.wall, []).append((pl, ot, u0, u0 + ot.width))

    # walls with gaps + jambs
    for wid, wg in walls.items():
        holes = [(u0, u1) for _, _, u0, u1 in by_wall.get(wid, [])]
        for face, rng in ((wg.fa, wg.fa_range), (wg.fb, wg.fb_range)):
            for a, c in _subtract(rng, holes):
                seg(wg.M(a, face), wg.M(c, face), 0.6)
        if wg.out == 0:
            # partition end caps
            for u in wg.fa_range:
                seg(wg.M(u, wg.fa), wg.M(u, wg.fb), 0.6)
        for _, _, u0, u1 in by_wall.get(wid, []):
            seg(wg.M(u0, wg.fa), wg.M(u0, wg.fb), 0.6)
            seg(wg.M(u1, wg.fa), wg.M(u1, wg.fb), 0.6)

    # opening symbols, tags, instance ground truth
    inst_by_key: dict[tuple[str, float], GTInstance] = {}
    for wid, items in by_wall.items():
        wg = walls[wid]
        for pl, ot, u0, u1 in items:
            mid_v = (wg.fa + wg.fb) / 2
            gap_pts = [wg.M(u0, wg.lo), wg.M(u1, wg.hi)]
            if clip is not None and not (inside(gap_pts[0]) and inside(gap_pts[1])):
                continue
            kind = ot.kind
            w = u1 - u0
            if kind in ("window", "curtain_wall"):
                for v in (wg.fa, mid_v, wg.fb):
                    seg(wg.M(u0, v), wg.M(u1, v), 0.2)
                if wg.out:
                    sv = wg.fa + wg.out * 60
                    seg(wg.M(u0 - 60, sv), wg.M(u1 + 60, sv), 0.15)
            elif kind == "sliding_window":
                seg(wg.M(u0, wg.fa), wg.M(u1, wg.fa), 0.2)
                seg(wg.M(u0, wg.fb), wg.M(u1, wg.fb), 0.2)
                seg(wg.M(u0, mid_v - 25), wg.M(u0 + w / 2 + 50, mid_v - 25), 0.2)
                seg(wg.M(u1 - w / 2 - 50, mid_v + 25), wg.M(u1, mid_v + 25), 0.2)
            elif kind in ("door", "double_door"):
                swing = pl.swing or (-wg.out if wg.out else 1)
                face = wg.hi if swing > 0 else wg.lo
                leaves = [(u0, u1, w)] if kind == "door" else [(u0, u0 + w / 2, w / 2), (u1, u0 + w / 2, w / 2)]
                if kind == "door" and pl.hinge == "end":
                    leaves = [(u1, u0, w)]
                for hinge_u, other_u, r in leaves:
                    tip = wg.M(hinge_u, face + swing * r)
                    seg(wg.M(hinge_u, face), tip, 0.35)
                    if clip is None or (inside(tip) and inside(wg.M(other_u, face))):
                        c = view.P(*wg.M(hinge_u, face))
                        d_leaf = wg.M(0, swing)
                        d_closed = wg.M(1 if other_u > hinge_u else -1, 0)
                        a0 = -math.degrees(math.atan2(d_leaf[1], d_leaf[0]))
                        a1 = -math.degrees(math.atan2(d_closed[1], d_closed[0]))
                        diff = (a1 - a0 + 180) % 360 - 180
                        sheet.arc(c, view.L(r), a0, a0 + diff, 0.18)
            elif kind == "sliding_door":
                pw = w / 2 + 40
                for (pa, pb, va, vb) in ((u0, u0 + pw, mid_v - 45, mid_v - 5), (u1 - pw, u1, mid_v + 5, mid_v + 45)):
                    p0, p1 = view.P(*wg.M(pa, va)), view.P(*wg.M(pb, vb))
                    sheet.rect(p0[0], p0[1], p1[0], p1[1], 0.2)
            elif kind == "garage_door":
                seg(wg.M(u0, mid_v), wg.M(u1, mid_v), 0.2)
                inner = wg.fb - wg.out * 150
                seg(wg.M(u0, inner), wg.M(u1, inner), 0.15, dashes="[3 2] 0")
                seg(wg.M(u0, inner - wg.out * 450), wg.M(u1, inner - wg.out * 450), 0.15, dashes="[3 2] 0")
            # kind "opening": jambs only

            # tag
            tag_center_v = None
            if ot.tag:
                if wg.out:
                    tag_center_v = wg.fa + wg.out * 800
                else:
                    swing = pl.swing or 1
                    tag_center_v = (wg.lo - 600) if swing > 0 else (wg.hi + 600)
                shape = pl.tag_shape or (style.window_tag if ot.kind in WINDOW_KINDS or ot.kind == "curtain_wall" else style.door_tag)
                c = wg.M((u0 + u1) / 2, tag_center_v)
                if inside(c):
                    tag_symbol(sheet, view.P(*c), ot.tag, shape)
                if pl.dup_tag:
                    c2 = wg.M((u0 + u1) / 2 + max(450, w * 0.35), tag_center_v + (wg.out or 1) * 350)
                    if inside(c2):
                        tag_symbol(sheet, view.P(*c2), ot.tag, shape)

            gi = GTInstance(
                type_key=pl.type_key,
                tag=ot.tag,
                kind=ot.kind,
                page_index=page_index,
                floor=fl.name,
                gap_bbox=_ptbox(view, gap_pts),
                width_dim_text=None,
                counted=counted,
                dup_tag=pl.dup_tag,
            )
            inst.append(gi)
            inst_by_key[(wid, u0)] = gi

    # dimensions
    fmt = lambda v: fmt_value(v, style.units)  # noqa: E731
    if exterior_dims and clip is None:
        for wid in ("S", "N", "W", "E"):
            wg = walls[wid]
            items = sorted(by_wall.get(wid, []), key=lambda t: t[2])
            pos = [wg.fa_range[0]]
            for pl, ot, u0, u1 in items:
                if pl.dim:
                    pos += [u0, u1]
            pos.append(wg.fa_range[1])
            line_at = wg.fa + wg.out * 1500
            axis = "x" if wg.axis == "x" else "y"
            drawn = view.dim_chain(axis, pos, line_at, wg.fa, style=style.dim_style, continuous=style.continuous, fmt=fmt)
            view.dim_chain(axis, [wg.fa_range[0], wg.fa_range[1]], wg.fa + wg.out * 2300, wg.fa, style=style.dim_style, fmt=fmt)
            for pl, ot, u0, u1 in items:
                if not pl.dim:
                    continue
                k = pos.index(u0)
                inst_by_key[(wid, u0)].width_dim_text = drawn[k].text
    # partition / clipped openings: individual dimensions
    for wid, items in by_wall.items():
        wg = walls[wid]
        if wg.out != 0 and clip is None:
            continue
        for pl, ot, u0, u1 in items:
            key = (wid, u0)
            if key not in inst_by_key or not pl.dim:
                continue
            swing = pl.swing or 1
            if wg.out == 0:
                if ot.kind in DOOR_KINDS:
                    # non-swing side, beyond the door tag
                    line_v = (wg.hi + 1100) if swing < 0 else (wg.lo - 1100)
                    obj = wg.hi if swing < 0 else wg.lo
                else:
                    # windows/openings: opposite side to the tag
                    line_v = (wg.lo - 450) if swing < 0 else (wg.hi + 450)
                    obj = wg.lo if swing < 0 else wg.hi
            else:
                line_v = wg.fa + wg.out * 1300
                obj = wg.fa
            axis = "x" if wg.axis == "x" else "y"
            drawn = view.dim_chain(axis, [u0, u1], line_v, obj, style=style.dim_style, fmt=fmt)
            inst_by_key[key].width_dim_text = drawn[0].text

    # rooms
    for name, x, y in fl.rooms:
        if inside((x, y)):
            p = view.P(x, y)
            sheet.text(p[0], p[1], name, 7.5, "helv", align="center")
    return inst


def _clip_segment(p0, p1, clip):
    """Liang-Barsky clipping of a segment to an axis-aligned box (model coords)."""
    x0, y0 = p0
    x1, y1 = p1
    xmin, ymin, xmax, ymax = clip
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - xmin), (dx, xmax - x0), (-dy, y0 - ymin), (dy, ymax - y0)):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None
    return (x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy)


# ---------------------------------------------------------------------------
# Elevations
# ---------------------------------------------------------------------------

FACADE_WALL = {"SOUTH": "S", "NORTH": "N", "EAST": "E", "WEST": "W"}


def facade_width(b: Building, side: str) -> float:
    return b.W if side in ("S", "N") else b.D


def to_facade_u(b: Building, side: str, u: float) -> float:
    """Map a wall coordinate (x for S/N, y for E/W) to the elevation's horizontal axis."""
    if side == "S":
        return u
    if side == "N":
        return b.W - u
    if side == "E":
        return u
    return b.D - u  # W


def draw_elevation(sheet: Sheet, view: View, b: Building, side: str, page_index: int) -> list[GTReference]:
    style = b.style
    fmt = lambda v: fmt_value(v, style.units)  # noqa: E731
    fw = facade_width(b, side)
    top = b.top
    # ground line and outline
    sheet.line(view.P(-1500, 0), view.P(fw + 1500, 0), 1.0)
    sheet.polyline([view.P(0, 0), view.P(0, top), view.P(fw, top), view.P(fw, 0)], 0.5)
    sheet.line(view.P(-150, top - b.parapet), view.P(fw + 150, top - b.parapet), 0.25)
    for i in range(1, len(b.floors)):
        z = i * b.floor_height
        sheet.line(view.P(0, z), view.P(fw, z), 0.15, dashes="[4 2 1 2] 0")

    refs: list[GTReference] = []
    openings = []  # (pl, ot, ue0, ue1, z0, z1, floor)
    for fl in b.floors:
        walls = walls_for(b, fl)
        for pl in fl.placements:
            if pl.wall != side:
                continue
            ot = b.types[pl.type_key]
            wg = walls[side]
            u0 = wg.start + pl.offset
            u1 = u0 + ot.width
            e0, e1 = sorted((to_facade_u(b, side, u0), to_facade_u(b, side, u1)))
            z0 = fl.level + (ot.sill if ot.kind in WINDOW_KINDS else 0.0)
            z1 = z0 + ot.height
            openings.append((pl, ot, e0, e1, z0, z1, fl))

    for pl, ot, e0, e1, z0, z1, fl in openings:
        p0, p1 = view.P(e0, z0), view.P(e1, z1)
        sheet.rect(p0[0], p1[1], p1[0], p0[1], 0.35)
        inset = 60 if ot.kind in WINDOW_KINDS else 80
        q0, q1 = view.P(e0 + inset, z0 + inset), view.P(e1 - inset, z1 - inset)
        if ot.kind in ("door",):
            q0 = view.P(e0 + inset, z0)
            sheet.rect(q0[0], q1[1], q1[0], q0[1], 0.15)
        elif ot.kind == "garage_door":
            for k in range(1, int(ot.height // 500) + 1):
                zz = z0 + k * 500
                if zz < z1 - 50:
                    sheet.line(view.P(e0, zz), view.P(e1, zz), 0.15)
        else:
            sheet.rect(q0[0], q1[1], q1[0], q0[1], 0.15)
            if ot.kind in ("double_door", "sliding_door", "sliding_window") or ot.width >= 1700:
                em = (e0 + e1) / 2
                sheet.line(view.P(em, z0 + inset), view.P(em, z1 - inset), 0.15)
        if ot.tag:
            shape = pl.tag_shape or (style.window_tag if ot.kind in WINDOW_KINDS else style.door_tag)
            if ot.kind in WINDOW_KINDS:
                c = view.P((e0 + e1) / 2, z0 - 380)
            else:
                c = view.P((e0 + e1) / 2, z1 + 380)
            tag_symbol(sheet, c, ot.tag, shape)
        refs.append(
            GTReference(
                type_key=pl.type_key,
                tag=ot.tag,
                page_index=page_index,
                view="elevation",
                bbox=(p0[0], p1[1], p1[0], p0[1]),
                height_dim_text=None,
                width_dim_text=None,
                height_explicit=False,
            )
        )

    # vertical level chain (left)
    levels = {0.0, top}
    for fl in b.floors:
        levels.add(fl.level)
        for lv in fl.chain_levels.get(side, []):
            levels.add(fl.level + lv)
    levels = sorted(levels)
    chain = view.dim_chain("y", levels, -1400, 0, style=style.dim_style, continuous=style.continuous, fmt=fmt)
    for ref, (pl, ot, e0, e1, z0, z1, fl) in zip(refs, openings):
        if z0 in levels and z1 in levels and levels.index(z1) == levels.index(z0) + 1:
            ref.height_dim_text = chain[levels.index(z0)].text
            ref.height_explicit = True
    # individual height dims
    for ref, (pl, ot, e0, e1, z0, z1, fl) in zip(refs, openings):
        if pl.elev_height_dim and not ref.height_explicit:
            d = view.dim_chain("y", [z0, z1], e1 + 450, e1, style=style.dim_style, fmt=fmt, text_side=-1)
            ref.height_dim_text = d[0].text
            ref.height_explicit = True
    # horizontal chain below ground for openings flagged elev_width_dim
    wpos = [0.0]
    for pl, ot, e0, e1, z0, z1, fl in sorted(openings, key=lambda t: t[2]):
        if pl.elev_width_dim and fl is b.floors[0]:
            wpos += [e0, e1]
    wpos.append(fw)
    if len(wpos) > 2:
        objs = [0.0] + [0.0] * (len(wpos) - 2) + [0.0]
        for i, (pl, ot, e0, e1, z0, z1, fl) in enumerate(openings):
            if e0 in wpos:
                objs[wpos.index(e0)] = z0
            if e1 in wpos:
                objs[wpos.index(e1)] = z0
        wdims = view.dim_chain("x", wpos, -1000, objs, style=style.dim_style, continuous=style.continuous, fmt=fmt, text_side=-1)
        for ref, (pl, ot, e0, e1, z0, z1, fl) in zip(refs, openings):
            if e0 in wpos and e1 in wpos and wpos.index(e1) == wpos.index(e0) + 1:
                ref.width_dim_text = wdims[wpos.index(e0)].text
    # level markers (right)
    for fl in b.floors:
        p = view.P(fw + 700, fl.level)
        sheet.polyline([(p[0] - mm(1.2), p[1] - mm(1.8)), (p[0] + mm(1.2), p[1] - mm(1.8)), p], 0.2, closed=True)
        lv = f"{fl.level / 1000:+.3f}" if style.units == "metric" else ""
        sheet.text(p[0] + mm(2.5), p[1] - mm(0.5), f"{fl.name.split()[0]} FL {lv}".strip(), 5.5)
    return refs


# ---------------------------------------------------------------------------
# Schedules
# ---------------------------------------------------------------------------


def plan_counts(b: Building) -> dict[str, int]:
    counts: dict[str, int] = {}
    for fl in b.floors:
        for pl in fl.placements:
            counts[pl.type_key] = counts.get(pl.type_key, 0) + 1
    return counts


def schedule_tables(b: Building, size_column: bool = False) -> tuple[TableSpec | None, TableSpec | None]:
    counts = plan_counts(b)
    fmt = lambda v: fmt_value(v, b.style.units)  # noqa: E731
    doors, windows = [], []
    for key, ot in b.types.items():
        if not ot.tag or not ot.in_schedule:
            continue
        w = ot.schedule_width if ot.schedule_width is not None else ot.width
        h = ot.schedule_height if ot.schedule_height is not None else ot.height
        qty = ot.schedule_qty if ot.schedule_qty is not None else counts.get(key, 0)
        if ot.kind in WINDOW_KINDS or ot.kind == "curtain_wall":
            row = [ot.tag, ot.description or ot.kind.replace("_", " ").upper()]
            row += [f"{fmt(w)} x {fmt(h)}"] if size_column else [fmt(w), fmt(h)]
            row += [fmt(ot.sill), str(qty), ""]
            windows.append(row)
        else:
            row = [ot.tag, ot.description or ot.kind.replace("_", " ").upper()]
            row += [f"{fmt(w)} x {fmt(h)}"] if size_column else [fmt(w), fmt(h)]
            row += [str(qty), ""]
            doors.append(row)
    dcols = ["MARK", "TYPE"] + (["SIZE (W x H)"] if size_column else ["WIDTH", "HEIGHT"]) + ["QTY", "REMARKS"]
    wcols = ["MARK", "TYPE"] + (["SIZE (W x H)"] if size_column else ["WIDTH", "HEIGHT"]) + ["SILL", "QTY", "REMARKS"]
    dw = [16, 58] + ([34] if size_column else [18, 18]) + [12, 30]
    ww = [16, 44] + ([34] if size_column else [18, 18]) + [16, 12, 26]
    dt = TableSpec("DOOR SCHEDULE", dcols, dw, doors) if doors else None
    wt = TableSpec("WINDOW SCHEDULE", wcols, ww, windows) if windows else None
    return dt, wt


def draw_schedule_sheet(sheet: Sheet, b: Building, size_column: bool = False):
    dt, wt = schedule_tables(b, size_column)
    y = mm(30)
    if dt:
        box = draw_table(sheet, mm(25), y, dt)
        y = box[3] + mm(18)
    if wt:
        draw_table(sheet, mm(25), y, wt)
    sheet.text(mm(25), sheet.H - mm(30), "NOTE: ALL SIZES ARE NOMINAL STRUCTURAL OPENING SIZES.", 6.5)
