"""Tag-to-opening and dimension-to-opening association.

For every candidate (dimension, opening) pair the engine evaluates independent
signals and records each as evidence:

A. spatial proximity            E. opening tag nearby
B. dimension span = opening edges   F. drawing type (plan: width only; elevation: width + height)
C. extension lines start at the opening edges   G. conventions (plausible size, dimension chains)
D. orientation (parallel to the width / height axis)   H. vision model (ambiguous cases only)

The weighted combination is the association confidence. A dimension is only
associated when its geometry ties it to the opening (B or C); the closest
number is never assumed to belong to an opening.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

from .interfaces import DetectionContext, VisionProvider
from .tags import tag_class
from .types import Association, BBox, DimensionAnnotation, OpeningDetection, TagDetection, View, evidence
from .units import format_length

WEIGHTS = {"edges": 0.42, "extension": 0.18, "proximity": 0.12, "tag": 0.08, "scale": 0.12, "plausible": 0.08}
ACCEPT = 0.5
AMBIGUITY_MARGIN = 0.08

WINDOWISH = {"window", "sliding_window", "curtain_wall"}
DOORISH = {"door", "double_door", "sliding_door", "garage_door"}


def _kind_compat(tag_prefix: str, kind: str) -> float:
    cls = tag_class(tag_prefix)
    if cls in WINDOWISH:
        return 1.0 if kind in WINDOWISH else (0.7 if kind == "opening" else 0.45)
    if cls in DOORISH:
        return 1.0 if kind in DOORISH else (0.7 if kind == "opening" else 0.45)
    if cls == "opening":
        return 1.0 if kind == "opening" else 0.6
    return 0.6


def assign_tags(openings: list[OpeningDetection], tags: list[TagDetection], ctx: DetectionContext) -> list[TagDetection]:
    """Attach each tag to the opening it labels. Returns tags left unassigned."""
    reach = ctx.units(2000)
    scale_d = ctx.units(900)
    pairs = []
    for t in tags:
        for o in openings:
            d = o.bbox.distance_to(t.bbox)
            if d > reach:
                continue
            along = t.bbox.cx if o.axis == "h" else t.bbox.cy
            lo, hi = o.edges
            w = max(hi - lo, 1e-6)
            aligned = lo - 0.15 * w <= along <= hi + 0.15 * w
            off = abs(along - (lo + hi) / 2)
            centred = off <= 0.25 * w + ctx.units(150)
            # tags sit on the line through the opening centre, perpendicular to the wall
            centring = max(0.3, 1.0 - off / (0.6 * w + ctx.units(100)))
            s = math.exp(-d / scale_d) * centring * _kind_compat(t.prefix, o.kind)
            pairs.append((s, t, o, d, aligned, centred))
    pairs.sort(key=lambda p: -p[0])
    used_t: set[str] = set()
    for s, t, o, d, aligned, centred in pairs:
        if s < 0.2 or t.id in used_t:
            continue
        if o.tag is None:
            o.tag = t
            o.tag_score = min(0.99, t.confidence * (0.55 + 0.45 * min(1.0, s / 0.8)))
            o.tag_evidence = [
                evidence(
                    "tag_detected",
                    f"Tag {t.text} detected" + (" (enclosed tag symbol)" if t.enclosure else ""),
                    True,
                    score=t.confidence,
                    page_index=t.page_index,
                    bbox=t.bbox,
                    target=t.id,
                ),
                evidence(
                    "tag_position",
                    "Tag placed on the opening's centre line" if centred else ("Tag within the opening's extent" if aligned else "Tag offset from the opening"),
                    centred or aligned,
                    detail=f"{ctx.real(d):.0f} mm from the opening",
                    score=s,
                    page_index=t.page_index,
                    bbox=t.bbox,
                ),
            ]
            if _kind_compat(t.prefix, o.kind) < 0.8:
                o.tag_evidence.append(
                    evidence("tag_kind", f"Tag prefix '{t.prefix}' does not match the drawn symbol ({o.kind.replace('_', ' ')})", False, page_index=t.page_index, bbox=t.bbox)
                )
            used_t.add(t.id)
        elif o.tag.key == t.key and (aligned or d < ctx.units(1200)):
            # the same tag written twice next to one opening
            o.features.setdefault("duplicate_tags", []).append(t.to_dict())
            o.evidence.append(
                evidence(
                    "duplicate_tag",
                    f"Tag {t.text} appears twice at this opening",
                    None,
                    detail="Possible duplicate annotation - counted once, please confirm",
                    page_index=t.page_index,
                    bbox=t.bbox,
                    target=t.id,
                )
            )
            used_t.add(t.id)
    # a second copy of a tag near an opening that already carries it is a duplicate
    # annotation, not a separate opening
    for t in tags:
        if t.id in used_t:
            continue
        near = [o for o in openings if o.tag is not None and o.tag.key == t.key and o.bbox.distance_to(t.bbox) < reach]
        if near:
            o = min(near, key=lambda o: o.bbox.distance_to(t.bbox))
            o.features.setdefault("duplicate_tags", []).append(t.to_dict())
            o.evidence.append(
                evidence(
                    "duplicate_tag",
                    f"Tag {t.text} appears twice at this opening",
                    None,
                    detail="Possible duplicate annotation - counted once, please confirm",
                    page_index=t.page_index,
                    bbox=t.bbox,
                    target=t.id,
                )
            )
            used_t.add(t.id)
    return [t for t in tags if t.id not in used_t]


@dataclass
class Candidate:
    opening: OpeningDetection
    dim: DimensionAnnotation
    role: str
    score: float
    signals: list[dict[str, Any]]
    level_like: bool = False


def _role_extents(o: OpeningDetection, role: str) -> tuple[tuple[float, float], tuple[float, float]]:
    """(edges measured by the dimension, perpendicular extent) for a role."""
    if role == "width":
        return o.edges, o.cross
    return o.cross, o.edges  # height in elevation: top/bottom y; perpendicular extent x0/x1


def _evaluate(o: OpeningDetection, d: DimensionAnnotation, role: str, view: View, ctx: DetectionContext) -> Candidate | None:
    (e0, e1), (c0, c1) = _role_extents(o, role)
    size = e1 - e0
    tol = max(0.8, ctx.units(20), 0.015 * size, ctx.min_tol)
    s0, s1 = d.span
    d0, d1 = abs(s0 - e0), abs(s1 - e1)
    if d0 <= tol and d1 <= tol:
        edge = 1.0
    elif d0 <= 3 * tol and d1 <= 3 * tol:
        edge = 0.75
    elif min(d0, d1) <= tol:
        edge = 0.3
    else:
        return None
    pi = d.page_index
    sig: list[dict[str, Any]] = []
    axis_word = "Horizontal" if d.axis == "h" else "Vertical"
    sig.append(
        evidence(
            "orientation",
            f"{axis_word} dimension corresponds to opening {role}",
            True,
            page_index=pi,
            bbox=d.text_bbox,
        )
    )
    if edge == 1.0:
        sig.append(evidence("dim_line_edges", f"Dimension line terminates at the opening's {'jambs' if role == 'width' else 'head and sill'}", True, score=edge, page_index=pi, bbox=d.line.bbox if d.line else d.text_bbox))
    elif edge == 0.75:
        sig.append(evidence("dim_line_edges", "Dimension line ends close to the opening edges", True, score=edge, page_index=pi, bbox=d.line.bbox if d.line else d.text_bbox))
    else:
        sig.append(evidence("dim_line_edges", "Only one end of the dimension line meets an opening edge", False, score=edge, page_index=pi, bbox=d.line.bbox if d.line else d.text_bbox))

    # C. extension lines
    level_like = False
    ext_score: float | None = None
    if d.extension_lines:
        hits = 0
        g = ctx.units(450)
        for s in d.extension_lines:
            far = max(((s.x0, s.y0), (s.x1, s.y1)), key=lambda p: abs((p[1] if d.axis == "h" else p[0]) - (d.line_pos or 0)))
            along = far[0] if d.axis == "h" else far[1]
            across = far[1] if d.axis == "h" else far[0]
            if (abs(along - e0) <= tol or abs(along - e1) <= tol) and c0 - g <= across <= c1 + g:
                hits += 1
        ext_score = min(1.0, hits / 2)
        if hits:
            sig.append(evidence("extension_lines", f"Extension line{'s' if hits > 1 else ''} originate{'' if hits > 1 else 's'} at the opening edges", True, score=ext_score, page_index=pi, bbox=d.extension_lines[0].bbox))
        elif view.view_type == "elevation" and role == "height" and edge == 1.0:
            level_like = True
            ext_score = None
            sig.append(
                evidence(
                    "level_alignment",
                    "Level dimension: span aligns exactly with the opening's sill and head levels",
                    True,
                    detail="Extension lines start at the facade edge, so the dimension may apply to several openings at these levels",
                    page_index=pi,
                    bbox=d.line.bbox if d.line else d.text_bbox,
                )
            )
        else:
            sig.append(evidence("extension_lines", "Extension lines start away from this opening", False, score=0.0, page_index=pi, bbox=d.extension_lines[0].bbox))
    else:
        sig.append(evidence("extension_lines", "No extension lines found for this dimension", None, page_index=pi, bbox=d.text_bbox))

    # A. proximity of the dimension line to the opening
    lp = d.line_pos if d.line_pos is not None else (d.text_bbox.cy if d.axis == "h" else d.text_bbox.cx)
    dist = 0.0 if c0 <= lp <= c1 else min(abs(lp - c0), abs(lp - c1))
    prox = math.exp(-dist / ctx.units(2500))
    sig.append(evidence("proximity", "Dimension text is close to the opening" if prox > 0.4 else "Dimension is some distance from the opening", prox > 0.4, detail=f"{ctx.real(dist):.0f} mm away", score=prox, page_index=pi, bbox=d.text_bbox))

    # E. tag
    tag_s = 0.0
    if o.tag is not None:
        td = o.tag.bbox.distance_to(d.text_bbox)
        if td < ctx.units(1600):
            tag_s = 1.0
            sig.append(evidence("tag_nearby", f"Opening tag {o.tag.text} is nearby", True, page_index=pi, bbox=o.tag.bbox, target=o.tag.id))
    # scale consistency
    if d.scale_check is None:
        sc = 0.5
    elif d.scale_check["consistent"]:
        sc = 1.0
        sig.append(evidence("scale_consistent", f"Drawn length matches the value at {view.scale.text or 'the drawing scale'}", True, page_index=pi, bbox=d.line.bbox if d.line else d.text_bbox))
    else:
        sc = 0.0
        sig.append(evidence("scale_consistent", "Drawn length does not match the written value at the drawing scale", False, detail=d.notes[-1] if d.notes else None, page_index=pi, bbox=d.text_bbox))
    # G. plausibility and chains
    lo_ok, hi_ok = (200, 9000) if role == "width" else (200, 5000)
    plaus = 1.0 if lo_ok <= d.value_mm <= hi_ok else 0.2
    if plaus < 1.0:
        sig.append(evidence("plausible", f"Value {format_length(d.value_mm, 'mm')} is outside the usual range for an opening {role}", False, page_index=pi, bbox=d.text_bbox))
    if d.chain_size > 1:
        sig.append(evidence("chain", f"Segment of a {d.chain_size}-part dimension chain whose ends coincide with this opening", True, page_index=pi, bbox=d.text_bbox))

    ext_val = 0.5 if ext_score is None else ext_score
    score = (
        WEIGHTS["edges"] * edge
        + WEIGHTS["extension"] * ext_val
        + WEIGHTS["proximity"] * prox
        + WEIGHTS["tag"] * tag_s
        + WEIGHTS["scale"] * sc
        + WEIGHTS["plausible"] * plaus
    )
    if edge < 0.75 and (ext_score or 0) < 1.0:
        return None  # geometry does not tie this dimension to the opening
    return Candidate(o, d, role, score * d.confidence / 0.96, sig, level_like)


def associate_dimensions(
    openings: list[OpeningDetection],
    dims: list[DimensionAnnotation],
    view: View,
    ctx: DetectionContext,
    vision: VisionProvider | None = None,
    crop: Callable[[BBox], bytes] | None = None,
) -> list[dict[str, Any]]:
    """Associate dimensions with openings in one view. Returns vision-call log entries."""
    log: list[dict[str, Any]] = []
    linear = [d for d in dims if d.kind == "linear" and d.view_id == view.id and d.span is not None]
    cands: list[Candidate] = []
    for o in openings:
        for d in linear:
            roles = []
            if d.axis == o.axis:
                roles.append("width")
            if view.view_type == "elevation" and d.axis != o.axis:
                roles.append("height")
            for role in roles:
                c = _evaluate(o, d, role, view, ctx)
                if c is not None:
                    cands.append(c)
    by_open: dict[tuple[str, str], list[Candidate]] = {}
    for c in cands:
        by_open.setdefault((c.opening.id, c.role), []).append(c)
    for lst in by_open.values():
        lst.sort(key=lambda c: -c.score)
        c = lst[0]
        c.opening.candidate_assocs.extend(Association(x.dim.id, x.role, x.score, x.signals) for x in lst[:3])

    # global greedy assignment (one opening per dimension, except shared level dimensions)
    cands.sort(key=lambda c: -c.score)
    dim_used: dict[tuple[str, str], str] = {}
    for c in cands:
        o = c.opening
        slot = "width_assoc" if c.role == "width" else "height_assoc"
        if getattr(o, slot) is not None or c.score < ACCEPT:
            continue
        key = (c.dim.id, c.role)
        if key in dim_used and not c.level_like:
            continue
        rivals = [x for x in by_open[(o.id, c.role)] if x is not c and abs(x.dim.value_mm - c.dim.value_mm) > 1 and (x.dim.id, x.role) not in dim_used]
        signals = list(c.signals)
        chosen = c
        if rivals and rivals[0].score > c.score - AMBIGUITY_MARGIN:
            verdict = None
            if vision is not None and crop is not None and vision.available():
                verdict = _ask_vision(vision, crop, o, [c] + rivals[:2], view, log)
            if verdict is not None and verdict != c.dim.id:
                alt = next((x for x in rivals if x.dim.id == verdict), None)
                if alt is not None:
                    chosen = alt
                    signals = list(alt.signals)
            signals.append(
                evidence(
                    "ambiguous",
                    "Another dimension fits almost as well",
                    False,
                    detail=f"Alternative: {rivals[0].dim.text}" + (" (vision model consulted)" if verdict else ""),
                    page_index=rivals[0].dim.page_index,
                    bbox=rivals[0].dim.text_bbox,
                    target=rivals[0].dim.id,
                )
            )
            if verdict is not None:
                signals.append(evidence("vision", f"Vision model selected {chosen.dim.text}", True, page_index=chosen.dim.page_index, bbox=chosen.dim.text_bbox))
            chosen = Candidate(chosen.opening, chosen.dim, chosen.role, min(chosen.score, 0.6), signals, chosen.level_like)
        shared = [x.opening.id for x in cands if x.dim.id == chosen.dim.id and x.role == chosen.role and x.opening is not o and x.level_like]
        setattr(o, slot, Association(chosen.dim.id, chosen.role, chosen.score, signals, shared_with=shared if chosen.level_like else []))
        dim_used[(chosen.dim.id, chosen.role)] = o.id

    # size callouts next to tags ("1200 x 1500")
    callouts = [d for d in dims if d.kind == "callout" and d.view_id == view.id]
    for o in openings:
        if o.tag is None:
            continue
        near = [d for d in callouts if d.text_bbox.distance_to(o.tag.bbox) < max(ctx.units(1200), 3 * o.tag.bbox.h)]
        for d in near:
            role = d.pair_role or "width"
            slot = "width_assoc" if role == "width" else "height_assoc"
            if getattr(o, slot) is not None:
                continue
            s = 0.85 if d.pair_role else 0.6
            sig = [
                evidence(
                    "callout",
                    f"Size callout \"{d.text}\" written beside tag {o.tag.text}" if d.pair_role else f"Number \"{d.text}\" written on the tag line",
                    True,
                    detail="Callout order is width x height" if d.pair_role else "No dimension line - treated as width, please confirm",
                    page_index=d.page_index,
                    bbox=d.text_bbox,
                    target=d.id,
                ),
                evidence("tag_nearby", f"Opening tag {o.tag.text} is adjacent", True, page_index=o.tag.page_index, bbox=o.tag.bbox, target=o.tag.id),
            ]
            setattr(o, slot, Association(d.id, role, s * d.confidence, sig))

    # scale-derived sizes (used only when no explicit dimension is found later)
    for o in openings:
        if ctx.scale_known:
            o.features["inferred_width_mm"] = round(ctx.real(o.edges[1] - o.edges[0]), 1)
            if view.view_type == "elevation":
                o.features["inferred_height_mm"] = round(ctx.real(o.cross[1] - o.cross[0]), 1)
            o.features["scale_text"] = view.scale.text
    return log


def _ask_vision(vision: VisionProvider, crop, o: OpeningDetection, cands: list[Candidate], view: View, log: list) -> str | None:
    box = o.bbox
    for c in cands:
        box = box.union(c.dim.text_bbox)
    try:
        img = crop(box.expand(20))
        question = {
            "opening": {"id": o.id, "kind": o.kind, "tag": o.tag.text if o.tag else None, "bbox": o.bbox.to_dict()},
            "role": cands[0].role,
            "view_type": view.view_type,
            "crop_origin": {"x": box.expand(20).x, "y": box.expand(20).y},
            "candidates": [{"id": c.dim.id, "text": c.dim.text, "bbox": c.dim.text_bbox.to_dict()} for c in cands],
        }
        ans = vision.adjudicate_association(img, question)
    except Exception as exc:  # the vision model is optional; never fail extraction because of it
        log.append({"opening": o.id, "error": str(exc)})
        return None
    log.append({"opening": o.id, "question": [c.dim.id for c in cands], "answer": ans})
    if not ans:
        return None
    choice = ans.get("choice")
    valid = {c.dim.id for c in cands}
    if choice in valid and float(ans.get("confidence", 0)) >= 0.6:
        return choice
    return None
