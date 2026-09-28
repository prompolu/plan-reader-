"""A small CAD-like drawing toolkit on top of PyMuPDF.

Used to generate the demo drawing set and the benchmark dataset. The output
follows common architectural drafting conventions (title blocks, dimension
chains with ticks/arrows and extension lines, door swings, window glazing
lines, tags in circles/hexagons, schedules as ruled tables).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import pymupdf

PT_PER_MM = 72.0 / 25.4

PAPER_SIZES_MM = {"A1": (841, 594), "A2": (594, 420), "A3": (420, 297), "A4": (297, 210)}

BLACK = (0, 0, 0)
GREY = (0.45, 0.45, 0.45)


def mm(v: float) -> float:
    """Paper millimetres -> points."""
    return v * PT_PER_MM


@dataclass
class DrawnDimension:
    text: str
    value_mm: float
    axis: str
    span_pt: tuple[float, float]
    line_pos_pt: float
    text_bbox_pt: tuple[float, float, float, float]


class Sheet:
    def __init__(self, doc: pymupdf.Document, paper: str = "A3", landscape: bool = True):
        w, h = PAPER_SIZES_MM[paper]
        if not landscape:
            w, h = h, w
        self.paper = paper
        self.w_mm, self.h_mm = w, h
        self.page = doc.new_page(width=mm(w), height=mm(h))
        self.shape = self.page.new_shape()
        self.W = mm(w)
        self.H = mm(h)

    # -- primitives ----------------------------------------------------------

    def line(self, p0, p1, width: float = 0.25, color=BLACK, dashes: str | None = None):
        self.shape.draw_line(p0, p1)
        self.shape.finish(width=width, color=color, dashes=dashes, closePath=False)

    def polyline(self, pts, width: float = 0.25, color=BLACK, closed: bool = False, fill=None, dashes=None):
        self.shape.draw_polyline(pts)
        self.shape.finish(width=width, color=color, fill=fill, closePath=closed, dashes=dashes)

    def rect(self, x0, y0, x1, y1, width: float = 0.25, color=BLACK, fill=None):
        self.shape.draw_rect(pymupdf.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
        self.shape.finish(width=width, color=color, fill=fill)

    def circle(self, c, r, width: float = 0.25, color=BLACK, fill=None):
        self.shape.draw_circle(c, r)
        self.shape.finish(width=width, color=color, fill=fill)

    def arc(self, center, r: float, a0_deg: float, a1_deg: float, width: float = 0.18, color=BLACK):
        """Circular arc (paper coordinates, angles in the y-down system) as cubic Beziers."""
        a0, a1 = math.radians(a0_deg), math.radians(a1_deg)
        n = max(1, int(math.ceil(abs(a1 - a0) / (math.pi / 2) - 1e-9)))
        step = (a1 - a0) / n
        cx, cy = center
        for i in range(n):
            s = a0 + i * step
            e = s + step
            k = 4 / 3 * math.tan((e - s) / 4) * r
            p0 = (cx + r * math.cos(s), cy + r * math.sin(s))
            p3 = (cx + r * math.cos(e), cy + r * math.sin(e))
            p1 = (p0[0] - k * math.sin(s), p0[1] + k * math.cos(s))
            p2 = (p3[0] + k * math.sin(e), p3[1] - k * math.cos(e))
            self.shape.draw_bezier(p0, p1, p2, p3)
        self.shape.finish(width=width, color=color, closePath=False)

    def text(
        self,
        x: float,
        y: float,
        s: str,
        size: float = 7,
        font: str = "helv",
        align: str = "left",
        rotate: int = 0,
        color=BLACK,
    ) -> tuple[float, float, float, float]:
        """Insert text; (x, y) is the baseline anchor. Returns an approximate bbox."""
        tw = pymupdf.get_text_length(s, fontname=font, fontsize=size)
        if rotate == 0:
            if align == "center":
                x -= tw / 2
            elif align == "right":
                x -= tw
            self.shape.insert_text((x, y), s, fontsize=size, fontname=font, color=color)
            return (x, y - size * 0.75, x + tw, y + size * 0.25)
        # rotate=90: text reads bottom-to-top, baseline runs upward from (x, y)
        if align == "center":
            y += tw / 2
        elif align == "right":
            y += tw
        self.shape.insert_text((x, y), s, fontsize=size, fontname=font, rotate=90, color=color)
        return (x - size * 0.75, y - tw, x + size * 0.25, y)

    def commit(self):
        self.shape.commit()

    # -- sheet furniture -----------------------------------------------------

    def frame_and_title_block(
        self,
        *,
        project: str,
        address: str,
        sheet_title: str,
        sheet_number: str,
        scale_text: str,
        date: str = "2026-09-01",
        revision: str = "B",
        firm: str = "STUDIO NORTH ARCHITECTS",
        units_note: str | None = "ALL DIMENSIONS IN MILLIMETRES UNLESS NOTED OTHERWISE. DO NOT SCALE.",
    ) -> tuple[float, float, float, float]:
        m = mm(10)
        self.rect(m, m, self.W - m, self.H - m, width=0.8)
        # title block: bottom-right box
        tb_w, tb_h = mm(170), mm(42)
        x0, y0 = self.W - m - tb_w, self.H - m - tb_h
        x1, y1 = self.W - m, self.H - m
        self.rect(x0, y0, x1, y1, width=0.6)
        col = x0 + mm(70)
        col2 = x0 + mm(125)
        self.line((col, y0), (col, y1), 0.35)
        self.line((col2, y0 + mm(14)), (col2, y1), 0.35)
        self.line((col, y0 + mm(14)), (x1, y0 + mm(14)), 0.35)
        self.line((col, y0 + mm(28)), (x1, y0 + mm(28)), 0.35)
        self.text(x0 + mm(3), y0 + mm(7), firm, 8, "hebo")
        self.text(x0 + mm(3), y0 + mm(14), project, 8, "helv")
        self.text(x0 + mm(3), y0 + mm(19), address, 6.5, "helv")
        if units_note:
            # wrap the note into two lines
            words = units_note.split()
            half = len(words) // 2 + 1
            self.text(x0 + mm(3), y0 + mm(30), " ".join(words[:half]), 5, "helv")
            self.text(x0 + mm(3), y0 + mm(34), " ".join(words[half:]), 5, "helv")
        self.text(col + mm(2), y0 + mm(4), "DRAWING TITLE", 4.5, "helv", color=GREY)
        self.text(col + mm(2), y0 + mm(11), sheet_title, 10, "hebo")
        self.text(col + mm(2), y0 + mm(18), "SCALE", 4.5, "helv", color=GREY)
        self.text(col + mm(2), y0 + mm(25), scale_text, 8, "helv")
        self.text(col2 + mm(2), y0 + mm(18), "DATE", 4.5, "helv", color=GREY)
        self.text(col2 + mm(2), y0 + mm(25), date, 7, "helv")
        self.text(col + mm(2), y0 + mm(32), "SHEET", 4.5, "helv", color=GREY)
        self.text(col + mm(2), y0 + mm(40), sheet_number, 14, "hebo")
        self.text(col2 + mm(2), y0 + mm(32), "REV", 4.5, "helv", color=GREY)
        self.text(col2 + mm(2), y0 + mm(40), revision, 12, "hebo")
        return (x0, y0, x1, y1)

    def view_title(self, x: float, y: float, title: str, scale_text: str | None):
        """Underlined view title placed below a drawing view."""
        bb = self.text(x, y, title, 11, "hebo")
        self.line((x, y + mm(1.5)), (bb[2], y + mm(1.5)), 0.6)
        if scale_text:
            self.text(x, y + mm(6), f"SCALE {scale_text}", 7, "helv")


class View:
    """Maps model millimetres (x right, y up) onto paper points."""

    def __init__(self, sheet: Sheet, origin_pt: tuple[float, float], scale: float):
        self.sheet = sheet
        self.ox, self.oy = origin_pt
        self.scale = scale

    def P(self, x: float, y: float) -> tuple[float, float]:
        return (self.ox + mm(x / self.scale), self.oy - mm(y / self.scale))

    def L(self, d: float) -> float:
        return mm(d / self.scale)

    # -- dimensions ------------------------------------------------------------

    def dim_chain(
        self,
        axis: str,
        positions: list[float],
        line_at: float,
        object_at: float | list[float],
        *,
        style: str = "tick",
        continuous: bool = False,
        text_side: int = 1,
        fmt=None,
        text_size: float = 6.5,
    ) -> list[DrawnDimension]:
        """Draw an aligned dimension chain.

        ``axis`` "x": horizontal chain; ``positions`` are x coordinates (model mm),
        the dimension line is at model y = ``line_at`` and extension lines start
        near model y = ``object_at`` (one value or one per position).
        ``axis`` "y": vertical chain, mirrored roles.
        """
        s = self.sheet
        fmt = fmt or (lambda v: f"{round(v):d}")
        objs = object_at if isinstance(object_at, list) else [object_at] * len(positions)
        gap = mm(1.5)
        over = mm(1.5)
        out: list[DrawnDimension] = []
        pts = [self.P(p, line_at) if axis == "x" else self.P(line_at, p) for p in positions]
        # extension lines
        for p, o, dp in zip(positions, objs, pts):
            op = self.P(p, o) if axis == "x" else self.P(o, p)
            if axis == "x":
                sgn = 1 if dp[1] > op[1] else -1
                if abs(dp[1] - op[1]) > gap + 0.5:
                    s.line((op[0], op[1] + sgn * gap), (dp[0], dp[1] + sgn * over), 0.15)
            else:
                sgn = 1 if dp[0] > op[0] else -1
                if abs(dp[0] - op[0]) > gap + 0.5:
                    s.line((op[0] + sgn * gap, op[1]), (dp[0] + sgn * over, dp[1]), 0.15)
        # dimension line(s)
        if continuous:
            s.line(pts[0], pts[-1], 0.15)
        else:
            for a, b in zip(pts, pts[1:]):
                s.line(a, b, 0.15)
        # terminators
        for i, dp in enumerate(pts):
            self._terminator(dp, axis, style, i, len(pts))
        # text
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            value = abs(positions[i + 1] - positions[i])
            label = fmt(value)
            if axis == "x":
                cx = (a[0] + b[0]) / 2
                y = a[1] - mm(0.9) if text_side > 0 else a[1] + mm(3.2)
                bb = s.text(cx, y, label, text_size, align="center")
                span = (min(a[0], b[0]), max(a[0], b[0]))
                out.append(DrawnDimension(label, value, "h", span, a[1], bb))
            else:
                cy = (a[1] + b[1]) / 2
                x = a[0] - mm(0.9) if text_side > 0 else a[0] + mm(3.2)
                bb = s.text(x, cy, label, text_size, align="center", rotate=90)
                span = (min(a[1], b[1]), max(a[1], b[1]))
                out.append(DrawnDimension(label, value, "v", span, a[0], bb))
        return out

    def _terminator(self, p, axis: str, style: str, i: int, n: int):
        s = self.sheet
        d = mm(1.0)
        if style == "tick":
            s.line((p[0] - d, p[1] + d), (p[0] + d, p[1] - d), 0.35)
        elif style == "dot":
            s.circle(p, mm(0.45), width=0.1, fill=BLACK)
        elif style == "arrow":
            ln, wd = mm(2.2), mm(0.55)
            # arrows point outward from the span interior; interior points get two arrows
            dirs = []
            if i > 0:
                dirs.append(1)
            if i < n - 1:
                dirs.append(-1)
            for sg in dirs:
                if axis == "x":
                    tip = p
                    base = (p[0] - sg * ln, p[1])
                    tri = [tip, (base[0], base[1] - wd), (base[0], base[1] + wd)]
                else:
                    # y-down paper: sg=+1 means the arrow comes from above (smaller y)
                    tip = p
                    base = (p[0], p[1] + sg * ln)
                    tri = [tip, (base[0] - wd, base[1]), (base[0] + wd, base[1])]
                s.polyline(tri, width=0.1, closed=True, fill=BLACK)


def tag_symbol(sheet: Sheet, center: tuple[float, float], text: str, shape: str = "circle", size: float = 6.0):
    """Draw an opening tag: text inside a circle, hexagon, diamond or rectangle."""
    cx, cy = center
    tw = pymupdf.get_text_length(text, fontname="helv", fontsize=size)
    r = max(tw / 2 + mm(1.0), mm(3.2))
    if shape == "circle":
        sheet.circle((cx, cy), r, width=0.3)
    elif shape == "hexagon":
        rx, ry = r * 1.12, r * 0.8
        pts = [
            (cx - rx, cy),
            (cx - rx / 2, cy - ry),
            (cx + rx / 2, cy - ry),
            (cx + rx, cy),
            (cx + rx / 2, cy + ry),
            (cx - rx / 2, cy + ry),
        ]
        sheet.polyline(pts, width=0.3, closed=True)
    elif shape == "diamond":
        pts = [(cx - r * 1.2, cy), (cx, cy - r * 0.9), (cx + r * 1.2, cy), (cx, cy + r * 0.9)]
        sheet.polyline(pts, width=0.3, closed=True)
    elif shape == "rect":
        sheet.rect(cx - r, cy - r * 0.65, cx + r, cy + r * 0.65, width=0.3)
    return sheet.text(cx, cy + size * 0.35, text, size, align="center")


@dataclass
class TableSpec:
    title: str
    columns: list[str]
    col_widths_mm: list[float]
    rows: list[list[str]] = field(default_factory=list)


def draw_table(sheet: Sheet, x: float, y: float, spec: TableSpec, row_h_mm: float = 7.0) -> tuple[float, float, float, float]:
    """Draw a ruled schedule table with its title above. Returns bbox (pt)."""
    sheet.text(x, y, spec.title, 11, "hebo")
    sheet.line((x, y + mm(1.5)), (x + pymupdf.get_text_length(spec.title, "hebo", 11), y + mm(1.5)), 0.6)
    top = y + mm(5)
    total_w = mm(sum(spec.col_widths_mm))
    rh = mm(row_h_mm)
    n = len(spec.rows) + 1
    # horizontal rules
    for i in range(n + 1):
        wdt = 0.6 if i in (0, 1, n) else 0.2
        sheet.line((x, top + i * rh), (x + total_w, top + i * rh), wdt)
    # vertical rules
    cx = x
    xs = [x]
    for cw in spec.col_widths_mm:
        cx += mm(cw)
        xs.append(cx)
    for i, vx in enumerate(xs):
        sheet.line((vx, top), (vx, top + n * rh), 0.6 if i in (0, len(xs) - 1) else 0.2)
    # header + rows
    for r, row in enumerate([spec.columns] + spec.rows):
        base = top + r * rh + rh * 0.68
        for c, val in enumerate(row):
            font = "hebo" if r == 0 else "helv"
            sheet.text(xs[c] + mm(1.5), base, val, 6.5 if r else 6.2, font)
    return (x, y - mm(4), x + total_w, top + n * rh)
