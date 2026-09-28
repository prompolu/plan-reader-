"""PDF export (Summary and Detailed) with ReportLab.

Generated on request from the current database state, so exports always show
the final user-edited / verified values.
"""

from __future__ import annotations

import io
import os
from datetime import datetime, timezone
from typing import Any, Callable

from PIL import Image, ImageDraw
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A3, A4, LETTER, landscape, portrait
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    CondPageBreak,
    Image as RLImage,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .. import EXTRACTION_VERSION
from ..pipeline.units import format_length

PAGE_SIZES = {"A4": A4, "A3": A3, "LETTER": LETTER}
CHARCOAL = colors.HexColor("#1f2933")
MUTED = colors.HexColor("#5b6773")
BLUE = colors.HexColor("#1d4ed8")
LINE = colors.HexColor("#d5dae0")
HEAD_BG = colors.HexColor("#eef2f7")
AMBER = colors.HexColor("#b45309")
RED = colors.HexColor("#b91c1c")
GREEN = colors.HexColor("#15803d")

_FONT = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"


def _fonts() -> None:
    global _FONT, _FONT_BOLD
    if _FONT == "DejaVu":
        return
    for base in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/local/share/fonts"):
        reg, bold = os.path.join(base, "DejaVuSans.ttf"), os.path.join(base, "DejaVuSans-Bold.ttf")
        if os.path.exists(reg) and os.path.exists(bold):
            pdfmetrics.registerFont(TTFont("DejaVu", reg))
            pdfmetrics.registerFont(TTFont("DejaVu-Bold", bold))
            _FONT, _FONT_BOLD = "DejaVu", "DejaVu-Bold"
            return


def _styles() -> dict[str, ParagraphStyle]:
    return {
        "title": ParagraphStyle("title", fontName=_FONT_BOLD, fontSize=16, leading=20, textColor=CHARCOAL, spaceAfter=2),
        "h2": ParagraphStyle("h2", fontName=_FONT_BOLD, fontSize=11.5, leading=15, textColor=CHARCOAL, spaceBefore=10, spaceAfter=4),
        "h3": ParagraphStyle("h3", fontName=_FONT_BOLD, fontSize=10, leading=13, textColor=CHARCOAL, spaceBefore=6, spaceAfter=2),
        "body": ParagraphStyle("body", fontName=_FONT, fontSize=8.5, leading=11, textColor=CHARCOAL, alignment=TA_LEFT),
        "small": ParagraphStyle("small", fontName=_FONT, fontSize=7.2, leading=9, textColor=MUTED),
        "cell": ParagraphStyle("cell", fontName=_FONT, fontSize=8, leading=10, textColor=CHARCOAL),
        "cellb": ParagraphStyle("cellb", fontName=_FONT_BOLD, fontSize=8, leading=10, textColor=CHARCOAL),
        "head": ParagraphStyle("head", fontName=_FONT_BOLD, fontSize=7.5, leading=9, textColor=MUTED),
    }


def _esc(s: Any) -> str:
    return str(s if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _status_cell(row: dict, st: dict) -> Paragraph:
    if row["verified"]:
        return Paragraph('<font color="#15803d">Verified</font>', st["cell"])
    if row["status"] == "needs_review":
        return Paragraph('<font color="#b45309">Needs review</font>', st["cell"])
    return Paragraph('<font color="#5b6773">Unverified</font>', st["cell"])


def _meas_cell(text: str, status: str, st: dict) -> Paragraph:
    if status == "conflict":
        return Paragraph(f'<font color="#b91c1c">{_esc(text)}</font>', st["cell"])
    if status == "missing":
        return Paragraph('<font color="#b45309">Needs review</font>', st["cell"])
    return Paragraph(_esc(text), st["cell"])


def build_pdf(
    *,
    project: dict[str, Any],
    info: dict[str, Any],
    schedule: dict[str, Any],
    openings: list[dict[str, Any]],
    kind: str = "summary",
    page_size: str = "A4",
    orientation: str = "portrait",
    include_notes: bool = True,
    crop_provider: Callable[[dict[str, Any]], bytes | None] | None = None,
    generated_by: str | None = None,
) -> bytes:
    _fonts()
    st = _styles()
    size = PAGE_SIZES.get(page_size.upper(), A4)
    size = landscape(size) if orientation == "landscape" else portrait(size)
    buf = io.BytesIO()
    title = info.get("project_name") or project.get("name") or "Project"
    doc = SimpleDocTemplate(
        buf,
        pagesize=size,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=24 * mm,
        bottomMargin=16 * mm,
        title=f"{title} - Measurement schedule",
        author=info.get("prepared_by") or "PlanMeasure AI",
        subject="Opening measurement schedule",
        creator="PlanMeasure AI",
    )
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    date_txt = info.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    unit = schedule["unit"]

    def on_page(c, d):
        c.saveState()
        w, h = size
        c.setStrokeColor(LINE)
        c.setLineWidth(0.6)
        c.line(14 * mm, h - 17 * mm, w - 14 * mm, h - 17 * mm)
        c.setFillColor(CHARCOAL)
        c.setFont(_FONT_BOLD, 10.5)
        c.drawString(14 * mm, h - 12 * mm, title[:90])
        c.setFont(_FONT, 8)
        c.setFillColor(MUTED)
        sub = " · ".join(x for x in [info.get("drawing_set_name"), f"Date {date_txt}"] if x)
        c.drawString(14 * mm, h - 15.5 * mm, sub[:140])
        c.drawRightString(w - 14 * mm, h - 12 * mm, "Measurement Schedule" + (" — Detailed" if kind == "detailed" else ""))
        c.line(14 * mm, 11 * mm, w - 14 * mm, 11 * mm)
        c.setFont(_FONT, 7)
        c.drawString(14 * mm, 7 * mm, f"PlanMeasure AI · extraction v{EXTRACTION_VERSION} · generated {generated} from the current reviewed data")
        c.drawRightString(w - 14 * mm, 7 * mm, f"Page {d.page}")
        c.restoreState()

    story: list = []
    story.append(Paragraph("Opening Measurement Schedule", st["title"]))
    # project information
    rows = []
    for label, key in (("Project name", "project_name"), ("Drawing set", "drawing_set_name"), ("Project address", "project_address"), ("Prepared by", "prepared_by"), ("Date", "date")):
        val = info.get(key) or (project.get("name") if key == "project_name" else None)
        if val:
            rows.append([Paragraph(label, st["head"]), Paragraph(_esc(val), st["body"])])
    if rows:
        t = Table(rows, colWidths=[35 * mm, None], hAlign="LEFT")
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 2)]))
        story.append(t)
    story.append(Spacer(1, 4 * mm))
    summ = (
        f"<b>{schedule['total_openings']}</b> openings in {sum(len(g['rows']) for g in schedule['groups'])} schedule rows. "
        f"Dimensions in {'feet and inches' if unit == 'ft_in' else ('original drawing notation' if unit == 'original' else unit)}."
    )
    if schedule["unverified_count"]:
        summ += f' <font color="#b45309"><b>{schedule["unverified_count"]} item(s) are not yet verified</b></font> and are marked in the status column.'
    story.append(Paragraph(summ, st["body"]))
    if schedule.get("has_inferred"):
        story.append(Paragraph("* Inferred from the drawing scale – not an explicitly dimensioned value.", st["small"]))
    if include_notes and info.get("notes"):
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph("<b>Notes</b>", st["body"]))
        for line in str(info["notes"]).splitlines():
            story.append(Paragraph(_esc(line) or "&nbsp;", st["body"]))

    avail = size[0] - 28 * mm
    for g in schedule["groups"]:
        story.append(CondPageBreak(40 * mm))
        story.append(Paragraph(_esc(g["title"]), st["h2"]))
        head = ["Tag", "Type", "Width", "Height", "Qty", "Drawing ref", "Floor", "Status"]
        if include_notes:
            head.append("Notes")
        data = [[Paragraph(h, st["head"]) for h in head]]
        for r in g["rows"]:
            row = [
                Paragraph(f"<b>{_esc(r['tag'])}</b>", st["cell"]),
                Paragraph(_esc(r["type_label"]), st["cell"]),
                _meas_cell(r["width"], r["width_status"], st),
                _meas_cell(r["height"], r["height_status"], st),
                Paragraph(str(r["quantity"]), st["cellb"]),
                Paragraph(_esc(r["drawing_reference"]), st["cell"]),
                Paragraph(_esc(r["floor"]), st["cell"]),
                _status_cell(r, st),
            ]
            if include_notes:
                row.append(Paragraph(_esc(r["notes"]), st["small"]))
            data.append(row)
        data.append([Paragraph("", st["cell"])] * 3 + [Paragraph("Total", st["head"]), Paragraph(f"<b>{g['total_quantity']}</b>", st["cell"])] + [Paragraph("", st["cell"])] * (len(head) - 5))
        fr = [0.09, 0.14, 0.13, 0.13, 0.06, 0.13, 0.12, 0.1] + ([0.1] if include_notes else [])
        tot = sum(fr)
        t = Table(data, colWidths=[avail * f / tot for f in fr], repeatRows=1)
        t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
                    ("LINEBELOW", (0, 0), (-1, 0), 0.8, CHARCOAL),
                    ("LINEBELOW", (0, 1), (-1, -2), 0.3, LINE),
                    ("LINEABOVE", (0, -1), (-1, -1), 0.8, CHARCOAL),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(t)

    if kind == "detailed":
        story.append(CondPageBreak(80 * mm))
        story.append(Paragraph("Source detail for each opening", st["h2"]))
        story.append(Paragraph("Each crop shows the opening (red) and the dimension used for its size (blue) on the source drawing.", st["small"]))
        for o in openings:
            story.append(_detail_block(o, st, unit, crop_provider, avail))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def _fmt_m(m: dict | None, unit: str) -> str:
    if m is None:
        return "Needs review (not found on the drawings)"
    if m.get("status") == "conflict":
        return "CONFLICT – " + " vs ".join(f"{c['label']}: {c['original_text']}" for c in m.get("candidates", []))
    txt = format_length(m.get("value"), unit, m.get("original_text"))
    src = {
        "explicit_dimension": "dimension on drawing",
        "callout": "size callout",
        "schedule": "schedule",
        "drawing_scale": "inferred from drawing scale",
        "user": "entered/confirmed by user",
    }.get(m.get("source"), m.get("source") or "")
    orig = f' (drawing text "{m["original_text"]}")' if m.get("original_text") and m.get("source") not in ("user",) and unit != "original" else ""
    return f"{txt}{orig} – {src}"


def _detail_block(o: dict[str, Any], st, unit: str, crop_provider, avail: float):
    parts: list = []
    head = f"{_esc(o['tag'] or 'Untagged')} — {_esc(o['type_label'])}  <font size=8 color='#5b6773'>{_esc(o['ref'])}</font>"
    parts.append(Paragraph(head, st["h3"]))
    facts = [
        ("Width", _fmt_m(o["width"], unit)),
        ("Height", _fmt_m(o["height"], unit)),
        ("Quantity", f"{o['quantity']}" + (f" ({o['quantity_basis'].replace('_', ' ')})" if o.get("quantity_basis") else "")),
        ("Source page", f"{o.get('drawing_reference') or '—'} (page {o['page']})" if o.get("page") else "—"),
        ("Status", "Verified" if o["verification"]["verified"] else ("Needs review" if o["status"] == "needs_review" else "Unverified")),
        ("Confidence", f"{round((o['confidence'].get('overall') or 0) * 100)}%"),
    ]
    if o.get("notes"):
        facts.append(("Notes", o["notes"]))
    open_flags = [f["message"] for f in o.get("flags", []) if f.get("severity") in ("warning", "error")] if not o["verification"]["verified"] else []
    if open_flags:
        facts.append(("Open issues", "; ".join(open_flags[:4])))
    ft = Table([[Paragraph(k, st["head"]), Paragraph(_esc(v), st["cell"])] for k, v in facts], colWidths=[26 * mm, None])
    ft.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5)]))
    img = None
    if crop_provider is not None:
        try:
            png = crop_provider(o)
        except Exception:
            png = None
        if png:
            pil = Image.open(io.BytesIO(png))
            w = min(78 * mm, avail * 0.45)
            h = w * pil.height / pil.width
            if h > 70 * mm:
                h = 70 * mm
                w = h * pil.width / pil.height
            img = RLImage(io.BytesIO(png), width=w, height=h)
    if img is not None:
        t = Table([[img, ft]], colWidths=[img.drawWidth + 4 * mm, None])
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (0, 0), 0)]))
        parts.append(t)
    else:
        parts.append(ft)
    parts.append(Spacer(1, 3 * mm))
    return KeepTogether(parts)


def crop_with_highlight(page_png: bytes, page_w: float, page_h: float, bbox: dict, dims: list[dict], margin_frac: float = 0.8) -> bytes:
    """Crop a page image around an opening and draw highlights."""
    img = Image.open(io.BytesIO(page_png)).convert("RGB")
    k = img.width / page_w
    x0, y0 = bbox["x"], bbox["y"]
    x1, y1 = x0 + bbox["width"], y0 + bbox["height"]
    for d in dims:
        for b in (d.get("bbox"),):
            if b:
                x0, y0 = min(x0, b["x"]), min(y0, b["y"])
                x1, y1 = max(x1, b["x"] + b["width"]), max(y1, b["y"] + b["height"])
    size = max(x1 - x0, y1 - y0)
    pad = max(size * margin_frac, 25)
    cx0, cy0 = max(0, (x0 - pad) * k), max(0, (y0 - pad) * k)
    cx1, cy1 = min(img.width, (x1 + pad) * k), min(img.height, (y1 + pad) * k)
    crop = img.crop((int(cx0), int(cy0), int(cx1), int(cy1)))
    draw = ImageDraw.Draw(crop, "RGBA")

    def rect(b, color, width):
        draw.rectangle(
            [b["x"] * k - cx0, b["y"] * k - cy0, (b["x"] + b["width"]) * k - cx0, (b["y"] + b["height"]) * k - cy0],
            outline=color,
            width=width,
        )

    for d in dims:
        if d.get("line"):
            ln = d["line"]
            draw.line([ln["x0"] * k - cx0, ln["y0"] * k - cy0, ln["x1"] * k - cx0, ln["y1"] * k - cy0], fill=(29, 78, 216, 255), width=3)
        if d.get("bbox"):
            rect(d["bbox"], (29, 78, 216, 255), 2)
    rect(bbox, (220, 38, 38, 255), 3)
    # keep the crop a reasonable size
    max_side = 900
    if max(crop.size) > max_side:
        crop.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()
