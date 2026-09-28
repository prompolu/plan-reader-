"""Drawing set generation: the demo project and randomised benchmark sets.

``build_set(building, ...)`` renders a complete drawing set to PDF bytes and
returns ground truth describing what is actually on the drawings.
"""

from __future__ import annotations

import io
import json
import random
from dataclasses import asdict, dataclass, field
from typing import Any

import pymupdf

from planmeasure.pipeline.units import approx_equal_mm

from .drawing import GREY, Sheet, TableSpec, View, draw_table, mm
from .house import (
    WINDOW_KINDS,
    Building,
    Floor,
    GTInstance,
    GTReference,
    OpeningType,
    Partition,
    Placement,
    Style,
    draw_elevation,
    draw_plan,
    draw_schedule_sheet,
    plan_counts,
)


@dataclass
class SetOptions:
    name: str = "Residential_Plans"
    include_cover: bool = True
    include_site: bool = True
    include_notes: bool = True
    include_elevations: bool = True
    include_section: bool = True
    include_enlarged: bool = True
    include_schedule: bool = True
    schedule_size_column: bool = False
    rotate_plan_pages: int = 0  # page /Rotate for plan sheets (0 or 90)
    plan_scale: float = 100
    paper: str = "A3"
    date: str = "2026-09-01"
    enlarged_region: tuple[float, float, float, float] | None = None
    enlarged_floor: int = 0
    enlarged_title: str = "ENLARGED BATHROOM PLAN"


@dataclass
class GroundTruth:
    set_name: str
    units: str
    pages: list[dict[str, Any]] = field(default_factory=list)
    instances: list[dict[str, Any]] = field(default_factory=list)
    references: list[dict[str, Any]] = field(default_factory=list)
    types: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


# ---------------------------------------------------------------------------
# Demo building
# ---------------------------------------------------------------------------


def demo_building() -> Building:
    T = 250.0
    types = {
        "W-01": OpeningType("W-01", "window", 1200, 1500, 900, "AWNING", schedule_qty=6),
        "W-02": OpeningType("W-02", "window", 1800, 1500, 900, "FIXED + AWNING"),
        "W-03": OpeningType("W-03", "window", 900, 1500, 900, "AWNING", schedule_height=1200),
        "W-04": OpeningType("W-04", "window", 600, 600, 1500, "OBSCURE AWNING", in_schedule=False),
        "W-05": OpeningType("W-05", "sliding_window", 1500, 1200, 900, "SLIDING"),
        "W-06": OpeningType("W-06", "window", 900, 900, 1200, "FIXED", schedule_qty=1),
        "W-07": OpeningType("W-07", "window", 900, 1200, 900, "INTERNAL GLAZED PANEL", in_schedule=False),
        "D-01": OpeningType("D-01", "door", 1020, 2100, 0, "ENTRY DOOR, SOLID CORE"),
        "D-02": OpeningType("D-02", "door", 820, 2040, 0, "INTERNAL HINGED"),
        "D-03": OpeningType("D-03", "double_door", 1600, 2100, 0, "GLAZED FRENCH DOORS"),
        "D-04": OpeningType("D-04", "door", 600, 2040, 0, "STORE", in_schedule=False),
        "SD-01": OpeningType("SD-01", "sliding_door", 2400, 2100, 0, "SLIDING GLASS DOOR"),
        "GD-01": OpeningType("GD-01", "garage_door", 2700, 2100, 0, "SECTIONAL GARAGE DOOR"),
        "OP-A": OpeningType(None, "opening", 1800, 2400, 0, "CASED OPENING", in_schedule=False),
    }
    gf = Floor(
        name="GROUND FLOOR",
        level=0.0,
        sheet_number="A-101",
        partitions=[
            Partition("P1", "y", 9000, T, 9500 - T),
            Partition("P2", "x", 5000, T, 9000 - 55),
            Partition("P3", "y", 3500, 5000 + 55, 9500 - T),
            Partition("P4", "x", 7000, 9000 + 55, 11500),
            Partition("P5", "y", 11500, 7000 + 55, 9500 - T),
        ],
        placements=[
            Placement("D-01", "S", 1200, elev_height_dim=True, elev_width_dim=True),
            Placement("W-01", "S", 3300, elev_width_dim=True),
            Placement("W-01", "S", 4800, elev_width_dim=True),
            Placement("W-02", "S", 6600, elev_width_dim=True),
            Placement("GD-01", "E", 3400, elev_height_dim=True),
            Placement("SD-01", "N", 4200, elev_height_dim=True),
            Placement("W-02", "N", 6900),
            Placement("W-01", "N", 11000),
            Placement("W-03", "W", 1800),
            Placement("D-03", "W", 3600, swing=1, elev_height_dim=True),
            Placement("W-04", "W", 6800),
            Placement("D-02", "P2", 1150, swing=1),
            Placement("OP-A", "P2", 4750),
            Placement("D-02", "P1", 1000, dim=False, swing=1),
            Placement("W-07", "P1", 6000, swing=-1),
            Placement("D-04", "P4", 800, dim=False, swing=-1),
        ],
        rooms=[
            ("LIVING", 4500, 2600),
            ("BATH", 1900, 7600),
            ("KITCHEN / DINING", 6200, 7900),
            ("GARAGE", 11500, 4300),
            ("STORE", 10300, 8300),
        ],
        chain_levels={"S": [900, 2400], "N": [900, 2400], "W": [900, 2400], "E": []},
    )
    ff = Floor(
        name="FIRST FLOOR",
        level=3000.0,
        sheet_number="A-102",
        partitions=[
            Partition("P1", "y", 7000, T, 9500 - T),
            Partition("P2", "x", 4500, T, 7000 - 55),
            Partition("P3", "x", 4500, 7000 + 55, 14000 - T),
        ],
        placements=[
            Placement("W-05", "S", 1500),
            Placement("W-05", "S", 4200, dup_tag=True),
            Placement("W-01", "S", 9000),
            Placement("W-01", "S", 11500),
            Placement("W-02", "N", 2000),
            Placement("W-04", "N", 10000),
            Placement("W-03", "E", 2000, elev_height_dim=True),
            Placement("D-02", "P1", 1200, swing=1),
            Placement("D-02", "P1", 6000, swing=1),
            Placement("D-02", "P3", 3000, swing=-1),
        ],
        rooms=[
            ("BEDROOM 1", 3500, 2400),
            ("BEDROOM 2", 3500, 7000),
            ("BEDROOM 3", 10500, 2400),
            ("BATH 2", 10500, 7000),
        ],
        chain_levels={"S": [900, 2100], "N": [900, 2400], "W": [], "E": []},
    )
    return Building(W=14000, D=9500, T=T, floors=[gf, ff], types=types)


# ---------------------------------------------------------------------------
# Sheet builders
# ---------------------------------------------------------------------------


def _title(sheet: Sheet, b: Building, title: str, number: str, scale: str, opts: SetOptions):
    units_note = (
        "ALL DIMENSIONS IN MILLIMETRES UNLESS NOTED OTHERWISE. DO NOT SCALE."
        if b.style.units == "metric"
        else "ALL DIMENSIONS IN FEET AND INCHES UNLESS NOTED OTHERWISE. DO NOT SCALE."
    )
    return sheet.frame_and_title_block(
        project=b.project, address=b.address, sheet_title=title, sheet_number=number, scale_text=scale, date=opts.date, units_note=units_note
    )


def _scale_text(b: Building, ratio: float) -> str:
    if b.style.units == "imperial":
        return {48: '1/4" = 1\'-0"', 96: '1/8" = 1\'-0"', 64: '3/16" = 1\'-0"', 24: '1/2" = 1\'-0"', 32: '3/8" = 1\'-0"'}[int(ratio)]
    return f"1:{int(ratio)}"


def _cover(doc, b: Building, sheets: list[tuple[str, str]], opts: SetOptions):
    s = Sheet(doc)
    _title(s, b, "COVER SHEET", "A-000", "NTS", opts)
    s.text(mm(30), mm(60), b.project, 28, "hebo")
    s.text(mm(30), mm(72), b.address, 12)
    s.text(mm(30), mm(82), "CONSTRUCTION ISSUE", 10)
    tbl = TableSpec("DRAWING LIST", ["SHEET", "TITLE"], [25, 90], [[n, t] for n, t in sheets])
    draw_table(s, mm(30), mm(110), tbl, 6.0)
    s.commit()


def _site(doc, b: Building, opts: SetOptions):
    s = Sheet(doc)
    _title(s, b, "SITE PLAN", "A-001", "1:500", opts)
    v = View(s, (mm(90), mm(200)), 500)
    lot = [(0, 0), (30000, 0), (30000, 40000), (0, 40000)]
    s.polyline([v.P(*p) for p in lot], 0.4, closed=True, dashes="[6 2 1 2] 0")
    bx, by = 8000, 12000
    s.rect(*v.P(bx, by), *v.P(bx + b.W, by + b.D), 0.8, fill=(0.85, 0.85, 0.85))
    v.dim_chain("x", [0, bx], by - 3000, by, style=b.style.dim_style)
    v.dim_chain("y", [0, by], bx - 3000, bx, style=b.style.dim_style)
    s.text(*v.P(15000, -5000), "HARBOUR STREET", 9, "hebo", align="center")
    c = v.P(26000, 35000)
    s.polyline([(c[0], c[1] - mm(8)), (c[0] - mm(3), c[1] + mm(3)), (c[0] + mm(3), c[1] + mm(3))], 0.5, closed=True)
    s.text(c[0], c[1] - mm(10), "N", 10, "hebo", align="center")
    s.view_title(mm(90), mm(225), "SITE PLAN", "1:500")
    s.commit()


def _notes(doc, b: Building, opts: SetOptions):
    s = Sheet(doc)
    _title(s, b, "GENERAL NOTES", "A-002", "NTS", opts)
    notes = [
        "GENERAL NOTES",
        "1. THESE DRAWINGS SHALL BE READ IN CONJUNCTION WITH ALL SPECIFICATIONS.",
        "2. CONTRACTOR TO VERIFY ALL DIMENSIONS ON SITE PRIOR TO COMMENCEMENT.",
        "3. ALL WINDOWS TO COMPLY WITH THE ENERGY EFFICIENCY REQUIREMENTS.",
        "4. GLAZING TO BATHROOMS TO BE OBSCURE GLASS.",
        "5. SMOKE ALARMS TO BE INSTALLED IN ACCORDANCE WITH THE BUILDING CODE.",
        "6. WET AREAS TO BE WATERPROOFED TO THE RELEVANT STANDARD.",
        "7. ALL TIMBER FRAMING TO BE TERMITE RESISTANT.",
        "8. REFER TO STRUCTURAL ENGINEER'S DRAWINGS FOR ALL FOOTING DETAILS.",
    ]
    y = mm(30)
    for i, n in enumerate(notes):
        s.text(mm(25), y, n, 12 if i == 0 else 8, "hebo" if i == 0 else "helv")
        y += mm(9 if i == 0 else 6.5)
    s.text(mm(25), y + mm(10), "SPECIFICATION SUMMARY", 12, "hebo")
    s.commit()


def _section(doc, b: Building, opts: SetOptions):
    s = Sheet(doc)
    _title(s, b, "SECTION A-A", "A-301", "1:100", opts)
    v = View(s, (mm(80), mm(190)), 100)
    s.line(v.P(-1500, 0), v.P(b.D + 1500, 0), 1.0)
    for i in range(len(b.floors) + 1):
        z = i * b.floor_height
        s.rect(*v.P(0, z - 200 if i else -200), *v.P(b.D, z), 0.4, fill=(0.7, 0.7, 0.7))
    s.rect(*v.P(0, 0), *v.P(b.T, b.top), 0.5)
    s.rect(*v.P(b.D - b.T, 0), *v.P(b.D, b.top), 0.5)
    levels = sorted({0.0, b.top} | {fl.level for fl in b.floors})
    v.dim_chain("y", levels, -1400, 0, style=b.style.dim_style)
    s.view_title(mm(80), mm(215), "SECTION A-A", "1:100")
    s.commit()


def build_set(b: Building, opts: SetOptions) -> tuple[bytes, GroundTruth]:
    doc = pymupdf.open()
    gt = GroundTruth(set_name=opts.name, units=b.style.units)
    scale_txt = _scale_text(b, opts.plan_scale)

    sheet_list: list[tuple[str, str]] = []
    if opts.include_site:
        sheet_list.append(("A-001", "SITE PLAN"))
    if opts.include_notes:
        sheet_list.append(("A-002", "GENERAL NOTES"))
    for fl in b.floors:
        sheet_list.append((fl.sheet_number, f"{fl.name} PLAN"))
    if opts.include_elevations:
        sheet_list += [("A-201", "NORTH & SOUTH ELEVATIONS"), ("A-202", "EAST & WEST ELEVATIONS")]
    if opts.include_section:
        sheet_list.append(("A-301", "SECTION A-A"))
    if opts.include_enlarged:
        sheet_list.append(("A-501", opts.enlarged_title))
    if opts.include_schedule:
        sheet_list.append(("A-601", "DOOR & WINDOW SCHEDULES"))

    def add_page(number: str, ptype: str, scale: float | None, floor: str | None = None, rotation: int = 0):
        gt.pages.append(
            {"index": doc.page_count - 1, "sheet_number": number, "page_type": ptype, "scale_ratio": scale, "floor": floor, "rotation": rotation}
        )

    if opts.include_cover:
        _cover(doc, b, sheet_list, opts)
        add_page("A-000", "cover", None)
    if opts.include_site:
        _site(doc, b, opts)
        add_page("A-001", "site_plan", 500)
    if opts.include_notes:
        _notes(doc, b, opts)
        add_page("A-002", "notes", None)

    plan_pages: list[int] = []
    for fl in b.floors:
        s = Sheet(doc, opts.paper)
        _title(s, b, f"{fl.name} PLAN", fl.sheet_number, scale_txt, opts)
        v = View(s, (mm(60), mm(50) + mm(b.D / opts.plan_scale) + mm(25)), opts.plan_scale)
        page_index = doc.page_count - 1
        insts = draw_plan(s, v, b, fl, page_index)
        s.view_title(mm(60), v.oy + mm(38), f"{fl.name} PLAN", scale_txt)
        s.text(s.W - mm(130), mm(40), "REFER TO DOOR AND WINDOW SCHEDULES ON A-601.", 6.5)
        s.text(s.W - mm(130), mm(45), "WINDOW TAGS SHOWN IN HEXAGONS, DOOR TAGS IN CIRCLES.", 6.5)
        s.commit()
        for gi in insts:
            gt.instances.append(asdict(gi))
        add_page(fl.sheet_number, "floor_plan", opts.plan_scale, fl.name)
        plan_pages.append(page_index)

    if opts.include_elevations:
        for number, sides in (("A-201", ("N", "S")), ("A-202", ("E", "W"))):
            s = Sheet(doc, opts.paper)
            title = "NORTH & SOUTH ELEVATIONS" if number == "A-201" else "EAST & WEST ELEVATIONS"
            _title(s, b, title, number, scale_txt, opts)
            page_index = doc.page_count - 1
            names = {"N": "NORTH ELEVATION", "S": "SOUTH ELEVATION", "E": "EAST ELEVATION", "W": "WEST ELEVATION"}
            top_paper = mm(b.top / opts.plan_scale)
            for i, side in enumerate(sides):
                ground_y = mm(30) + top_paper + i * (top_paper + mm(50))
                v = View(s, (mm(60), ground_y), opts.plan_scale)
                refs = draw_elevation(s, v, b, side, page_index)
                s.view_title(mm(60), ground_y + mm(22), names[side], scale_txt)
                for r in refs:
                    gt.references.append(asdict(r))
            s.commit()
            add_page(number, "elevation", opts.plan_scale)

    if opts.include_section:
        _section(doc, b, opts)
        add_page("A-301", "section", 100)

    if opts.include_enlarged:
        s = Sheet(doc)
        _title(s, b, opts.enlarged_title, "A-501", _scale_text(b, opts.plan_scale / 2), opts)
        fl = b.floors[opts.enlarged_floor]
        region = opts.enlarged_region or (-1600, 4600, 3700, b.D + 300)
        scale = opts.plan_scale / 2
        v = View(s, (mm(80) - mm(region[0] / scale), mm(60) + mm((region[3]) / scale)), scale)
        page_index = doc.page_count - 1
        insts = draw_plan(s, v, b, fl, page_index, clip=region, counted=False, exterior_dims=False)
        s.view_title(mm(80), mm(60) + mm((region[3] - region[1]) / scale) + mm(30), opts.enlarged_title, _scale_text(b, scale))
        s.commit()
        for gi in insts:
            d = asdict(gi)
            d["counted"] = False
            gt.references.append(
                {
                    "type_key": gi.type_key,
                    "tag": gi.tag,
                    "page_index": page_index,
                    "view": "detail",
                    "bbox": gi.gap_bbox,
                    "height_dim_text": None,
                    "width_dim_text": gi.width_dim_text,
                    "height_explicit": False,
                }
            )
        add_page("A-501", "detail", scale)

    if opts.include_schedule:
        s = Sheet(doc)
        _title(s, b, "DOOR & WINDOW SCHEDULES", "A-601", "NTS", opts)
        draw_schedule_sheet(s, b, opts.schedule_size_column)
        s.commit()
        add_page("A-601", "opening_schedule", None)

    # page rotation for plan sheets (tests rotated-page handling)
    if opts.rotate_plan_pages:
        for pi in plan_pages:
            page = doc[pi]
            page.set_rotation(opts.rotate_plan_pages)
            m = page.rotation_matrix
            for inst in gt.instances:
                if inst["page_index"] == pi:
                    x0, y0, x1, y1 = inst["gap_bbox"]
                    r = pymupdf.Rect(x0, y0, x1, y1) * m
                    inst["gap_bbox"] = (r.x0, r.y0, r.x1, r.y1)
            for p in gt.pages:
                if p["index"] == pi:
                    p["rotation"] = opts.rotate_plan_pages

    gt.types = _type_truth(b, gt, opts)
    buf = io.BytesIO()
    doc.save(buf, garbage=3, deflate=True)
    doc.close()
    return buf.getvalue(), gt


def _type_truth(b: Building, gt: GroundTruth, opts: SetOptions) -> list[dict[str, Any]]:
    counts = plan_counts(b)
    out = []
    for key, ot in b.types.items():
        insts = [i for i in gt.instances if i["type_key"] == key and i["counted"]]
        refs = [r for r in gt.references if r["type_key"] == key]
        sched = opts.include_schedule and ot.in_schedule and ot.tag is not None
        s_w = (ot.schedule_width or ot.width) if sched else None
        s_h = (ot.schedule_height or ot.height) if sched else None
        s_q = (ot.schedule_qty if ot.schedule_qty is not None else counts.get(key, 0)) if sched else None

        def status(values: list[float], drawn: bool, true_value: float) -> tuple[str, float | list[float] | None]:
            uniq: list[float] = []
            for v in values:
                if not any(approx_equal_mm(v, u) for u in uniq):
                    uniq.append(v)
            if len(uniq) > 1:
                return "conflict", sorted(uniq)
            if len(uniq) == 1:
                return "explicit", uniq[0]
            if drawn:
                return "inferred", true_value
            return "missing", None

        w_vals = [ot.width for i in insts if i["width_dim_text"]]
        w_vals += [ot.width for r in refs if r["width_dim_text"]]
        if s_w is not None:
            w_vals.append(s_w)
        h_vals = [ot.height for r in refs if r["height_explicit"]]
        if s_h is not None:
            h_vals.append(s_h)
        ws, wv = status(w_vals, bool(insts) or any(r["view"] == "elevation" for r in refs), ot.width)
        elev = [r for r in refs if r["view"] == "elevation"]
        hs, hv = status(h_vals, bool(elev), ot.height)
        flags = []
        if ws in ("conflict",) or hs == "conflict":
            flags.append("dimension_conflict")
        if ws == "missing":
            flags.append("missing_width")
        if hs == "missing":
            flags.append("missing_height")
        if ws == "inferred" or hs == "inferred":
            flags.append("scale_inferred")
        qty = len(insts)
        if sched and qty == 0:
            flags.append("schedule_only")
        elif sched and s_q is not None and s_q != qty:
            flags.append("quantity_conflict")
        if any(i["dup_tag"] for i in insts):
            flags.append("possible_duplicate")
        if ot.tag is None:
            flags.append("unclear_tag")
        out.append(
            {
                "type_key": key,
                "tag": ot.tag,
                "kind": ot.kind,
                "width_mm": ot.width,
                "height_mm": ot.height,
                "width_status": ws,
                "width_expected": wv,
                "height_status": hs,
                "height_expected": hv,
                "quantity": qty,
                "schedule_quantity": s_q,
                "in_schedule": sched,
                "expected_flags": flags,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def demo_set() -> tuple[bytes, GroundTruth]:
    return build_set(demo_building(), SetOptions(name="Residential_Plans"))


def random_building(seed: int) -> tuple[Building, SetOptions]:
    """A randomised single- or two-storey building for the benchmark."""
    rng = random.Random(seed)
    imperial = rng.random() < 0.3
    units = "imperial" if imperial else "metric"

    def q(v: float) -> float:
        # metric sizes in 10 mm steps; imperial sizes in whole inches
        return round(v / 25.4) * 25.4 if imperial else round(v / 10) * 10

    T = q(rng.choice([230, 250, 300]))
    W = q(rng.uniform(11000, 16000))
    D = q(rng.uniform(8000, 11000))
    style = Style(
        dim_style=rng.choice(["tick", "tick", "arrow", "dot"]),
        continuous=rng.random() < 0.3,
        window_tag=rng.choice(["hexagon", "rect", "diamond"]),
        door_tag=rng.choice(["circle", "circle", "rect"]),
        units=units,
    )
    fmt_tag = rng.choice(["{p}-{n:02d}", "{p}{n:02d}", "{p}{n}", "{p}-{n}"])

    def tag(p: str, n: int) -> str:
        return fmt_tag.format(p=p, n=n)

    types: dict[str, OpeningType] = {}
    nwin = rng.randint(3, 5)
    for i in range(1, nwin + 1):
        w = q(rng.choice([600, 900, 1200, 1500, 1800, 2100]))
        h = q(rng.choice([600, 900, 1200, 1500, 1800]))
        sill = q(rng.choice([600, 900, 1200]) if h <= 1500 else 600)
        kind = "sliding_window" if rng.random() < 0.2 else "window"
        types[f"W{i}"] = OpeningType(tag("W", i), kind, w, h, sill, "SLIDING" if kind == "sliding_window" else "AWNING")
    ndoor = rng.randint(2, 3)
    for i in range(1, ndoor + 1):
        w = q(rng.choice([720, 820, 870, 920, 1020]))
        types[f"D{i}"] = OpeningType(tag("D", i), "door", w, q(rng.choice([2040, 2100, 2340])), 0, "HINGED")
    if rng.random() < 0.6:
        types["SD1"] = OpeningType(tag("SD", 1), "sliding_door", q(rng.choice([1800, 2100, 2400])), q(2100), 0, "SLIDING DOOR")
    if rng.random() < 0.4:
        types["DD1"] = OpeningType(tag("D", ndoor + 1), "double_door", q(rng.choice([1500, 1600, 1800])), q(2100), 0, "FRENCH DOORS")
    # scenario knobs
    keys = list(types)
    for k in keys:
        if rng.random() < 0.15:
            types[k].in_schedule = False
    if rng.random() < 0.4:
        k = rng.choice([k for k in keys if k.startswith("W")])
        types[k].schedule_height = q(types[k].height + rng.choice([-300, 300]))
    if rng.random() < 0.3:
        k = rng.choice(keys)
        types[k].schedule_qty = rng.randint(1, 6)

    # placements on exterior walls (single storey + partition)
    placements: list[Placement] = []
    px = q(W * rng.uniform(0.45, 0.6))
    partitions = [Partition("P1", "y", px, T, D - T)]
    ext_types = [k for k in types if types[k].kind != "door" or rng.random() < 0.5]
    for wall, length in (("S", W), ("N", W), ("W", D), ("E", D)):
        cursor = q(rng.uniform(600, 1200))
        while True:
            k = rng.choice(ext_types)
            w = types[k].width
            if cursor + w > length - 700:
                break
            # keep openings clear of the partition junction
            if wall in ("S", "N") and cursor - 300 < px < cursor + w + 300:
                cursor = q(px + 400)
                continue
            placements.append(
                Placement(
                    k,
                    wall,
                    cursor,
                    dim=rng.random() < 0.8,
                    elev_height_dim=rng.random() < 0.5,
                    elev_width_dim=wall == "S" and rng.random() < 0.5,
                    dup_tag=rng.random() < 0.04,
                )
            )
            cursor = q(cursor + w + rng.uniform(500, 2200))
    door_keys = [k for k in types if types[k].kind == "door"]
    for off in (rng.uniform(800, 2000), rng.uniform(D - T - 2500, D - T - 1500)):
        placements.append(Placement(rng.choice(door_keys), "P1", q(off), dim=rng.random() < 0.7, swing=rng.choice([-1, 1])))
    fl = Floor(
        name="GROUND FLOOR",
        level=0.0,
        sheet_number="A-101",
        placements=placements,
        partitions=partitions,
        rooms=[("LIVING", px / 2, D / 2), ("BEDROOM", (px + W) / 2, D / 2)],
    )
    # level chain: the most common sill/head per facade
    for side in ("S", "N", "E", "W"):
        wins = [types[p.type_key] for p in placements if p.wall == side and types[p.type_key].kind in WINDOW_KINDS]
        if wins and rng.random() < 0.7:
            ot = wins[0]
            fl.chain_levels[side] = [ot.sill, ot.sill + ot.height]
    b = Building(W=W, D=D, T=T, floors=[fl], types=types, style=style)
    b.address = f"LOT {seed}, BENCHMARK AVENUE"
    ratio = rng.choice([48, 48, 64]) if imperial else rng.choice([50, 100, 100])
    if not imperial and ratio == 50 and (W > 14000):
        ratio = 100
    opts = SetOptions(
        name=f"bench_{seed:03d}",
        include_cover=rng.random() < 0.5,
        include_site=False,
        include_notes=False,
        include_elevations=rng.random() < 0.8,
        include_section=False,
        include_enlarged=False,
        include_schedule=rng.random() < 0.8,
        schedule_size_column=rng.random() < 0.4,
        rotate_plan_pages=90 if rng.random() < 0.15 else 0,
        plan_scale=ratio,
    )
    if ratio <= 50 or (imperial and W > 12000):
        opts.paper = "A2"
    return b, opts
