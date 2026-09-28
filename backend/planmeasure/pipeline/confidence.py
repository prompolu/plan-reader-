"""Confidence scoring and review flags."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Thresholds:
    high: float = 0.85  # >= high: green
    medium: float = 0.6  # >= medium: yellow (review recommended); below: red

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "Thresholds":
        d = d or {}
        high = float(d.get("high", 0.85))
        medium = float(d.get("medium", 0.6))
        if not (0 < medium < high <= 1):
            return cls()
        return cls(high, medium)

    def band(self, value: float | None) -> str:
        if value is None:
            return "red"
        if value >= self.high:
            return "green"
        if value >= self.medium:
            return "yellow"
        return "red"


FLAG_INFO: dict[str, tuple[str, str]] = {
    # code: (severity, short label)
    "missing_width": ("warning", "Width missing"),
    "missing_height": ("warning", "Height missing"),
    "unclear_tag": ("warning", "Tag unclear"),
    "low_confidence": ("warning", "Low confidence"),
    "uncertain_association": ("warning", "Uncertain dimension association"),
    "scale_inferred": ("warning", "Measurement inferred from drawing scale"),
    "schedule_conflict": ("error", "Schedule conflict"),
    "dimension_conflict": ("error", "Dimension conflict"),
    "quantity_conflict": ("warning", "Quantity differs from schedule"),
    "possible_duplicate": ("warning", "Possible duplicate"),
    "unclear_type": ("warning", "Opening type unclear"),
    "schedule_only": ("warning", "Schedule entry without drawing evidence"),
    "reference_only": ("warning", "Not located on a floor plan"),
    "poor_page_quality": ("warning", "Poor quality source page"),
    "unit_assumed": ("info", "Unit assumed (no unit note found)"),
    "geometry_not_found": ("warning", "Tag found but opening geometry not located"),
    "counted_from_elevations": ("warning", "Quantity counted from elevations"),
    "ai_update_available": ("info", "Re-extraction result differs from your edits"),
}


def flag(code: str, message: str, **extra: Any) -> dict[str, Any]:
    sev, label = FLAG_INFO.get(code, ("warning", code))
    out = {"code": code, "severity": sev, "label": label, "message": message}
    out.update(extra)
    return out


def overall(conf: dict[str, float | None], required_missing: bool) -> float:
    vals = [v for k, v in conf.items() if k != "overall" and v is not None]
    if not vals:
        return 0.0
    o = sum(vals) / len(vals)
    if required_missing:
        o = min(o, 0.49)
    return round(o, 3)


def needs_review(flags: list[dict[str, Any]]) -> bool:
    return any(f["severity"] in ("warning", "error") for f in flags)
