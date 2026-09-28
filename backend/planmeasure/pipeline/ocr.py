"""OCR providers for raster drawings.

Drawings contain rotated text (vertical dimension strings), so recognition
runs on the upright image and on a 90-degree rotated copy.
"""

from __future__ import annotations

import logging
import shutil

import numpy as np

from .types import BBox, TextLine

log = logging.getLogger(__name__)


class NullOCR:
    name = "none"

    def available(self) -> bool:
        return False

    def recognize(self, rgb: np.ndarray, unit_per_px: float, id_prefix: str) -> list[TextLine]:
        return []


class TesseractOCR:
    """Tesseract via pytesseract. ``--psm 11`` (sparse text) suits drawings."""

    name = "tesseract"

    def __init__(self, lang: str = "eng", min_conf: float = 30.0):
        self.lang = lang
        self.min_conf = min_conf

    def available(self) -> bool:
        return shutil.which("tesseract") is not None

    def version(self) -> str | None:
        try:
            import pytesseract

            return str(pytesseract.get_tesseract_version())
        except Exception:  # pragma: no cover - depends on system install
            return None

    def _run(self, gray: np.ndarray) -> list[dict]:
        import pytesseract

        data = pytesseract.image_to_data(
            gray,
            lang=self.lang,
            config="--psm 11 -c preserve_interword_spaces=1",
            output_type=pytesseract.Output.DICT,
        )
        words = []
        for i, txt in enumerate(data["text"]):
            t = (txt or "").strip()
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError):
                conf = -1
            if not t or conf < self.min_conf:
                continue
            t = clean_ocr_text(t)
            if not t:
                continue
            words.append(
                {
                    "text": t,
                    "x": data["left"][i],
                    "y": data["top"][i],
                    "w": data["width"][i],
                    "h": data["height"][i],
                    "conf": conf / 100.0,
                    "key": (data["block_num"][i], data["par_num"][i], data["line_num"][i]),
                }
            )
        return words

    def recognize(self, rgb: np.ndarray, unit_per_px: float, id_prefix: str) -> list[TextLine]:
        import cv2

        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY) if rgb.ndim == 3 else rgb
        h, w = gray.shape
        out: list[TextLine] = []
        # pass 1: upright text
        for ln in _group_words(self._run(gray)):
            out.append(_mk_line(ln, 0.0, lambda x, y: (x, y), unit_per_px))
        # pass 2: text reading bottom-to-top (rotate image clockwise so it becomes upright)
        rot = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
        # rotated coords (xr, yr) -> original (x, y): x = yr, y = h - 1 - xr
        for ln in _group_words(self._run(rot)):
            out.append(_mk_line(ln, 90.0, lambda xr, yr: (yr, h - 1 - xr), unit_per_px))
        out = [ln for ln in _dedupe(out) if is_meaningful(ln.text)]
        for i, ln in enumerate(out):
            ln.id = f"{id_prefix}-o{i}"
        return out


_STRIP = ",;|_«»~`“”‘’()[]{}<>"


def clean_ocr_text(t: str) -> str:
    """Remove punctuation OCR picks up from nearby strokes (ticks, tag outlines).

    Inch and foot marks are kept - they are meaningful in imperial dimensions."""
    t = t.strip()
    while t and t[0] in _STRIP + ".":
        t = t[1:]
    while t and t[-1] in _STRIP + ".":
        t = t[:-1]
    return t.strip()


def is_meaningful(t: str) -> bool:
    """Reject OCR noise: line strokes read as 'I', '|', '1', '-' and similar fragments."""
    import re

    alnum = re.sub(r"[^A-Za-z0-9]", "", t)
    if len(alnum) >= 2:
        return True
    return False


def fix_tag_ocr(t: str) -> str:
    """Common OCR confusions inside tag numbers: O->0, I/l->1, S->5 after the prefix."""
    import re

    m = re.match(r"^([A-Z]{1,3})([-.\s]?)([0-9OIlS]{1,3})([A-Z]?)$", t.upper())
    if not m:
        return t
    num = m.group(3).translate(str.maketrans({"O": "0", "I": "1", "L": "1", "S": "5"}))
    return f"{m.group(1)}{m.group(2)}{num}{m.group(4)}"


def _group_words(words: list[dict]) -> list[list[dict]]:
    lines: dict[tuple, list[dict]] = {}
    for wd in words:
        lines.setdefault(wd["key"], []).append(wd)
    out = []
    for items in lines.values():
        items.sort(key=lambda d: d["x"])
        # split a tesseract "line" at large gaps (separate annotations)
        cur = [items[0]]
        for a, b in zip(items, items[1:]):
            if b["x"] - (a["x"] + a["w"]) > 1.5 * max(a["h"], b["h"]):
                out.append(cur)
                cur = [b]
            else:
                cur.append(b)
        out.append(cur)
    return out


def _mk_line(words: list[dict], angle: float, tf, upp: float) -> TextLine:
    text_parts = []
    boxes: list[BBox] = []
    for k, wd in enumerate(words):
        if k:
            text_parts.append(" ")
            prev = boxes[-1]
            boxes.append(BBox(prev.x1, prev.y, 0, 0))
        n = len(wd["text"])
        for j in range(n):
            x0 = wd["x"] + wd["w"] * j / n
            x1 = wd["x"] + wd["w"] * (j + 1) / n
            p0 = tf(x0, wd["y"])
            p1 = tf(x1, wd["y"] + wd["h"])
            boxes.append(BBox.from_points(p0[0] * upp, p0[1] * upp, p1[0] * upp, p1[1] * upp))
        text_parts.append(wd["text"])
    text = "".join(text_parts)
    real = [b for b in boxes if b.w > 0 or b.h > 0]
    bb = real[0]
    for b in real[1:]:
        bb = bb.union(b)
    size = max(wd["h"] for wd in words) * upp
    conf = sum(wd["conf"] for wd in words) / len(words)
    return TextLine("", text, bb, boxes, angle, size, "ocr", conf)


def _dedupe(lines: list[TextLine]) -> list[TextLine]:
    """Drop lines that overlap a higher-confidence line (the same text read at the wrong angle)."""
    lines = sorted(lines, key=lambda ln: -ln.confidence * max(len(ln.text.strip()), 1) ** 0.5)
    kept: list[TextLine] = []
    for ln in lines:
        clash = False
        for k in kept:
            inter = ln.bbox.intersection_area(k.bbox)
            if inter > 0.5 * min(ln.bbox.area, k.bbox.area):
                clash = True
                break
        if not clash:
            kept.append(ln)
    return kept


def read_symbol_tags(gray: np.ndarray, unit_per_px: float, id_prefix: str, text_px: float) -> tuple[list[TextLine], list[BBox]]:
    """OCR the inside of small closed symbols (tag circles, hexagons, boxes).

    General OCR struggles with text touching an outline; reading each symbol's
    interior as a single line with a restricted alphabet is far more reliable.
    Returns (tag text lines, symbol boxes) in page units.
    """
    import cv2
    import pytesseract

    from .geometry import binarize
    from .tags import parse_tag

    bw = binarize(gray)
    contours, _ = cv2.findContours(bw, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    lo, hi = (2.0 * text_px) ** 2, (8.0 * text_px) ** 2
    lines: list[TextLine] = []
    boxes: list[BBox] = []
    seen: list[tuple[int, int, int, int]] = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if not (lo <= w * h <= hi) or not (0.5 <= w / max(h, 1) <= 3.0):
            continue
        area = cv2.contourArea(c)
        if area < 0.45 * w * h:
            continue  # open shapes / arcs
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        circ = 4 * np.pi * area / max(cv2.arcLength(c, True) ** 2, 1)
        if not (4 <= len(approx) <= 8 or circ > 0.75):
            continue
        if any(abs(x - a) < 4 and abs(y - b) < 4 and abs(w - cw) < 6 for a, b, cw, _ in seen):
            continue  # inner/outer edge of the same stroke
        seen.append((x, y, w, h))
        mx, my = int(w * 0.16), int(h * 0.18)
        crop = gray[y + my : y + h - my, x + mx : x + w - mx]
        if crop.size == 0:
            continue
        crop = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
        try:
            d = pytesseract.image_to_data(
                crop,
                config="--psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
                output_type=pytesseract.Output.DICT,
            )
        except Exception:  # pragma: no cover - tesseract runtime failure
            continue
        words = [(t.strip(), float(cf)) for t, cf in zip(d["text"], d["conf"]) if t and t.strip()]
        if not words:
            continue
        text = fix_tag_ocr("".join(t for t, _ in words))
        if not parse_tag(text):
            continue
        conf = max(0.3, min(1.0, sum(cf for _, cf in words) / len(words) / 100.0))
        bb = BBox((x + mx) * unit_per_px, (y + my) * unit_per_px, (w - 2 * mx) * unit_per_px, (h - 2 * my) * unit_per_px)
        n = len(text)
        char_boxes = [BBox(bb.x + bb.w * k / n, bb.y, bb.w / n, bb.h) for k in range(n)]
        lines.append(TextLine(f"{id_prefix}-g{len(lines)}", text, bb, char_boxes, 0.0, bb.h, "ocr", conf))
        boxes.append(BBox(x * unit_per_px, y * unit_per_px, w * unit_per_px, h * unit_per_px))
    return lines, boxes


def get_ocr_provider(name: str) -> "TesseractOCR | NullOCR":
    if name == "tesseract":
        p = TesseractOCR()
        if p.available():
            return p
        log.warning("tesseract binary not found; OCR disabled")
    return NullOCR()
