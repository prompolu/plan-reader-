"""Door / window / opening schedule extraction.

Schedules are used as a cross-reference. A schedule row is *type* data (size
and quantity per tag); it is never counted as a physical opening by itself.
"""

from __future__ import annotations

import re
import statistics

from .tags import parse_tag
from .types import BBox, PageClassification, PageData, ScheduleEntry, TextLine, View
from .units import find_expressions, normalize_chars, parse_dimension, parse_size

HEADER_ALIASES = {
    "tag": re.compile(r"^(MARK|TAG|NO\.?|NUMBER|REF\.?|ID|DOOR\s*(NO|MARK)\.?|WINDOW\s*(NO|MARK)\.?|CODE)$", re.I),
    "type": re.compile(r"^(TYPE|DESCRIPTION|DESC\.?|STYLE|OPERATION)$", re.I),
    "width": re.compile(r"^(WIDTH|W|WIDTH\s*\(MM\)|W\s*\(MM\))$", re.I),
    "height": re.compile(r"^(HEIGHT|H|HEIGHT\s*\(MM\)|H\s*\(MM\))$", re.I),
    "size": re.compile(r"^(SIZE|SIZE\s*\(W\s*[xX]\s*H\)|OPENING\s+SIZE|W\s*[xX]\s*H|NOMINAL\s+SIZE|SIZE\s*\(MM\))$", re.I),
    "qty": re.compile(r"^(QTY\.?|QUANTITY|NO\.?\s*OFF|COUNT|NUMBER\s+OFF)$", re.I),
    "sill": re.compile(r"^(SILL|SILL\s+HEIGHT|SILL\s+HT\.?)$", re.I),
    "remarks": re.compile(r"^(REMARKS|NOTES|COMMENTS|HARDWARE|FINISH|FRAME|GLAZING|LOCATION|ROOM)$", re.I),
}

RE_SCHEDULE_TITLE = re.compile(r"\b(DOOR|WINDOW|OPENING|DOOR\s*(?:AND|&)\s*WINDOW)S?\s+SCHEDULES?\b", re.I)


def _header_kind(text: str) -> str | None:
    t = normalize_chars(text).strip()
    for k, rx in HEADER_ALIASES.items():
        if rx.match(t):
            return k
    return None


def extract_schedules(page: PageData, views: list[View], cls: PageClassification) -> list[ScheduleEntry]:
    tb = cls.title_block
    lines = [ln for ln in page.lines if not (tb and tb.contains(ln.bbox, tol=2))]
    titles = [ln for ln in lines if RE_SCHEDULE_TITLE.search(ln.text) and len(ln.text) < 60]
    entries: list[ScheduleEntry] = []
    n = 0
    for title in titles:
        kind = "opening"
        t = title.text.upper()
        if "DOOR" in t and "WINDOW" not in t:
            kind = "door"
        elif "WINDOW" in t and "DOOR" not in t:
            kind = "window"
        header = _find_header(lines, title)
        if not header:
            continue
        cols = sorted(header, key=lambda h: h[1].bbox.x0)
        kinds = [k for k, _ in cols]
        if "tag" not in kinds or not ({"width", "height"} <= set(kinds) or "size" in kinds):
            continue
        hy = statistics.mean(h.bbox.cy for _, h in cols)
        row_h = statistics.median(h.bbox.h for _, h in cols)
        x_left = cols[0][1].bbox.x0 - 3 * row_h
        # column boundaries: from each header's left edge to the next header's left edge
        bounds = []
        for i, (k, h) in enumerate(cols):
            x0 = h.bbox.x0 - 0.6 * row_h
            x1 = cols[i + 1][1].bbox.x0 - 0.6 * row_h if i + 1 < len(cols) else h.bbox.x1 + 40 * row_h
            bounds.append((k, x0, x1))
        x_right = bounds[-1][2]
        body = [
            ln
            for ln in lines
            if ln.bbox.cy > hy + 0.6 * row_h and x_left <= ln.bbox.cx <= x_right and ln is not title and ln.axis == "h"
        ]
        body.sort(key=lambda ln: ln.bbox.cy)
        rows = _group_rows(body, row_h)
        # stop at the first large vertical gap or at another schedule title / header
        pitch = _row_pitch(rows)
        prev_y = hy
        for row in rows:
            ry = statistics.mean(ln.bbox.cy for ln in row)
            if ry - prev_y > max(3.5 * pitch, 6 * row_h):
                break
            if any(RE_SCHEDULE_TITLE.search(ln.text) for ln in row) or sum(1 for ln in row if _header_kind(ln.text)) >= 3:
                break
            prev_y = ry
            cells: dict[str, str] = {}
            cell_lines: dict[str, TextLine] = {}
            for ln in row:
                for k, x0, x1 in bounds:
                    if x0 <= ln.bbox.x0 + 0.5 < x1:
                        cells[k] = (cells.get(k, "") + " " + ln.text.strip()).strip()
                        cell_lines[k] = ln
                        break
            tag_txt = cells.get("tag", "")
            parsed = parse_tag(tag_txt)
            if not parsed:
                continue
            prefix, key, tag_text = parsed
            width = height = None
            unit = cls.default_unit
            if "size" in cells:
                pair = parse_size(cells["size"], unit)
                if pair:
                    width = pair[0].to_dict()
                    height = pair[1].to_dict()
            if width is None and "width" in cells:
                w = parse_dimension(cells["width"], unit)
                width = w.to_dict() if w else None
            if height is None and "height" in cells:
                h = parse_dimension(cells["height"], unit)
                height = h.to_dict() if h else None
            qty = None
            qtxt = cells.get("qty")
            if qtxt and re.fullmatch(r"\d{1,4}", qtxt.strip()):
                qty = int(qtxt.strip())
            rb = row[0].bbox
            for ln in row[1:]:
                rb = rb.union(ln.bbox)
            conf = 0.95 if ln.source == "pdf" else 0.85 * statistics.mean(x.confidence for x in row)
            if width is None or height is None:
                conf *= 0.85
            entries.append(
                ScheduleEntry(
                    id=f"p{page.index}-s{n}",
                    page_index=page.index,
                    schedule_kind=kind,
                    schedule_title=title.text.strip(),
                    tag=tag_text,
                    tag_key=key,
                    type_text=cells.get("type"),
                    width=width,
                    height=height,
                    quantity=qty,
                    quantity_text=qtxt,
                    remarks=cells.get("remarks"),
                    row_bbox=rb,
                    cells=cells,
                    confidence=conf,
                )
            )
            n += 1
    # the same row reached from two titles is kept once
    seen: set[tuple[str, int]] = set()
    uniq = []
    for e in entries:
        k = (e.tag_key, int(e.row_bbox.cy))
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq


def _find_header(lines: list[TextLine], title: TextLine) -> list[tuple[str, TextLine]] | None:
    """Header cells in the band just below the schedule title."""
    size = max(title.size, 1.0)
    cands = [
        ln
        for ln in lines
        if title.bbox.y1 - 2 < ln.bbox.cy < title.bbox.y1 + 12 * size and _header_kind(ln.text) and ln.bbox.x1 > title.bbox.x0 - 20 * size
    ]
    if not cands:
        return None
    # the header row is the first y-band below the title holding >= 3 header cells
    for c in sorted(cands, key=lambda ln: ln.bbox.cy):
        row = [x for x in cands if abs(x.bbox.cy - c.bbox.cy) < 0.6 * max(c.bbox.h, 1)]
        if len(row) >= 3:
            return [(_header_kind(ln.text), ln) for ln in row]  # type: ignore[misc]
    return None


def _group_rows(body: list[TextLine], row_h: float) -> list[list[TextLine]]:
    rows: list[list[TextLine]] = []
    for ln in body:
        if rows and abs(ln.bbox.cy - statistics.mean(x.bbox.cy for x in rows[-1])) < 0.55 * row_h:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    return rows


def _row_pitch(rows: list[list[TextLine]]) -> float:
    ys = [statistics.mean(ln.bbox.cy for ln in r) for r in rows]
    if len(ys) < 2:
        return 20.0
    return statistics.median(b - a for a, b in zip(ys, ys[1:]))


def schedule_type_kind(type_text: str | None, schedule_kind: str, tag_prefix: str) -> str | None:
    """Refine the opening kind from the schedule's TYPE column."""
    t = (type_text or "").upper()
    door_like = schedule_kind == "door" or tag_prefix in ("D", "SD", "GD", "DD", "FD", "ED", "RD")
    if re.search(r"\bGARAGE|\bROLLER|\bSECTIONAL|\bOVERHEAD|\bTILT", t):
        return "garage_door"
    if re.search(r"\bCURTAIN\s*WALL", t):
        return "curtain_wall"
    if re.search(r"\bSLID(ING|ER)|\bSTACKER|\bPOCKET", t):
        return "sliding_door" if door_like else "sliding_window"
    if re.search(r"\bDOUBLE|\bFRENCH|\bPAIR|\bBI-?PARTING", t) and door_like:
        return "double_door"
    return None
