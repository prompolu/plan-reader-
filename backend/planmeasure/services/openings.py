"""Opening records: serialisation, user edits, verification and re-extraction merges.

Integrity rules enforced here:

* the original AI result is kept in ``ai_snapshot`` and never modified by edits
* user edits are stored as ``source: user`` measurements and listed in ``edited_fields``
* re-extraction never overwrites edited or verified openings silently - the new
  AI result is parked in ``pending_ai`` until the user accepts or rejects it
* every change is written to the audit trail
"""

from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Opening, Page, Project
from ..pipeline.confidence import FLAG_INFO, Thresholds, flag, needs_review, overall
from ..pipeline.types import OPENING_TYPE_LABELS, OPENING_TYPES, BBox
from ..pipeline.units import MM_PER_UNIT, approx_equal_mm, format_length, parse_dimension
from . import audit

EDITABLE = {"type", "tag", "width", "height", "quantity", "page_index", "drawing_reference", "floor", "room", "notes"}
SNAPSHOT_FIELDS = ("type", "tag", "width", "height", "quantity", "quantity_basis", "page_index", "drawing_reference", "floor", "room", "confidence", "flags")


def now() -> datetime:
    return datetime.now(timezone.utc)


def thresholds_for(project: Project) -> Thresholds:
    return Thresholds.from_dict((project.settings or {}).get("thresholds"))


# ---------------------------------------------------------------------------
# serialisation
# ---------------------------------------------------------------------------


def _meas_summary(m: dict | None) -> dict | None:
    if not m:
        return None
    return {k: m.get(k) for k in ("value", "unit", "original_text", "source", "status", "confidence")}


def to_dict(o: Opening, users: dict[uuid.UUID, str] | None = None) -> dict[str, Any]:
    snap = o.ai_snapshot or {}
    pending = o.pending_ai
    return {
        "id": str(o.id),
        "ref": o.ref,
        "type": o.type,
        "type_label": OPENING_TYPE_LABELS.get(o.type, o.type),
        "tag": o.tag,
        "tag_key": o.tag_key,
        "width": o.width,
        "height": o.height,
        "quantity": o.quantity,
        "quantity_basis": o.quantity_basis,
        "page_id": str(o.page_id) if o.page_id else None,
        "page_index": o.page_index,
        "page": (o.page_index + 1) if o.page_index is not None else None,
        "drawing_reference": o.drawing_reference,
        "bbox": o.bbox,
        "floor": o.floor,
        "room": o.room,
        "status": o.status,
        "source": o.source,
        "confidence": o.confidence or {},
        "flags": o.flags or [],
        "evidence": o.evidence or [],
        "instances": o.instances or [],
        "references": o.references or [],
        "schedule": o.schedule,
        "source_detections": o.source_detections or [],
        "notes": o.notes or "",
        "edited_fields": o.edited_fields or [],
        "ai_original": {
            "type": snap.get("type"),
            "tag": snap.get("tag"),
            "width": _meas_summary(snap.get("width")),
            "height": _meas_summary(snap.get("height")),
            "quantity": snap.get("quantity"),
        }
        if snap
        else None,
        "pending_ai": {
            "type": pending.get("type"),
            "tag": pending.get("tag"),
            "width": _meas_summary(pending.get("width")),
            "height": _meas_summary(pending.get("height")),
            "quantity": pending.get("quantity"),
            "run_id": pending.get("run_id"),
        }
        if pending
        else None,
        "verification": {
            "verified": o.verified,
            "verified_by_user": bool(o.verified and o.verified_by),
            "verified_by": (users or {}).get(o.verified_by) if o.verified_by else None,
            "verified_at": o.verified_at.isoformat() if o.verified_at else None,
        },
        "version": o.version,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "updated_at": o.updated_at.isoformat() if o.updated_at else None,
    }


# ---------------------------------------------------------------------------
# status / flags
# ---------------------------------------------------------------------------


def refresh_status(o: Opening, thr: Thresholds) -> None:
    conf = dict(o.confidence or {})
    for f in ("width", "height"):
        m = getattr(o, f)
        if m is None:
            conf[f] = 0.0
        else:
            conf[f] = m.get("confidence", 0.0)
    required_missing = any(getattr(o, f) is None or getattr(o, f).get("status") == "conflict" for f in ("width", "height"))
    conf["overall"] = overall({k: v for k, v in conf.items() if k != "overall"}, required_missing)
    o.confidence = conf
    flags = [f for f in (o.flags or []) if f["code"] != "low_confidence"]
    if conf["overall"] < thr.medium and not any(
        f["code"] in ("missing_width", "missing_height", "schedule_conflict", "dimension_conflict", "schedule_only") for f in flags
    ):
        flags.append(flag("low_confidence", f"Overall confidence {conf['overall']:.0%} is below the review threshold"))
    o.flags = flags
    if o.verified:
        o.status = "verified"
    else:
        o.status = "needs_review" if needs_review(flags) else "extracted"


def _drop_field_flags(o: Opening, field: str) -> None:
    o.flags = [f for f in (o.flags or []) if f.get("field") != field]


# ---------------------------------------------------------------------------
# edits
# ---------------------------------------------------------------------------


class EditError(ValueError):
    pass


def parse_user_measurement(val: Any, default_unit: str = "mm") -> dict | None:
    """Accepts {"value": 1600, "unit": "mm"} or {"text": "5'-3\\""} or null."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        val = {"value": val, "unit": default_unit}
    if not isinstance(val, dict):
        raise EditError("measurement must be an object")
    if val.get("text"):
        p = parse_dimension(str(val["text"]), default_unit if default_unit in ("mm", "cm", "m", "in") else "mm")
        if p is None:
            raise EditError(f"Could not read a dimension from '{val['text']}'")
        value_mm, unit, text = p.value_mm, p.unit, str(val["text"]).strip()
    else:
        try:
            v = float(val["value"])
        except (KeyError, TypeError, ValueError):
            raise EditError("measurement value is required")
        unit = str(val.get("unit") or default_unit)
        factor = MM_PER_UNIT.get("in" if unit == "ft_in" else unit)
        if factor is None:
            raise EditError(f"unknown unit '{unit}'")
        value_mm = v * factor
        text = format_length(value_mm, unit if unit != "in" else "ft_in") if unit != "mm" else f"{v:g}"
    if not (10 <= value_mm <= 50000):
        raise EditError("measurement out of range (10 mm - 50 m)")
    return {"value": round(value_mm, 2), "unit": unit, "original_text": text}


def apply_edits(db: Session, project: Project, o: Opening, changes: dict[str, Any], user) -> list[str]:
    """Apply user edits; returns the list of fields that changed."""
    unknown = set(changes) - EDITABLE
    if unknown:
        raise EditError(f"fields not editable: {', '.join(sorted(unknown))}")
    thr = thresholds_for(project)
    changed: list[str] = []
    default_unit = (project.settings or {}).get("default_unit", "mm")
    for field, val in changes.items():
        if field in ("width", "height"):
            parsed = parse_user_measurement(val, default_unit)
            old = getattr(o, field)
            if parsed is None and old is None:
                continue
            if parsed is not None and old is not None and old.get("value") is not None and approx_equal_mm(old["value"], parsed["value"], rel=0, abs_mm=0.01) and old.get("source") == "user":
                continue
            new = None
            if parsed is not None:
                new = {
                    **parsed,
                    "source": "user",
                    "status": "user",
                    "confidence": 1.0,
                    "page_index": (old or {}).get("page_index"),
                    "bbox": (old or {}).get("bbox"),
                    "line": (old or {}).get("line"),
                    "evidence": [
                        {
                            "code": "user_edit",
                            "label": f"Entered by {user.name or user.email}",
                            "passed": True,
                            "detail": f"Previous value: {_fmt_meas(old)}",
                            "score": None,
                            "page_index": (old or {}).get("page_index"),
                            "bbox": (old or {}).get("bbox"),
                            "target": None,
                        }
                    ],
                    "previous": _meas_summary(old),
                    "candidates": (old or {}).get("candidates", []),
                }
            setattr(o, field, new)
            _drop_field_flags(o, field)
            audit.record(
                db,
                project.id,
                "user",
                "edit",
                f"User changed {field} from {_fmt_meas(old)} to {_fmt_meas(new)}",
                opening=o,
                user_id=user.id,
                field=field,
                old=_meas_summary(old),
                new=_meas_summary(new),
            )
            changed.append(field)
        elif field == "type":
            if val not in OPENING_TYPES:
                raise EditError(f"unknown opening type '{val}'")
            if val != o.type:
                audit.record(db, project.id, "user", "edit", f"User changed type from {OPENING_TYPE_LABELS.get(o.type, o.type)} to {OPENING_TYPE_LABELS[val]}", opening=o, user_id=user.id, field=field, old=o.type, new=val)
                o.type = val
                _drop_field_flags(o, "type")
                changed.append(field)
        elif field == "tag":
            val = (str(val).strip() or None) if val is not None else None
            if val and len(val) > 60:
                raise EditError("tag too long")
            if val != o.tag:
                audit.record(db, project.id, "user", "edit", f"User changed tag from {o.tag or '—'} to {val or '—'}", opening=o, user_id=user.id, field=field, old=o.tag, new=val)
                o.tag = val
                from ..pipeline.tags import parse_tag

                p = parse_tag(val) if val else None
                o.tag_key = p[1] if p else (val.upper() if val else None)
                _drop_field_flags(o, "tag")
                changed.append(field)
        elif field == "quantity":
            if val is not None:
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    raise EditError("quantity must be an integer")
                if not (0 <= val <= 100000):
                    raise EditError("quantity out of range")
            if val != o.quantity:
                audit.record(db, project.id, "user", "edit", f"User changed quantity from {o.quantity} to {val}", opening=o, user_id=user.id, field=field, old=o.quantity, new=val)
                o.quantity = val
                o.quantity_basis = "user"
                _drop_field_flags(o, "quantity")
                changed.append(field)
        elif field == "page_index":
            page = None
            if val is not None:
                page = db.scalar(select(Page).where(Page.project_id == project.id, Page.page_index == int(val)))
                if page is None:
                    raise EditError("page not found in this project")
            if (page.page_index if page else None) != o.page_index:
                audit.record(db, project.id, "user", "edit", f"User changed source page from {_pg(o.page_index)} to {_pg(page.page_index if page else None)}", opening=o, user_id=user.id, field=field, old=o.page_index, new=page.page_index if page else None)
                o.page_index = page.page_index if page else None
                o.page_id = page.id if page else None
                if page and not o.drawing_reference:
                    o.drawing_reference = page.sheet_number
                changed.append(field)
        else:  # drawing_reference, floor, room, notes
            val = (str(val) if val is not None else None)
            if val is not None and len(val) > (5000 if field == "notes" else 120):
                raise EditError(f"{field} too long")
            if field == "notes":
                val = val or ""
            cur = getattr(o, field)
            if val != cur:
                audit.record(db, project.id, "user", "edit", f"User changed {field.replace('_', ' ')} from {cur or '—'} to {val or '—'}" if field != "notes" else "User updated notes", opening=o, user_id=user.id, field=field, old=cur, new=val)
                setattr(o, field, val)
                changed.append(field)
    if changed:
        o.edited_fields = sorted(set(o.edited_fields or []) | set(changed) - {"notes"})
        if o.verified and set(changed) - {"notes"}:
            o.verified = False
            o.verified_at = None
            o.verified_by = None
            audit.record(db, project.id, "system", "unverify", "Verification cleared because the opening was edited", opening=o, user_id=user.id)
        o.version += 1
        refresh_status(o, thr)
    return changed


def resolve_conflict(db: Session, project: Project, o: Opening, field: str, candidate_index: int, user) -> None:
    m = getattr(o, field)
    if not m or m.get("status") != "conflict":
        raise EditError(f"{field} is not in conflict")
    cands = m.get("candidates") or []
    if not (0 <= candidate_index < len(cands)):
        raise EditError("invalid candidate")
    c = cands[candidate_index]
    new = {
        "value": c["value"],
        "unit": c["unit"],
        "original_text": c["original_text"],
        "source": "user",
        "status": "user",
        "confidence": 1.0,
        "page_index": c.get("page_index"),
        "bbox": c.get("bbox"),
        "dimension_id": c.get("dimension_id"),
        "evidence": [
            {
                "code": "conflict_resolved",
                "label": f"Conflict resolved by {user.name or user.email}: chose {c['label']} ({c['original_text']})",
                "passed": True,
                "detail": "Other sources: " + ", ".join(f"{x['label']} {x['original_text']}" for i, x in enumerate(cands) if i != candidate_index),
                "score": None,
                "page_index": c.get("page_index"),
                "bbox": c.get("bbox"),
                "target": c.get("dimension_id"),
            }
        ],
        "candidates": cands,
        "previous": _meas_summary(m),
    }
    setattr(o, field, new)
    _drop_field_flags(o, field)
    o.edited_fields = sorted(set(o.edited_fields or []) | {field})
    audit.record(
        db,
        project.id,
        "user",
        "resolve_conflict",
        f"User resolved {field} conflict: chose {c['label']} {c['original_text']}",
        opening=o,
        user_id=user.id,
        field=field,
        old={"candidates": [{"label": x["label"], "text": x["original_text"]} for x in cands]},
        new=_meas_summary(new),
    )
    o.verified = False
    o.version += 1
    refresh_status(o, thresholds_for(project))


def verify(db: Session, project: Project, o: Opening, user, verified: bool = True) -> None:
    if verified == o.verified:
        return
    o.verified = verified
    o.verified_by = user.id if verified else None
    o.verified_at = now() if verified else None
    o.version += 1
    audit.record(db, project.id, "user", "verify" if verified else "unverify", "User verified opening" if verified else "User removed verification", opening=o, user_id=user.id)
    refresh_status(o, thresholds_for(project))


def soft_delete(db: Session, project: Project, o: Opening, user) -> None:
    o.deleted_at = now()
    o.version += 1
    audit.record(db, project.id, "user", "delete", f"User deleted {o.ref} {o.tag or ''}".strip(), opening=o, user_id=user.id)


def restore(db: Session, project: Project, o: Opening, user) -> None:
    o.deleted_at = None
    o.version += 1
    audit.record(db, project.id, "user", "restore", f"User restored {o.ref}", opening=o, user_id=user.id)


def next_ref(db: Session, project_id: uuid.UUID) -> str:
    refs = db.scalars(select(Opening.ref).where(Opening.project_id == project_id)).all()
    n = 0
    for r in refs:
        try:
            n = max(n, int(r.split("-")[-1]))
        except ValueError:
            pass
    return f"OPEN-{n + 1:03d}"


def create_manual(db: Session, project: Project, data: dict[str, Any], user) -> Opening:
    typ = data.get("type") or "window"
    if typ not in OPENING_TYPES:
        raise EditError(f"unknown opening type '{typ}'")
    o = Opening(
        project_id=project.id,
        ref=next_ref(db, project.id),
        type=typ,
        source="user",
        confidence={"detection": 1.0, "tag": 1.0, "width": None, "height": None, "association": None, "overall": 1.0},
        flags=[],
        evidence=[{"code": "manual", "label": f"Added manually by {user.name or user.email}", "passed": True, "detail": None, "score": None, "page_index": None, "bbox": None, "target": None}],
        instances=[],
        references=[],
        notes="",
        quantity=1,
        quantity_basis="user",
        edited_fields=[],
    )
    db.add(o)
    db.flush()
    audit.record(db, project.id, "user", "create", f"User added {o.ref} manually", opening=o, user_id=user.id)
    changes = {k: v for k, v in data.items() if k in EDITABLE and k != "type"}
    if "bbox" in data and data["bbox"]:
        b = data["bbox"]
        o.bbox = {"x": float(b["x"]), "y": float(b["y"]), "width": float(b["width"]), "height": float(b["height"])}
    apply_edits(db, project, o, changes, user) if changes else refresh_status(o, thresholds_for(project))
    # manual measurements come from the user
    for f in ("width", "height"):
        m = getattr(o, f)
        if m:
            m = dict(m)
            m["evidence"] = [{"code": "manual", "label": f"Entered manually by {user.name or user.email}", "passed": True, "detail": None, "score": None, "page_index": None, "bbox": None, "target": None}]
            setattr(o, f, m)
    if o.page_index is not None and o.bbox:
        o.instances = [{"detection_id": None, "page_index": o.page_index, "sheet": o.drawing_reference, "floor": o.floor, "room": o.room, "bbox": o.bbox, "kind": o.type, "confidence": 1.0, "tag_text": o.tag, "counted": True, "manual": True}]
    refresh_status(o, thresholds_for(project))
    return o


def _fmt_meas(m: dict | None) -> str:
    if not m:
        return "—"
    if m.get("status") == "conflict":
        return "conflicting values (" + " vs ".join(f"{c.get('label')} {c.get('original_text')}" for c in m.get("candidates", [])) + ")"
    return format_length(m.get("value"), "mm")


def _pg(i: int | None) -> str:
    return f"page {i + 1}" if i is not None else "—"


# ---------------------------------------------------------------------------
# merging a new extraction run
# ---------------------------------------------------------------------------


def _record_snapshot(rec: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy({k: rec.get(k) for k in SNAPSHOT_FIELDS})


def _same_ai(a: dict | None, b: dict | None) -> bool:
    if not a or not b:
        return False

    def mv(m):
        if not m:
            return None
        return (m.get("status"), round(m["value"]) if m.get("value") is not None else None)

    return (
        a.get("type") == b.get("type")
        and a.get("tag") == b.get("tag")
        and mv(a.get("width")) == mv(b.get("width"))
        and mv(a.get("height")) == mv(b.get("height"))
        and a.get("quantity") == b.get("quantity")
    )


def _apply_record(o: Opening, rec: dict[str, Any], pages: dict[int, Page]) -> None:
    for k in ("type", "tag", "tag_key", "width", "height", "quantity", "quantity_basis", "page_index", "drawing_reference", "bbox", "floor", "room", "confidence", "flags", "evidence", "instances", "references", "schedule", "source_detections"):
        setattr(o, k, copy.deepcopy(rec.get(k)))
    p = pages.get(rec.get("page_index")) if rec.get("page_index") is not None else None
    o.page_id = p.id if p else None


def _match(existing: list[Opening], rec: dict[str, Any]) -> Opening | None:
    if rec.get("tag_key"):
        for o in existing:
            if o.tag_key == rec["tag_key"] and o.source == "ai":
                return o
        return None
    if rec.get("bbox") and rec.get("page_index") is not None:
        rb = BBox.from_dict(rec["bbox"])
        best = None
        for o in existing:
            if o.tag_key or o.source != "ai" or o.page_index != rec["page_index"] or not o.bbox:
                continue
            iou = BBox.from_dict(o.bbox).iou(rb)
            if iou > 0.3 and (best is None or iou > best[0]):
                best = (iou, o)
        return best[1] if best else None
    return None


def merge_run(db: Session, project: Project, run_id: uuid.UUID, records: list[dict[str, Any]], pages: dict[int, Page]) -> dict[str, int]:
    thr = thresholds_for(project)
    existing = list(db.scalars(select(Opening).where(Opening.project_id == project.id, Opening.deleted_at.is_(None))).all())
    matched: set[uuid.UUID] = set()
    stats = {"created": 0, "updated": 0, "unchanged": 0, "pending_confirmation": 0, "removed": 0}
    first_run = not existing
    for idx, rec in enumerate(records):
        o = _match([e for e in existing if e.id not in matched], rec)
        snap = _record_snapshot(rec)
        if o is None:
            o = Opening(project_id=project.id, ref=rec["ref"] if first_run else next_ref(db, project.id), source="ai", run_id=run_id, notes="", edited_fields=[])
            _apply_record(o, rec, pages)
            o.ai_snapshot = snap
            o.sort_index = idx
            db.add(o)
            db.flush()
            refresh_status(o, thr)
            audit.record(db, project.id, "ai", "extract", f"AI extracted {OPENING_TYPE_LABELS.get(o.type, o.type).lower()} {o.tag or '(untagged)'}", opening=o, new={"type": o.type, "tag": o.tag, "quantity": o.quantity})
            for f in ("width", "height"):
                m = getattr(o, f)
                audit.record(
                    db,
                    project.id,
                    "ai",
                    "extract",
                    f"AI extracted {f}: {_fmt_meas(m)}" + (" (inferred from drawing scale)" if m and m.get("status") == "inferred" else "") if m else f"AI could not determine {f} - needs review",
                    opening=o,
                    field=f,
                    new=_meas_summary(m),
                )
            stats["created"] += 1
            continue
        matched.add(o.id)
        o.sort_index = idx
        if _same_ai(o.ai_snapshot, snap):
            # same answer as before: refresh evidence/geometry but keep user fields
            if not o.edited_fields and not o.verified:
                _apply_record(o, rec, pages)
            o.run_id = run_id
            o.ai_snapshot = snap
            refresh_status(o, thr)
            stats["unchanged"] += 1
            continue
        if o.edited_fields or o.verified:
            # never overwrite the user's work: park the new AI result for confirmation
            o.pending_ai = {**copy.deepcopy(rec), "run_id": str(run_id)}
            o.flags = [f for f in (o.flags or []) if f["code"] != "ai_update_available"] + [
                flag("ai_update_available", "The latest extraction produced different values; your edits were kept. Review and accept or dismiss.")
            ]
            audit.record(db, project.id, "system", "reprocess_pending", "Re-extraction differs from the edited/verified values; awaiting confirmation", opening=o, new={"width": _meas_summary(rec.get("width")), "height": _meas_summary(rec.get("height"))})
            stats["pending_confirmation"] += 1
        else:
            old_w, old_h = o.width, o.height
            _apply_record(o, rec, pages)
            o.ai_snapshot = snap
            o.run_id = run_id
            for f, old in (("width", old_w), ("height", old_h)):
                new = getattr(o, f)
                if _fmt_meas(old) != _fmt_meas(new):
                    audit.record(db, project.id, "ai", "reextract", f"Re-extraction changed {f} from {_fmt_meas(old)} to {_fmt_meas(new)}", opening=o, field=f, old=_meas_summary(old), new=_meas_summary(new))
            stats["updated"] += 1
        refresh_status(o, thr)
    for o in existing:
        if o.id in matched or o.source != "ai":
            continue
        if o.edited_fields or o.verified:
            o.flags = [f for f in (o.flags or []) if f["code"] != "ai_update_available"] + [
                flag("ai_update_available", "Not found by the latest extraction; kept because you edited or verified it.")
            ]
            refresh_status(o, thr)
        else:
            o.deleted_at = now()
            audit.record(db, project.id, "ai", "reextract_removed", f"Removed by re-extraction ({o.ref} {o.tag or ''})".strip(), opening=o)
            stats["removed"] += 1
    return stats


def accept_pending(db: Session, project: Project, o: Opening, user, accept: bool) -> None:
    if not o.pending_ai:
        raise EditError("no pending AI update")
    rec = o.pending_ai
    if accept:
        pages = {p.page_index: p for p in db.scalars(select(Page).where(Page.project_id == project.id)).all()}
        old = {"width": _meas_summary(o.width), "height": _meas_summary(o.height), "type": o.type, "tag": o.tag, "quantity": o.quantity}
        _apply_record(o, rec, pages)
        o.ai_snapshot = _record_snapshot(rec)
        o.edited_fields = []
        o.verified = False
        o.verified_at = None
        o.verified_by = None
        audit.record(db, project.id, "user", "accept_ai_update", "User accepted the re-extracted AI values (replacing previous edits)", opening=o, user_id=user.id, old=old, new={"width": _meas_summary(o.width), "height": _meas_summary(o.height)})
    else:
        audit.record(db, project.id, "user", "reject_ai_update", "User kept their values and dismissed the re-extracted AI values", opening=o, user_id=user.id)
    o.pending_ai = None
    o.flags = [f for f in (o.flags or []) if f["code"] != "ai_update_available"]
    o.version += 1
    refresh_status(o, thresholds_for(project))


def review_items(openings: list[Opening]) -> list[dict[str, Any]]:
    items = []
    for o in openings:
        if o.verified:
            continue
        for f in o.flags or []:
            if FLAG_INFO.get(f["code"], ("warning",))[0] in ("warning", "error"):
                items.append({"opening_id": str(o.id), "ref": o.ref, "tag": o.tag, "type": o.type, **f})
    sev = {"error": 0, "warning": 1, "info": 2}
    items.sort(key=lambda i: (sev.get(i["severity"], 3), i["ref"]))
    return items
