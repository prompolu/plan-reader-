"""Cross-referencing across the drawing set.

* groups appearances of the same tag into one opening *type* record
* counts physical *instances* from floor plans only; elevations, sections,
  enlarged plans and schedules are *references* and are never counted again
* reconciles sizes from dimensions, callouts and schedules; disagreements are
  reported as conflicts and never resolved automatically
* detects duplicates (duplicate sheets, doubled tags, overlapping detections)
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from typing import Any

from .confidence import Thresholds, flag, needs_review, overall
from .schedules import schedule_type_kind
from .tags import tag_class
from .types import (
    OPENING_TYPE_LABELS,
    PAGE_TYPE_LABELS,
    BBox,
    DimensionAnnotation,
    OpeningDetection,
    ScheduleEntry,
    TagDetection,
    View,
    evidence,
)
from .units import approx_equal_mm, format_length

KIND_ORDER = ["window", "sliding_window", "curtain_wall", "door", "double_door", "sliding_door", "garage_door", "opening", "other"]


@dataclass
class PageContext:
    index: int
    page_type: str
    sheet_number: str | None
    sheet_title: str | None
    floor: str | None
    views: dict[str, View]
    poor_quality: bool = False
    quality_reasons: list[str] = field(default_factory=list)
    label: str = ""

    def ref(self) -> str:
        return self.sheet_number or f"Page {self.index + 1}"


@dataclass
class Appearance:
    det: OpeningDetection
    page: PageContext
    view: View | None
    counted: bool
    role: str  # "instance" | "reference"
    note: str | None = None


def _natural(tag: str | None) -> tuple:
    if not tag:
        return ("~", 10**9, "")
    m = re.match(r"([A-Z]+)\D*(\d+)(.*)", tag.upper())
    if not m:
        return (tag, 0, "")
    return (m.group(1), int(m.group(2)), m.group(3))


def _meas_candidate(d: DimensionAnnotation, score: float, signals: list, app: Appearance, role: str) -> dict[str, Any]:
    source = "explicit_dimension" if d.kind == "linear" else "callout"
    return {
        "value": d.value_mm,
        "unit": d.unit,
        "original_text": d.text,
        "source": source,
        "confidence": round(min(0.99, score), 3),
        "page_index": d.page_index,
        "sheet": app.page.ref(),
        "view_type": app.view.view_type if app.view else app.page.page_type,
        "view_title": app.view.title if app.view else None,
        "bbox": d.text_bbox.to_dict(),
        "dimension_id": d.id,
        "line": d.line.to_dict() if d.line else None,
        "extension_lines": [s.to_dict() for s in d.extension_lines],
        "unit_basis": d.unit_basis,
        "evidence": signals,
        "role": role,
        "chain_id": d.chain_id,
    }


def _schedule_candidate(e: ScheduleEntry, which: str, page: PageContext) -> dict[str, Any] | None:
    m = e.width if which == "width" else e.height
    if not m:
        return None
    return {
        "value": m["value_mm"],
        "unit": m["unit"],
        "original_text": m["original_text"],
        "source": "schedule",
        "confidence": round(e.confidence * 0.97, 3),
        "page_index": e.page_index,
        "sheet": page.ref(),
        "view_type": "schedule",
        "view_title": e.schedule_title,
        "bbox": e.row_bbox.to_dict(),
        "dimension_id": None,
        "line": None,
        "extension_lines": [],
        "unit_basis": "explicit" if m["unit_explicit"] else "schedule",
        "evidence": [
            evidence(
                "schedule_row",
                f"{e.schedule_title.title()} row {e.tag}: {which} {m['original_text']}",
                True,
                page_index=e.page_index,
                bbox=e.row_bbox,
                target=e.id,
            )
        ],
        "role": which,
    }


def _source_label(c: dict[str, Any]) -> str:
    if c["source"] == "schedule":
        return (c.get("view_title") or "Schedule").title()
    vt = PAGE_TYPE_LABELS.get(c.get("view_type") or "", "Drawing")
    return f"{vt} {c['sheet']}"


def reconcile(cands: list[dict[str, Any]], which: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Combine candidate values for one measurement. Returns (measurement, flags)."""
    flags: list[dict[str, Any]] = []
    if not cands:
        return None, flags
    clusters: list[list[dict[str, Any]]] = []
    for c in sorted(cands, key=lambda c: -c["confidence"]):
        for cl in clusters:
            if approx_equal_mm(cl[0]["value"], c["value"]):
                cl.append(c)
                break
        else:
            clusters.append([c])
    if len(clusters) == 1:
        cl = clusters[0]
        primary = max((c for c in cl if c["source"] != "schedule"), key=lambda c: c["confidence"], default=cl[0])
        # independent sources agreeing raise confidence (noisy-OR over source kinds)
        best_by_kind: dict[str, float] = {}
        for c in cl:
            best_by_kind[c["source"]] = max(best_by_kind.get(c["source"], 0.0), c["confidence"])
        miss = 1.0
        for v in best_by_kind.values():
            miss *= 1.0 - v
        pages = {c["page_index"] for c in cl}
        conf = 1.0 - miss + 0.01 * min(len(pages) - 1, 2)
        ev = list(primary["evidence"])
        for c in cl:
            if c is primary:
                continue
            ev.append(
                evidence(
                    "corroborated",
                    f"Confirmed by {_source_label(c)}: {c['original_text']}",
                    True,
                    page_index=c["page_index"],
                    bbox=BBox.from_dict(c["bbox"]) if c.get("bbox") else None,
                    target=c.get("dimension_id"),
                )
            )
        m = {k: primary[k] for k in ("value", "unit", "original_text", "source", "page_index", "sheet", "bbox", "dimension_id", "line", "extension_lines", "unit_basis", "view_type", "view_title")}
        m["status"] = "explicit"
        m["confidence"] = round(min(conf, 0.99), 3)
        m["evidence"] = ev
        m["candidates"] = [_cand_summary(c) for c in cl]
        if primary.get("unit_basis") == "assumed" and not any(c["unit_basis"] in ("explicit", "note", "scale") for c in cl):
            flags.append(flag("unit_assumed", f"{which.title()} {primary['original_text']} has no unit and no unit note was found; millimetres assumed"))
        return m, flags
    # conflict: show every source, decide nothing
    summ = [_cand_summary(c) for cl in clusters for c in cl]
    has_sched = any(c["source"] == "schedule" for cl in clusters for c in cl)
    parts = []
    for cl in clusters:
        labels = sorted({_source_label(c) for c in cl})
        parts.append(f"{', '.join(labels)}: {cl[0]['original_text']}")
    msg = f"{which.title()} conflict - " + " vs ".join(parts)
    code = "schedule_conflict" if has_sched else "dimension_conflict"
    flags.append(flag(code, msg, field=which, values=[cl[0]["value"] for cl in clusters]))
    m = {
        "value": None,
        "unit": clusters[0][0]["unit"],
        "original_text": None,
        "source": "conflict",
        "status": "conflict",
        "confidence": 0.0,
        "page_index": clusters[0][0]["page_index"],
        "sheet": clusters[0][0]["sheet"],
        "bbox": clusters[0][0]["bbox"],
        "dimension_id": clusters[0][0]["dimension_id"],
        "line": clusters[0][0]["line"],
        "extension_lines": clusters[0][0]["extension_lines"],
        "unit_basis": clusters[0][0]["unit_basis"],
        "evidence": [
            evidence(
                "conflict",
                f"{_source_label(cl[0])} says {cl[0]['original_text']}",
                False,
                page_index=cl[0]["page_index"],
                bbox=BBox.from_dict(cl[0]["bbox"]) if cl[0].get("bbox") else None,
                target=cl[0].get("dimension_id"),
            )
            for cl in clusters
        ],
        "candidates": summ,
    }
    return m, flags


def _cand_summary(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "value": c["value"],
        "unit": c["unit"],
        "original_text": c["original_text"],
        "source": c["source"],
        "label": _source_label(c),
        "confidence": c["confidence"],
        "page_index": c["page_index"],
        "sheet": c["sheet"],
        "bbox": c.get("bbox"),
        "dimension_id": c.get("dimension_id"),
    }


def _inferred(apps: list[Appearance], which: str, ctxs_known: bool = True) -> dict[str, Any] | None:
    key = "inferred_width_mm" if which == "width" else "inferred_height_mm"
    vals = [(a, a.det.features.get(key)) for a in apps if a.det.features.get(key)]
    if not vals:
        return None
    # prefer floor-plan instances for widths
    vals.sort(key=lambda t: (t[0].role != "instance", -t[0].det.confidence))
    a, v = vals[0]
    scale_text = a.det.features.get("scale_text") or "the drawing scale"
    conf = round(min(0.55, a.det.confidence * 0.6), 3)
    return {
        "value": float(v),
        "unit": "mm",
        "original_text": None,
        "source": "drawing_scale",
        "status": "inferred",
        "confidence": conf,
        "page_index": a.det.page_index,
        "sheet": a.page.ref(),
        "bbox": a.det.bbox.to_dict(),
        "dimension_id": None,
        "line": None,
        "extension_lines": [],
        "unit_basis": "scale",
        "view_type": a.view.view_type if a.view else a.page.page_type,
        "view_title": a.view.title if a.view else None,
        "evidence": [
            evidence(
                "scale_inferred",
                f"Inferred from drawing scale ({scale_text}) - no {which} dimension found",
                None,
                detail=f"Measured {format_length(v, 'mm')} between the opening edges on {a.page.ref()}",
                page_index=a.det.page_index,
                bbox=a.det.bbox,
            )
        ],
        "candidates": [],
    }


def build_records(
    pages: dict[int, PageContext],
    detections: list[OpeningDetection],
    orphan_tags: list[tuple[TagDetection, str]],
    dims: dict[str, DimensionAnnotation],
    schedules: list[ScheduleEntry],
    thresholds: Thresholds,
) -> list[dict[str, Any]]:
    # ---- duplicate plan sheets (same floor / same sheet number twice) ----
    plan_pages = [p for p in pages.values() if p.page_type == "floor_plan"]
    dup_sheet: dict[int, str] = {}
    seen_floor: dict[str, int] = {}
    seen_number: dict[str, int] = {}
    for p in sorted(plan_pages, key=lambda p: p.index):
        if p.sheet_number and p.sheet_number in seen_number:
            dup_sheet[p.index] = f"Sheet {p.sheet_number} appears more than once (pages {seen_number[p.sheet_number] + 1} and {p.index + 1})"
            continue
        if p.floor and p.floor in seen_floor:
            dup_sheet[p.index] = f"{p.floor} plan appears on {pages[seen_floor[p.floor]].ref()} and {p.ref()}"
            continue
        if p.sheet_number:
            seen_number[p.sheet_number] = p.index
        if p.floor:
            seen_floor[p.floor] = p.index

    apps: list[Appearance] = []
    for d in detections:
        pc = pages[d.page_index]
        view = pc.views.get(d.view_id or "")
        vt = view.view_type if view else pc.page_type
        if vt == "floor_plan" and not (view and view.enlarged):
            if d.page_index in dup_sheet:
                apps.append(Appearance(d, pc, view, False, "reference", note=dup_sheet[d.page_index]))
            else:
                apps.append(Appearance(d, pc, view, True, "instance"))
        elif vt in ("elevation", "detail", "section") or (view and view.enlarged):
            apps.append(Appearance(d, pc, view, False, "reference"))

    # ---- group by tag ----
    groups: dict[str, list[Appearance]] = {}
    untagged: list[Appearance] = []
    for a in apps:
        if a.det.tag is not None:
            groups.setdefault(a.det.tag.key, []).append(a)
        else:
            untagged.append(a)
    sched_by_key: dict[str, ScheduleEntry] = {}
    for e in schedules:
        sched_by_key.setdefault(e.tag_key, e)
    orphan_by_key: dict[str, list[tuple[TagDetection, str]]] = {}
    for t, vt in orphan_tags:
        orphan_by_key.setdefault(t.key, []).append((t, vt))

    keys = sorted(set(groups) | set(sched_by_key) | set(orphan_by_key))
    records: list[dict[str, Any]] = []
    for key in keys:
        records.append(
            _record(key, groups.get(key, []), sched_by_key.get(key), orphan_by_key.get(key, []), pages, dims, thresholds)
        )
    for a in untagged:
        if a.role == "reference":
            # an untagged opening on an elevation/detail cannot be tied to a plan opening;
            # it stays visible as a page detection but is not a separate countable record
            continue
        records.append(_record(None, [a], None, [], pages, dims, thresholds))

    records.sort(key=lambda r: (KIND_ORDER.index(r["type"]) if r["type"] in KIND_ORDER else 99, _natural(r["tag"]), r["page_index"] or 0))
    for i, r in enumerate(records, 1):
        r["ref"] = f"OPEN-{i:03d}"
    return records


def _record(
    key: str | None,
    group: list[Appearance],
    sched: ScheduleEntry | None,
    orphans: list[tuple[TagDetection, str]],
    pages: dict[int, PageContext],
    dims: dict[str, DimensionAnnotation],
    thr: Thresholds,
) -> dict[str, Any]:
    flags: list[dict[str, Any]] = []
    ev: list[dict[str, Any]] = []
    instances = sorted([a for a in group if a.role == "instance"], key=lambda a: (a.det.page_index, a.det.bbox.y, a.det.bbox.x))
    refs = [a for a in group if a.role == "reference"]

    # overlapping instances with the same tag on the same page -> one physical opening
    merged: list[Appearance] = []
    for a in instances:
        twin = next((m for m in merged if m.det.page_index == a.det.page_index and m.det.bbox.iou(a.det.bbox) > 0.3), None)
        if twin is not None:
            flags.append(flag("possible_duplicate", f"Two detections overlap at the same location on {a.page.ref()}; counted once", page_index=a.det.page_index))
            continue
        merged.append(a)
    instances = merged

    tag_text = None
    if instances and instances[0].det.tag:
        tag_text = instances[0].det.tag.text
    elif refs and refs[0].det.tag:
        tag_text = refs[0].det.tag.text
    elif sched:
        tag_text = sched.tag
    elif orphans:
        tag_text = orphans[0][0].text

    # tags found on plans with no opening geometry: still evidence of an opening
    geo_missing = []
    for t, vt in orphans:
        if vt == "floor_plan":
            geo_missing.append(t)
    if geo_missing:
        flags.append(
            flag(
                "geometry_not_found",
                f"Tag {tag_text} found on {', '.join(sorted({pages[t.page_index].ref() for t in geo_missing}))} but the opening symbol could not be located",
            )
        )

    # ---- kind ----
    votes: dict[str, float] = {}
    for a in instances + refs:
        w = 1.0 if a.role == "instance" else 0.4
        votes[a.det.kind] = votes.get(a.det.kind, 0) + w * a.det.confidence
    prefix = None
    if instances or refs:
        t0 = (instances + refs)[0].det.tag
        prefix = t0.prefix if t0 else None
    elif sched or orphans:
        m = re.match(r"([A-Z]+)", (tag_text or "").upper())
        prefix = m.group(1) if m else None
    tclass = tag_class(prefix) if prefix else None
    kind = max(votes, key=lambda k: votes[k]) if votes else (tclass or "other")
    sched_kind = schedule_type_kind(sched.type_text, sched.schedule_kind, prefix or "") if sched else None
    if tclass and tclass not in ("other",):
        family = "window" if tclass in ("window", "sliding_window", "curtain_wall") else ("door" if tclass in ("door", "double_door", "sliding_door", "garage_door") else "opening")
        geo_family = "window" if kind in ("window", "sliding_window", "curtain_wall") else ("door" if kind in ("door", "double_door", "sliding_door", "garage_door") else "opening")
        if family != geo_family and votes:
            if geo_family != "opening":
                flags.append(flag("unclear_type", f"Tag prefix '{prefix}' suggests a {family}, but the drawing symbol looks like a {OPENING_TYPE_LABELS.get(kind, kind).lower()}"))
            kind = tclass if tclass in OPENING_TYPE_LABELS else family
        elif tclass not in ("door", "window", "opening"):
            kind = tclass  # SD/GD/SW/CW prefixes are specific
    if sched_kind:
        kind = sched_kind
    if not votes and not tclass:
        flags.append(flag("unclear_type", "Opening type could not be determined"))

    # ---- measurements ----
    def cands_for(which: str) -> list[dict[str, Any]]:
        out = []
        for a in instances + refs:
            assoc = a.det.width_assoc if which == "width" else a.det.height_assoc
            if assoc is None:
                continue
            d = dims.get(assoc.dimension_id)
            if d is None:
                continue
            c = _meas_candidate(d, assoc.score * min(1.0, a.det.confidence + 0.1), assoc.signals, a, which)
            c["shared_with"] = assoc.shared_with
            out.append(c)
        if sched:
            sc = _schedule_candidate(sched, which, pages[sched.page_index])
            if sc:
                out.append(sc)
        return out

    measurements: dict[str, dict[str, Any] | None] = {}
    for which in ("width", "height"):
        m, fl = reconcile(cands_for(which), which)
        flags += fl
        if m is None:
            inf = _inferred(instances + refs, which)
            if inf is not None:
                m = inf
                flags.append(flag("scale_inferred", f"{which.title()} {format_length(inf['value'], 'mm')} inferred from drawing scale - no explicit dimension found"))
            else:
                flags.append(flag(f"missing_{which}", f"{which.title()} could not be determined from the drawings - needs review"))
        elif m["status"] == "explicit":
            weak = [e for e in m["evidence"] if e["code"] in ("ambiguous",)]
            if m["confidence"] < 0.65 or weak:
                flags.append(flag("uncertain_association", f"{which.title()} {m['original_text']} - dimension association is uncertain"))
            if any(e["code"] == "level_alignment" for e in m["evidence"]) and not any(c["source"] == "schedule" for c in m["candidates"]) and m["confidence"] < thr.high:
                flags.append(flag("uncertain_association", f"{which.title()} taken from a level dimension shared with other openings"))
        measurements[which] = m

    # ---- quantity ----
    n_inst = len(instances) + len(geo_missing)
    qty_basis = "plan_instances"
    if n_inst:
        qty = n_inst
    elif refs:
        elev = [a for a in refs if a.view and a.view.view_type == "elevation"]
        if elev and not any(a.note for a in refs):
            qty = len(elev)
            qty_basis = "elevation_references"
            flags.append(flag("counted_from_elevations", f"No floor-plan instance found; quantity {qty} counted from elevations"))
        else:
            qty = len([a for a in refs if a.note]) or 0
            qty_basis = "reference_only"
            flags.append(flag("reference_only", "Shown only on details/duplicate sheets - not located on a floor plan"))
    elif sched:
        qty = 0
        qty_basis = "schedule_only"
        flags.append(
            flag(
                "schedule_only",
                f"{sched.schedule_title.title()} lists {sched.tag}" + (f" (qty {sched.quantity})" if sched.quantity is not None else "") + " but it was not found on any drawing; not counted",
            )
        )
    else:
        qty = 0
        qty_basis = "none"
    if sched and sched.quantity is not None and qty_basis != "schedule_only" and sched.quantity != qty:
        flags.append(flag("quantity_conflict", f"Schedule quantity {sched.quantity} vs {qty} located on the drawings", schedule_quantity=sched.quantity, located=qty))

    # ---- duplicates ----
    for a in instances:
        dups = a.det.features.get("duplicate_tags") or []
        if dups:
            flags.append(flag("possible_duplicate", f"Tag {tag_text} is written {len(dups) + 1} times at one opening on {a.page.ref()}; counted once", page_index=a.det.page_index))
    for a in refs:
        if a.note:
            flags.append(flag("possible_duplicate", a.note + "; not counted again", page_index=a.det.page_index))

    # ---- tag ----
    tag_conf = None
    primary = instances[0] if instances else (refs[0] if refs else None)
    if primary and primary.det.tag:
        tag_conf = primary.det.tag_score
        if tag_conf < 0.7:
            flags.append(flag("unclear_tag", f"Tag {tag_text} association is uncertain"))
    elif key is None:
        flags.append(flag("unclear_tag", "No tag found for this opening"))
        tag_conf = 0.0
    elif sched:
        tag_conf = sched.confidence
    elif orphans:
        tag_conf = orphans[0][0].confidence

    # ---- poor quality pages ----
    for a in instances + refs:
        if a.page.poor_quality:
            flags.append(flag("poor_page_quality", f"{a.page.ref()} is a low-quality scan: {', '.join(a.page.quality_reasons) or 'unreliable'}", page_index=a.det.page_index))
            break

    # ---- evidence summary ----
    if primary:
        ev.append(evidence("source_page", f"Source: {primary.page.ref()} ({PAGE_TYPE_LABELS.get(primary.view.view_type if primary.view else primary.page.page_type, 'Drawing')})", True, page_index=primary.det.page_index, bbox=primary.det.bbox))
        ev.append(evidence("opening_detected", f"Opening detected ({OPENING_TYPE_LABELS.get(primary.det.kind, primary.det.kind)})", True, score=primary.det.confidence, page_index=primary.det.page_index, bbox=primary.det.bbox, target=primary.det.id))
        ev += primary.det.evidence
        ev += primary.det.tag_evidence
    for a in refs:
        vt = a.view.view_type if a.view else a.page.page_type
        ev.append(
            evidence(
                "reference",
                f"Also shown on {a.page.ref()} {a.view.title.title() if a.view and a.view.title else PAGE_TYPE_LABELS.get(vt, '')} - same opening, not counted again",
                None,
                page_index=a.det.page_index,
                bbox=a.det.bbox,
                target=a.det.id,
            )
        )
    if sched:
        ev.append(evidence("schedule", f"Listed in {sched.schedule_title.title()} on {pages[sched.page_index].ref()}", True, page_index=sched.page_index, bbox=sched.row_bbox, target=sched.id))

    # ---- confidence ----
    det_conf = max((a.det.confidence for a in instances), default=max((a.det.confidence for a in refs), default=None))
    if det_conf is None and orphans:
        det_conf = 0.35
    assoc_scores = []
    for which in ("width", "height"):
        m = measurements[which]
        if m and m["status"] == "explicit" and m["source"] != "schedule":
            assoc_scores.append(m["confidence"])
    conf = {
        "detection": round(det_conf, 3) if det_conf is not None else None,
        "tag": round(tag_conf, 3) if tag_conf is not None else None,
        "width": _mconf(measurements["width"]),
        "height": _mconf(measurements["height"]),
        "association": round(sum(assoc_scores) / len(assoc_scores), 3) if assoc_scores else None,
    }
    required_missing = any(measurements[w] is None or measurements[w]["status"] in ("conflict",) for w in ("width", "height"))
    conf["overall"] = overall(conf, required_missing)
    if conf["overall"] < thr.medium and not any(f["code"] in ("missing_width", "missing_height", "schedule_conflict", "dimension_conflict", "schedule_only") for f in flags):
        flags.append(flag("low_confidence", f"Overall confidence {conf['overall']:.0%} is below the review threshold"))

    # dedupe flags by (code, message)
    seen = set()
    uniq_flags = []
    for f in flags:
        k = (f["code"], f["message"])
        if k not in seen:
            seen.add(k)
            uniq_flags.append(f)

    floors = sorted({a.page.floor for a in instances if a.page.floor})
    inst_out = [
        {
            "detection_id": a.det.id,
            "page_index": a.det.page_index,
            "sheet": a.page.ref(),
            "floor": a.page.floor,
            "room": a.det.room,
            "bbox": a.det.bbox.to_dict(),
            "kind": a.det.kind,
            "confidence": round(a.det.confidence, 3),
            "tag_text": a.det.tag.text if a.det.tag else None,
            "tag_bbox": a.det.tag.bbox.to_dict() if a.det.tag else None,
            "width_text": dims[a.det.width_assoc.dimension_id].text if a.det.width_assoc and a.det.width_assoc.dimension_id in dims else None,
            "counted": True,
        }
        for a in instances
    ] + [
        {
            "detection_id": t.id,
            "page_index": t.page_index,
            "sheet": pages[t.page_index].ref(),
            "floor": pages[t.page_index].floor,
            "room": None,
            "bbox": t.bbox.to_dict(),
            "kind": kind,
            "confidence": 0.35,
            "tag_text": t.text,
            "tag_bbox": t.bbox.to_dict(),
            "width_text": None,
            "counted": True,
            "geometry_missing": True,
        }
        for t in geo_missing
    ]
    ref_out = [
        {
            "detection_id": a.det.id,
            "page_index": a.det.page_index,
            "sheet": a.page.ref(),
            "view_type": a.view.view_type if a.view else a.page.page_type,
            "view_title": a.view.title if a.view else None,
            "bbox": a.det.bbox.to_dict(),
            "kind": a.det.kind,
            "confidence": round(a.det.confidence, 3),
            "tag_text": a.det.tag.text if a.det.tag else None,
            "tag_bbox": a.det.tag.bbox.to_dict() if a.det.tag else None,
            "counted": False,
            "note": a.note,
        }
        for a in refs
    ]
    ppage = primary.det.page_index if primary else (geo_missing[0].page_index if geo_missing else (sched.page_index if sched else None))
    pbbox = primary.det.bbox.to_dict() if primary else (geo_missing[0].bbox.to_dict() if geo_missing else (sched.row_bbox.to_dict() if sched else None))
    return {
        "ref": "",
        "type": kind,
        "tag": tag_text,
        "tag_key": key,
        "width": measurements["width"],
        "height": measurements["height"],
        "quantity": qty,
        "quantity_basis": qty_basis,
        "page_index": ppage,
        "drawing_reference": pages[ppage].ref() if ppage is not None else None,
        "bbox": pbbox,
        "floor": ", ".join(floors) if floors else (instances[0].page.floor if instances else None),
        "room": primary.det.room if primary else None,
        "status": "needs_review" if needs_review(uniq_flags) else "extracted",
        "flags": uniq_flags,
        "evidence": ev,
        "confidence": conf,
        "instances": inst_out,
        "references": ref_out,
        "schedule": sched.to_dict() if sched else None,
        "source_detections": [a.det.id for a in instances + refs],
        "source": "ai",
    }


def _mconf(m: dict[str, Any] | None) -> float | None:
    if m is None:
        return 0.0
    return m["confidence"]
