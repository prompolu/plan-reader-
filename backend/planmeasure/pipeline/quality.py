"""Raster page quality assessment (flag poor scans instead of trusting them)."""

from __future__ import annotations

import statistics

import numpy as np

from .types import PageQuality, TextLine


def assess_raster(gray: np.ndarray, lines: list[TextLine], px_per_unit: float, known_dpi: float | None, kind: str = "raster") -> PageQuality:
    import cv2

    q = PageQuality(kind=kind)
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    q.blur_score = round(float(lap.var()), 1)
    q.contrast = round(float(gray.std()), 1)
    if lines:
        q.mean_ocr_confidence = round(statistics.mean(ln.confidence for ln in lines), 3)
    if known_dpi:
        q.effective_dpi = round(known_dpi, 1)
    else:
        # estimate from text height: architectural annotation is ~2.5 mm tall
        heights = [ln.size * px_per_unit for ln in lines if ln.size > 0]
        if heights:
            px_per_mm = statistics.median(heights) / 2.5
            q.effective_dpi = round(px_per_mm * 25.4, 1)
    reasons = []
    if q.effective_dpi is not None and q.effective_dpi < 120:
        reasons.append(f"low resolution (~{q.effective_dpi:.0f} dpi)")
    if q.blur_score is not None and q.blur_score < 60:
        reasons.append("blurry")
    if q.contrast is not None and q.contrast < 18:
        reasons.append("low contrast")
    if q.mean_ocr_confidence is not None and q.mean_ocr_confidence < 0.6:
        reasons.append("text hard to read (possibly handwritten)")
    if not lines:
        reasons.append("no readable text")
    q.reasons = reasons
    q.poor = len(reasons) > 0
    return q
