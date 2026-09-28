"""Page classification: page type, sheet number/title, floor, unit convention.

Signals are combined into per-type scores; the sheet title in the title block
weighs most, then view titles, then content features (door swings, tables,
text density). Every signal is recorded for transparency.
"""

from __future__ import annotations

import re
import statistics
from collections import defaultdict

from .types import BBox, PageClassification, PageData, TextLine

RE_SHEET_NUMBER = re.compile(r"^(?:[A-Z]{1,3}[-.\s]?\d{1,4}(?:\.\d{1,3})?[A-Z]?)$")
TITLE_BLOCK_LABELS = re.compile(
    r"^(SHEET(\s+(NO|NUMBER|TITLE))?\.?|DRAWING\s+(NO|NUMBER|TITLE)\.?|DWG\.?\s*NO\.?|SCALE|DATE|REV(ISION)?\.?|PROJECT(\s+NO\.?)?|DRAWN(\s+BY)?|CHECKED(\s+BY)?|CLIENT|TITLE|JOB\s+NO\.?)[:.]?$",
    re.IGNORECASE,
)

# (type, regex, weight-multiplier). Order matters for overlapping phrases.
TYPE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("site_plan", re.compile(r"\b(SITE\s+PLAN|LOCATION\s+PLAN|SITE\s+ANALYSIS|BLOCK\s+PLAN)\b", re.I)),
    ("opening_schedule", re.compile(r"\b(OPENING\s+SCHEDULE|DOOR\s*(?:AND|&|/)\s*WINDOW\s+SCHEDULES?|WINDOW\s*(?:AND|&|/)\s*DOOR\s+SCHEDULES?)\b", re.I)),
    ("door_schedule", re.compile(r"\bDOOR\s+SCHEDULE\b", re.I)),
    ("window_schedule", re.compile(r"\bWINDOW\s+SCHEDULE\b", re.I)),
    ("detail", re.compile(r"\b(DETAILS?|ENLARGED\s+\w+(\s+\w+)?\s+PLAN|ENLARGED\s+PLAN|PART\s+PLAN)\b", re.I)),
    ("elevation", re.compile(r"\bELEVATIONS?\b", re.I)),
    ("section", re.compile(r"\bSECTIONS?\b(?!\s+\d)", re.I)),
    ("cover", re.compile(r"\b(COVER\s+(SHEET|PAGE)|TITLE\s+SHEET|DRAWING\s+(LIST|INDEX|REGISTER)|SHEET\s+INDEX)\b", re.I)),
    ("notes", re.compile(r"\b(GENERAL\s+NOTES|NOTES|SPECIFICATIONS?|LEGEND|ABBREVIATIONS)\b", re.I)),
    (
        "floor_plan",
        re.compile(
            r"\b((GROUND|FIRST|SECOND|THIRD|FOURTH|UPPER|LOWER|MAIN|BASEMENT|MEZZANINE|ATTIC)\s+(FLOOR|LEVEL)(\s+PLAN)?|FLOOR\s+PLAN|LEVEL\s+\d+\s+PLAN|L\d+\s+PLAN|\bPLAN\b)",
            re.I,
        ),
    ),
]

SHEET_PREFIX_HINT = [
    (re.compile(r"^A[-.\s]?0"), "cover", 0.2),
    (re.compile(r"^A[-.\s]?1"), "floor_plan", 0.5),
    (re.compile(r"^A[-.\s]?2"), "elevation", 0.5),
    (re.compile(r"^A[-.\s]?3"), "section", 0.5),
    (re.compile(r"^A[-.\s]?5"), "detail", 0.4),
    (re.compile(r"^A[-.\s]?6"), "opening_schedule", 0.4),
]

FLOOR_PATTERNS = [
    (re.compile(r"\bBASEMENT\b", re.I), "Basement"),
    (re.compile(r"\bGROUND\s+(FLOOR|LEVEL)\b", re.I), "Ground Floor"),
    (re.compile(r"\bFIRST\s+(FLOOR|LEVEL)\b", re.I), "First Floor"),
    (re.compile(r"\bSECOND\s+(FLOOR|LEVEL)\b", re.I), "Second Floor"),
    (re.compile(r"\bTHIRD\s+(FLOOR|LEVEL)\b", re.I), "Third Floor"),
    (re.compile(r"\bMEZZANINE\b", re.I), "Mezzanine"),
    (re.compile(r"\bROOF\s+PLAN\b", re.I), "Roof"),
    (re.compile(r"\bLEVEL\s+0?(\d{1,2})\b", re.I), "Level {0}"),
    (re.compile(r"\bL0?(\d{1,2})\s+PLAN\b", re.I), "Level {0}"),
    (re.compile(r"\bUPPER\s+FLOOR\b", re.I), "Upper Floor"),
    (re.compile(r"\bLOWER\s+FLOOR\b", re.I), "Lower Floor"),
]

UNIT_NOTES = [
    (re.compile(r"\b(IN\s+)?MILLIMET(RE|ER)S?\b|\bDIMENSIONS\s+(ARE\s+)?IN\s+MM\b", re.I), "mm"),
    (re.compile(r"\bDIMENSIONS\s+(ARE\s+)?IN\s+METRES?\b|\bIN\s+METERS\b", re.I), "m"),
    (re.compile(r"\bFEET\s+AND\s+INCHES\b|\bIN\s+FEET\b|\bIMPERIAL\b", re.I), "in"),
]

SCHEDULE_HEADERS = re.compile(r"^(MARK|TAG|NO\.?|REF\.?|ID|TYPE|WIDTH|HEIGHT|SIZE|QTY|QUANTITY|SILL|REMARKS|NOTES|FRAME|FINISH|HARDWARE|W|H)$", re.I)


def detect_title_block(page: PageData) -> BBox | None:
    """Locate the title block from its field labels (SHEET, SCALE, DATE ...)."""
    labels = [ln for ln in page.lines if TITLE_BLOCK_LABELS.match(ln.text.strip())]
    if len(labels) < 2:
        return None
    # the title block is the densest cluster of labels, usually near the right/bottom edge
    best = None
    for anchor in labels:
        near = [ln for ln in labels if ln.bbox.distance_to(anchor.bbox) < 0.25 * max(page.width, page.height)]
        if best is None or len(near) > len(best):
            best = near
    assert best
    bb = best[0].bbox
    for ln in best[1:]:
        bb = bb.union(ln.bbox)
    # prefer an enclosing ruled rectangle when there is one
    rect = None
    for r in page.geometry.rects:
        if r.contains(bb, tol=1.0) and r.area < 0.35 * page.width * page.height:
            if rect is None or r.area < rect.area:
                rect = r
    if rect is None:
        # grow to include text immediately around the labels (values under labels, firm name, ...)
        grow = bb.expand(0.06 * max(page.width, page.height))
        members = [ln for ln in page.lines if grow.contains(ln.bbox)]
        for ln in members:
            bb = bb.union(ln.bbox)
        segs = [s for s in page.geometry.segments if s.length > 20 and grow.contains(s.bbox)]
        for s in segs:
            bb = bb.union(s.bbox)
        return bb
    # the box may be split into cells; take the union of cells that share its outer frame
    return _grow_to_frame(page, rect)


def _grow_to_frame(page: PageData, rect: BBox) -> BBox:
    out = rect
    changed = True
    while changed:
        changed = False
        for r in page.geometry.rects:
            if r is rect or r.area > 0.35 * page.width * page.height:
                continue
            if r.intersection_area(out) > 0 or out.distance_to(r) < 1.0:
                u = out.union(r)
                if u.area < 0.35 * page.width * page.height and (u.x0, u.y0, u.x1, u.y1) != (out.x0, out.y0, out.x1, out.y1):
                    out = u
                    changed = True
    # include the text inside
    return out


def _lines_in(page: PageData, box: BBox | None) -> list[TextLine]:
    if box is None:
        return []
    return [ln for ln in page.lines if box.contains(ln.bbox, tol=1.0)]


def sheet_number_and_title(page: PageData, tb: BBox | None) -> tuple[str | None, str | None, TextLine | None]:
    lines = _lines_in(page, tb)
    number = None
    number_line = None
    cands = [ln for ln in lines if RE_SHEET_NUMBER.match(ln.text.strip()) and not re.match(r"^\d", ln.text.strip())]
    cands = [ln for ln in cands if not re.match(r"^(REV|NO)\b", ln.text.strip(), re.I)]
    if cands:
        # prefer the one right below/after a SHEET / DRAWING NO label, else the largest font
        labelled = []
        for c in cands:
            for lab in lines:
                if re.match(r"^(SHEET|DRAWING\s+NO|DWG)", lab.text.strip(), re.I) and 0 <= c.bbox.cy - lab.bbox.cy < 6 * max(lab.size, 1) and abs(c.bbox.x0 - lab.bbox.x0) < 40:
                    labelled.append(c)
        pool = labelled or cands
        number_line = max(pool, key=lambda ln: ln.size)
        number = re.sub(r"\s+", "", number_line.text.strip())
    title = None
    title_cands = []
    for ln in lines:
        t = ln.text.strip()
        if ln is number_line or TITLE_BLOCK_LABELS.match(t) or len(t) < 4 or not re.search(r"[A-Za-z]{3}", t):
            continue
        score = ln.size
        if any(p.search(t) for _, p in TYPE_PATTERNS):
            score += 20
        # a label "DRAWING TITLE"/"TITLE" right above it
        for lab in lines:
            if re.match(r"^(DRAWING\s+TITLE|SHEET\s+TITLE|TITLE)$", lab.text.strip(), re.I) and 0 < ln.bbox.cy - lab.bbox.cy < 5 * max(lab.size, 1):
                score += 30
        title_cands.append((score, ln))
    if title_cands:
        title = max(title_cands, key=lambda t: t[0])[1].text.strip()
    return number, title, number_line


def detect_floor(texts: list[str]) -> str | None:
    for t in texts:
        for rx, label in FLOOR_PATTERNS:
            m = rx.search(t)
            if m:
                if "{0}" in label:
                    return label.format(int(m.group(1)))
                return label
    return None


def find_view_titles(page: PageData, tb: BBox | None) -> list[TextLine]:
    """Headline text outside the title block that names a view (PLAN, ELEVATION, ...)."""
    sizes = [ln.size for ln in page.lines if ln.size > 0]
    if not sizes:
        return []
    med = statistics.median(sizes)
    out = []
    for ln in page.lines:
        if tb is not None and tb.contains(ln.bbox, tol=2.0):
            continue
        t = ln.text.strip()
        if len(t) < 4 or len(t) > 60:
            continue
        if not any(p.search(t) for _, p in TYPE_PATTERNS):
            continue
        underlined = any(
            s.orientation() == "h"
            and 0 < s.y0 - ln.bbox.y1 < 0.8 * max(ln.size, 1)
            and s.x0 <= ln.bbox.x0 + 2
            and s.x1 >= ln.bbox.x1 - 2
            for s in page.geometry.segments
            if abs(s.y0 - ln.bbox.y1) < 2 * max(ln.size, 1)
        )
        if ln.size >= 1.25 * med or underlined:
            out.append(ln)
    return out


def classify_type_from_text(t: str) -> str | None:
    for typ, rx in TYPE_PATTERNS:
        if rx.search(t):
            return typ
    return None


def detect_default_unit(page: PageData, scale_texts: list[str]) -> tuple[str, str]:
    for ln in page.lines:
        for rx, unit in UNIT_NOTES:
            if rx.search(ln.text):
                return unit, "note"
    for s in scale_texts:
        if s and ":" in s:
            return "mm", "scale"
        if s and "=" in s:
            return "in", "scale"
    # imperial notation present in the text -> feet/inches drawing
    imperial = sum(1 for ln in page.lines if re.search(r"\d'\s*-?\s*\d+\"", ln.text))
    if imperial >= 3:
        return "in", "notation"
    return "mm", "assumed"


def classify_page(page: PageData, scale_texts: list[str] | None = None) -> PageClassification:
    tb = detect_title_block(page)
    number, title, _ = sheet_number_and_title(page, tb)
    scores: dict[str, float] = defaultdict(float)
    signals: list[dict] = []

    def add(typ: str, w: float, code: str, detail: str):
        scores[typ] += w
        signals.append({"type": typ, "weight": round(w, 2), "code": code, "detail": detail})

    if title:
        typ = classify_type_from_text(title)
        if typ:
            add(typ, 3.0, "sheet_title", f'Sheet title "{title}"')
    view_titles = find_view_titles(page, tb)
    seen_titles = 0
    kinds_in_titles = set()
    for vt in view_titles:
        typ = classify_type_from_text(vt.text)
        if typ:
            kinds_in_titles.add(typ)
            if seen_titles < 4:
                add(typ, 1.5, "view_title", f'View title "{vt.text.strip()}"')
                seen_titles += 1
    if {"door_schedule", "window_schedule"} <= kinds_in_titles:
        add("opening_schedule", 2.0, "view_title", "Both door and window schedules on sheet")

    # content features
    g = page.geometry
    n_arcs = sum(1 for a in g.arcs if 70 <= a.sweep_deg <= 110)
    if n_arcs >= 2:
        add("floor_plan", min(1.5, 0.3 * n_arcs), "door_swings", f"{n_arcs} door swing arcs")
    header_cells = [ln for ln in page.lines if SCHEDULE_HEADERS.match(ln.text.strip())]
    header_rows = defaultdict(int)
    for ln in header_cells:
        header_rows[round(ln.bbox.cy / 4)] += 1
    if header_rows and max(header_rows.values()) >= 3:
        add("opening_schedule", 1.5, "table_header", "Table header with MARK/WIDTH/HEIGHT columns")
    body = [ln for ln in page.lines if not (tb and tb.contains(ln.bbox, tol=2.0))]
    long_text = [ln for ln in body if len(ln.text) > 35]
    if len(long_text) >= 5 and len(long_text) > 0.35 * max(len(body), 1) and n_arcs == 0:
        add("notes", 1.2, "text_density", f"{len(long_text)} long text lines")
    if number:
        for rx, typ, w in SHEET_PREFIX_HINT:
            if rx.match(number):
                add(typ, w, "sheet_number", f"Sheet number {number} (discipline numbering convention)")
                break
    # body keyword mentions (weak: e.g. "REFER TO WINDOW SCHEDULE" on a plan)
    mention = defaultdict(int)
    for ln in body:
        typ = classify_type_from_text(ln.text)
        if typ:
            mention[typ] += 1
    for typ, c in mention.items():
        add(typ, min(0.6, 0.15 * c), "keyword", f"{c} mention(s) in drawing text")

    # schedule type refinement
    if scores.get("door_schedule", 0) and scores.get("window_schedule", 0):
        scores["opening_schedule"] += 0.5 * min(scores["door_schedule"], scores["window_schedule"])

    if not scores:
        page_type, conf = "other", 0.3
    else:
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        page_type, top = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        conf = min(0.99, 0.45 + 0.12 * top + 0.15 * (top - second) / max(top, 1e-6))
        if top < 1.0:
            conf = min(conf, 0.5)
    secondary = [t for t, s in sorted(scores.items(), key=lambda kv: -kv[1]) if t != page_type and s >= 1.0]
    texts = [title or ""] + [vt.text for vt in view_titles]
    floor = detect_floor(texts) if page_type in ("floor_plan", "detail") else None
    unit, basis = detect_default_unit(page, scale_texts or [])
    return PageClassification(
        page_type=page_type,
        confidence=conf,
        signals=signals,
        secondary_types=secondary,
        sheet_number=number,
        sheet_title=title,
        floor=floor,
        title_block=tb,
        default_unit=unit,
        unit_basis=basis,
    )
