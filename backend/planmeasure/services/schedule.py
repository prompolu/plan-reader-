"""Measurement schedule generation (used by the UI, print view and PDF export).

Always built from the current database state, i.e. the final user-edited and
verified values - never from a stale AI snapshot.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from ..models import Opening
from ..pipeline.types import OPENING_TYPE_LABELS
from ..pipeline.units import format_length

FAMILIES = [
    ("windows", "WINDOW SCHEDULE", {"window", "sliding_window", "curtain_wall"}),
    ("doors", "DOOR SCHEDULE", {"door", "double_door", "sliding_door", "garage_door"}),
    ("other", "OTHER OPENINGS", {"opening", "other"}),
]
GROUP_BY = ("type", "tag", "size", "page", "floor")


def family_of(t: str) -> tuple[str, str]:
    for key, title, kinds in FAMILIES:
        if t in kinds:
            return key, title
    return "other", "OTHER OPENINGS"


def measurement_text(m: dict | None, unit: str) -> tuple[str, str]:
    """(display text, status) for a measurement."""
    if m is None:
        return "Needs review", "missing"
    st = m.get("status")
    if st == "conflict":
        vals = " / ".join(f"{c['original_text']} ({c['label']})" for c in m.get("candidates", []))
        return f"Conflict: {vals}", "conflict"
    txt = format_length(m.get("value"), unit, m.get("original_text"))
    if st == "inferred":
        return f"{txt}*", "inferred"
    return txt, st or "explicit"


def _natural(tag: str | None):
    import re

    if not tag:
        return ("~", 10**9, "")
    m = re.match(r"([A-Za-z]+)\D*(\d+)(.*)", tag)
    return (m.group(1).upper(), int(m.group(2)), m.group(3)) if m else (tag, 0, "")


def row_for(o: Opening, unit: str) -> dict[str, Any]:
    wt, ws = measurement_text(o.width, unit)
    ht, hs = measurement_text(o.height, unit)
    sheets = []
    for inst in o.instances or []:
        s = inst.get("sheet")
        if s and s not in sheets:
            sheets.append(s)
    if not sheets and o.drawing_reference:
        sheets = [o.drawing_reference]
    return {
        "id": str(o.id),
        "ref": o.ref,
        "tag": o.tag or "—",
        "type": o.type,
        "type_label": OPENING_TYPE_LABELS.get(o.type, o.type),
        "width": wt,
        "height": ht,
        "width_mm": (o.width or {}).get("value"),
        "height_mm": (o.height or {}).get("value"),
        "width_status": ws,
        "height_status": hs,
        "quantity": o.quantity if o.quantity is not None else 0,
        "sheets": sheets,
        "drawing_reference": ", ".join(sheets) if sheets else "—",
        "floor": o.floor or "",
        "room": o.room or "",
        "status": o.status,
        "verified": o.verified,
        "notes": o.notes or "",
        "open_flags": [f["label"] for f in (o.flags or []) if f.get("severity") in ("warning", "error")] if not o.verified else [],
    }


def build_schedule(openings: list[Opening], group_by: str = "type", unit: str = "mm", include_unverified: bool = True) -> dict[str, Any]:
    if group_by not in GROUP_BY:
        group_by = "type"
    ops = [o for o in openings if o.deleted_at is None and (include_unverified or o.verified)]
    ops.sort(key=lambda o: (_natural(o.tag), o.ref))
    groups: list[dict[str, Any]] = []

    if group_by == "type":
        for key, title, kinds in FAMILIES:
            rows = [row_for(o, unit) for o in ops if o.type in kinds]
            if rows:
                groups.append({"key": key, "title": title, "rows": rows})
    elif group_by == "tag":
        rows = [row_for(o, unit) for o in ops]
        if rows:
            groups.append({"key": "all", "title": "OPENING SCHEDULE", "rows": rows})
    elif group_by == "size":
        for key, title, kinds in FAMILIES:
            merged: dict[tuple, dict[str, Any]] = {}
            for o in ops:
                if o.type not in kinds:
                    continue
                r = row_for(o, unit)
                k = (r["width"], r["height"], r["type"])
                if k in merged:
                    m = merged[k]
                    m["tag"] = f"{m['tag']}, {r['tag']}"
                    m["quantity"] += r["quantity"]
                    m["sheets"] = list(dict.fromkeys(m["sheets"] + r["sheets"]))
                    m["drawing_reference"] = ", ".join(m["sheets"]) or "—"
                    m["verified"] = m["verified"] and r["verified"]
                    m["open_flags"] += r["open_flags"]
                else:
                    merged[k] = dict(r)
            rows = sorted(merged.values(), key=lambda r: (r["width_mm"] or 0, r["height_mm"] or 0))
            if rows:
                groups.append({"key": key, "title": f"{title} — BY SIZE", "rows": rows})
    else:  # page / floor: quantities split by where the instances are
        attr = "sheet" if group_by == "page" else "floor"
        buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for o in ops:
            counts: dict[str, int] = defaultdict(int)
            for inst in o.instances or []:
                if inst.get("counted", True):
                    counts[inst.get(attr) or ("Unknown sheet" if attr == "sheet" else "Floor not identified")] += 1
            if not counts:
                label = (o.drawing_reference if attr == "sheet" else o.floor) or ("Unknown sheet" if attr == "sheet" else "Floor not identified")
                counts[label] = o.quantity or 0
            elif o.quantity is not None and sum(counts.values()) != o.quantity:
                # quantity edited by the user: keep the user's total, note the split is from the drawings
                pass
            for label, n in counts.items():
                r = row_for(o, unit)
                r["quantity"] = n
                buckets[label].append(r)
        for label in sorted(buckets, key=lambda s: (s.startswith("Unknown") or s.startswith("Floor not"), s)):
            groups.append({"key": label, "title": label.upper(), "rows": buckets[label]})

    for g in groups:
        g["total_quantity"] = sum(r["quantity"] for r in g["rows"])
    return {
        "group_by": group_by,
        "unit": unit,
        "groups": groups,
        "total_openings": sum(g["total_quantity"] for g in groups) if group_by not in ("page", "floor") else sum(o.quantity or 0 for o in ops),
        "unverified_count": sum(1 for o in ops if not o.verified),
        "needs_review_count": sum(1 for o in ops if o.status == "needs_review"),
        "has_inferred": any(r["width_status"] == "inferred" or r["height_status"] == "inferred" for g in groups for r in g["rows"]),
    }
