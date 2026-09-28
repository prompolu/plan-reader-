"""Drawing scale parsing, detection and calibration.

Supported notations: ``1:50``, ``1:100``, ``1/4" = 1'-0"``, ``3/16" = 1'-0"``,
``NTS`` / ``NOT TO SCALE``.

A scale ``ratio`` is real length / paper length (1:100 -> 100,
1/4" = 1'-0" -> 48).
"""

from __future__ import annotations

import re
import statistics
from fractions import Fraction
from typing import Iterable

from .types import BBox, DimensionAnnotation, ScaleInfo, TextLine
from .units import RE_SCALE_IMPERIAL, RE_SCALE_METRIC, normalize_chars

STANDARD_METRIC = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000]
STANDARD_IMPERIAL = [
    ('1/16" = 1\'-0"', 192),
    ('3/32" = 1\'-0"', 128),
    ('1/8" = 1\'-0"', 96),
    ('3/16" = 1\'-0"', 64),
    ('1/4" = 1\'-0"', 48),
    ('3/8" = 1\'-0"', 32),
    ('1/2" = 1\'-0"', 24),
    ('3/4" = 1\'-0"', 16),
    ('1" = 1\'-0"', 12),
    ('1 1/2" = 1\'-0"', 8),
    ('3" = 1\'-0"', 4),
]

RE_NTS = re.compile(r"\b(N\.?T\.?S\.?|NOT\s+TO\s+SCALE)\b", re.IGNORECASE)
RE_SCALE_LABEL = re.compile(r"\bSCALE\b", re.IGNORECASE)


def parse_scale(text: str) -> tuple[str, float] | None:
    """Parse a scale notation. Returns (normalised text, ratio)."""
    t = normalize_chars(text)
    m = RE_SCALE_IMPERIAL.search(t)
    if m:
        paper = m.group("paper").replace("-", " ").strip()
        try:
            parts = paper.split()
            paper_in = sum(Fraction(p) for p in parts)
        except (ValueError, ZeroDivisionError):
            return None
        real_in = int(m.group("real")) * 12
        if paper_in <= 0:
            return None
        ratio = float(real_in / paper_in)
        return (text[m.start() : m.end()].strip(), ratio)
    m = RE_SCALE_METRIC.search(t)
    if m:
        den = int(m.group("den"))
        if den <= 0:
            return None
        return (f"1:{den}", float(den))
    return None


def format_ratio(ratio: float, imperial: bool = False) -> str:
    if imperial:
        for text, r in STANDARD_IMPERIAL:
            if abs(r - ratio) < 0.01:
                return text
    if abs(ratio - round(ratio)) < 1e-6:
        return f"1:{int(round(ratio))}"
    return f"1:{ratio:.2f}"


def find_scale_mentions(lines: Iterable[TextLine]) -> list[dict]:
    """All scale notations on a page, with a hint whether they are labelled."""
    out = []
    lines = list(lines)
    for ln in lines:
        parsed = parse_scale(ln.text)
        nts = RE_NTS.search(ln.text)
        if not parsed and not nts:
            continue
        labelled = bool(RE_SCALE_LABEL.search(ln.text))
        if not labelled:
            # a "SCALE" label may be a separate text line just left of / above the value
            for other in lines:
                if other is ln or not RE_SCALE_LABEL.search(other.text):
                    continue
                if other.bbox.distance_to(ln.bbox) < 3 * max(ln.size, 1):
                    labelled = True
                    break
        out.append(
            {
                "text": parsed[0] if parsed else nts.group(0),
                "ratio": parsed[1] if parsed else None,
                "nts": parsed is None,
                "labelled": labelled,
                "bbox": ln.bbox,
                "line": ln,
            }
        )
    return out


def calibrate_from_dimensions(dims: list[DimensionAnnotation], mm_per_unit: float | None) -> tuple[float, int, float] | None:
    """Estimate the scale ratio from dimension lines whose drawn length is known.

    Returns (ratio, n_supporting, agreement) or None. ``agreement`` is the
    fraction of dimensions within 2% of the estimated ratio.
    """
    if not mm_per_unit:
        return None
    ratios = []
    for d in dims:
        if d.span is None or d.kind != "linear":
            continue
        paper_mm = abs(d.span[1] - d.span[0]) * mm_per_unit
        if paper_mm < 2:
            continue
        ratios.append(d.value_mm / paper_mm)
    if len(ratios) < 3:
        return None
    med = statistics.median(ratios)
    support = [r for r in ratios if abs(r - med) / med < 0.02]
    agreement = len(support) / len(ratios)
    if len(support) < 3:
        return None
    est = statistics.mean(support)
    # snap to a standard scale when within 1%
    candidates = [float(s) for s in STANDARD_METRIC] + [float(r) for _, r in STANDARD_IMPERIAL]
    best = min(candidates, key=lambda c: abs(c - est) / c)
    if abs(best - est) / best < 0.01:
        est = best
    return est, len(support), agreement


def scale_check(d: DimensionAnnotation, ratio: float | None, mm_per_unit: float | None) -> dict | None:
    """Compare a dimension's text value with its drawn length at the given scale."""
    if ratio is None or mm_per_unit is None or d.span is None:
        return None
    drawn_paper_mm = abs(d.span[1] - d.span[0]) * mm_per_unit
    measured_real = drawn_paper_mm * ratio
    if d.value_mm <= 0:
        return None
    rel = abs(measured_real - d.value_mm) / d.value_mm
    return {
        "scale_ratio": ratio,
        "drawn_length_mm": round(measured_real, 1),
        "relative_error": round(rel, 4),
        "consistent": rel <= 0.03,
    }


def no_scale() -> ScaleInfo:
    return ScaleInfo(text=None, ratio=None, source="none", confidence=0.0)


def scale_from_mention(m: dict, confidence: float) -> ScaleInfo:
    return ScaleInfo(
        text=m["text"],
        ratio=m["ratio"],
        source="detected",
        confidence=confidence,
        bbox=m["bbox"] if isinstance(m["bbox"], BBox) else None,
        not_to_scale=m["nts"],
    )
