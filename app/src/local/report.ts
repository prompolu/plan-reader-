/**
 * PDF export (Summary and Detailed), generated on this device with jsPDF.
 *
 * Built on request from the current stored state, so exports always show the
 * final user-edited / verified values. Layout follows the original ReportLab
 * report: header and footer on every page, project information, a summary
 * line, one table per schedule group and (Detailed) a source block per opening
 * with a crop of the drawing.
 */
import { jsPDF } from "jspdf";
import autoTable, { type CellHookData } from "jspdf-autotable";
import { EXTRACTION_VERSION } from "../engine/meta";
import { OPENING_TYPE_LABELS, type BBoxDict } from "../engine/types";
import { formatLength } from "../engine/units";
import type { MeasurementRow, OpeningRow, PageRow } from "./db";
import { imageBlob } from "./images";
import type { ScheduleGroup } from "./schedule";
import { num, t, tp, tx } from "../i18n";

type RGB = [number, number, number];
const CHARCOAL: RGB = [0x1f, 0x29, 0x33];
const MUTED: RGB = [0x5b, 0x67, 0x73];
const LINE: RGB = [0xd5, 0xda, 0xe0];
const HEAD_BG: RGB = [0xee, 0xf2, 0xf7];
const AMBER: RGB = [0xb4, 0x53, 0x09];
const RED: RGB = [0xb9, 0x1c, 0x1c];
const GREEN: RGB = [0x15, 0x80, 0x3d];

/** one typographic point in millimetres */
const PT = 25.4 / 72;
const M_LEFT = 14;
const M_RIGHT = 14;
const M_TOP = 24;
const M_BOTTOM = 16;

export interface ReportSchedule {
  unit: string;
  groups: ScheduleGroup[];
  total_openings: number;
  unverified_count: number;
  has_inferred: boolean;
}

export interface CropImage {
  data: Uint8Array;
  format: "JPEG" | "PNG";
  width: number;
  height: number;
}

export interface ReportInput {
  projectName: string;
  info: Record<string, string | null | undefined>;
  schedule: ReportSchedule;
  openings: OpeningRow[];
  pages: PageRow[];
  kind: "summary" | "detailed";
  pageSize: "A4" | "A3" | "LETTER";
  orientation: "portrait" | "landscape";
  includeNotes: boolean;
  generatedBy?: string | null;
  /** crop provider for Detailed reports; defaults to the stored page images */
  crop?: (o: OpeningRow, page: PageRow) => Promise<CropImage | null>;
  /** fixed timestamp (tests) */
  now?: Date;
}

// ---------------------------------------------------------------------------
// text encoding: the built-in PDF fonts cover Windows-1252 only
// ---------------------------------------------------------------------------

const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const SUBSTITUTE: Record<string, string> = {
  "′": "'",
  "″": '"',
  "‴": "'''",
  "≈": "~",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "→": "->",
  "←": "<-",
  "✓": "v",
  "✔": "v",
  "✗": "x",
  "−": "-",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "⁄": "/",
  " ": " ",
  " ": " ",
  " ": " ",
  "\t": " ",
};

/** Map text onto characters the standard PDF fonts can show. */
export function pdfSafe(s: unknown): string {
  const str = String(s ?? "").normalize("NFC");
  let out = "";
  for (const ch of str) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch)) out += ch === " " ? " " : ch;
    else if (SUBSTITUTE[ch] !== undefined) out += SUBSTITUTE[ch];
    else if (c === 0x0a || c === 0x0d) out += " ";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0) || (c >= 0x300 && c < 0x370) || c === 0x200b || c === 0xfeff) continue;
    else out += "?";
  }
  return out;
}

// ---------------------------------------------------------------------------
// value formatting
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  explicit_dimension: "dimension on drawing",
  callout: "size callout",
  schedule: "schedule",
  drawing_scale: "inferred from drawing scale",
  user: "entered/confirmed by user",
};

function unitLabel(unit: string): string {
  return unit === "ft_in" ? t("feet and inches") : unit === "original" ? t("original drawing notation") : unit;
}

export function measurementDetail(m: MeasurementRow | null, unit: string): string {
  if (!m) return t("Needs review (not found on the drawings)");
  if (m.status === "conflict") {
    const cands = (m.candidates ?? []).map((c) => `${c.label ?? "?"}: ${c.original_text ?? "?"}`);
    return t("CONFLICT – {values}", { values: cands.join(` ${t("vs")} `) });
  }
  const raw = formatLength(m.value, unit, m.original_text);
  const txt = unit === "cm" || unit === "m" ? num(raw) : raw;
  const src = t(SOURCE_LABEL[m.source] ?? m.source ?? "");
  const orig = m.original_text && m.source !== "user" && unit !== "original" ? ` (${t("drawing text “{t}”", { t: m.original_text })})` : "";
  return `${txt}${orig} – ${src}`;
}

function statusText(verified: boolean, status: string): [string, RGB] {
  if (verified) return [t("Verified"), GREEN];
  if (status === "needs_review") return [t("Needs review"), AMBER];
  return [t("Unverified"), MUTED];
}

// ---------------------------------------------------------------------------
// layout helpers
// ---------------------------------------------------------------------------

interface Run {
  text: string;
  bold?: boolean;
  color?: RGB;
  size?: number;
}

class Flow {
  y = M_TOP;
  readonly pageW: number;
  readonly pageH: number;
  readonly avail: number;
  constructor(readonly doc: jsPDF) {
    this.pageW = doc.internal.pageSize.getWidth();
    this.pageH = doc.internal.pageSize.getHeight();
    this.avail = this.pageW - M_LEFT - M_RIGHT;
  }

  get bottom(): number {
    return this.pageH - M_BOTTOM;
  }

  newPage(): void {
    this.doc.addPage();
    this.y = M_TOP;
  }

  /** Start a new page unless `h` millimetres still fit on this one. */
  need(h: number): void {
    if (this.y + h > this.bottom && this.y > M_TOP + 0.01) this.newPage();
  }

  font(bold: boolean, size: number, color: RGB = CHARCOAL): void {
    this.doc.setFont("helvetica", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(...color);
  }

  /** Break rich text into lines no wider than `width` (mm). */
  layout(runs: Run[], size: number, width: number): Run[][] {
    const lines: Run[][] = [[]];
    let x = 0;
    for (const run of runs) {
      const fs = run.size ?? size;
      this.font(!!run.bold, fs);
      for (const tok of pdfSafe(run.text).split(/(?<=\s)/)) {
        if (!tok) continue;
        let piece = tok;
        let w = this.doc.getTextWidth(piece);
        if (x + w > width && x > 0) {
          lines.push([]);
          x = 0;
          piece = piece.replace(/^\s+/, "");
          w = this.doc.getTextWidth(piece);
        }
        // hard-break words longer than a line
        while (w > width && piece.length > 1) {
          let n = piece.length - 1;
          while (n > 1 && this.doc.getTextWidth(piece.slice(0, n)) > width - x) n--;
          lines[lines.length - 1].push({ ...run, text: piece.slice(0, n) });
          lines.push([]);
          x = 0;
          piece = piece.slice(n);
          w = this.doc.getTextWidth(piece);
        }
        if (piece) {
          lines[lines.length - 1].push({ ...run, text: piece });
          x += w;
        }
      }
    }
    return lines.filter((l, i) => l.length || i === 0);
  }

  /** Draw rich text lines at (x, y); returns the height used. */
  drawLines(lines: Run[][], x: number, y: number, size: number, leading: number, color: RGB = CHARCOAL): number {
    let yy = y;
    for (const line of lines) {
      let xx = x;
      const base = yy + (leading * PT + size * PT * 0.72) / 2;
      for (const r of line) {
        this.font(!!r.bold, r.size ?? size, r.color ?? color);
        const txt = pdfSafe(r.text);
        this.doc.text(txt, xx, base);
        xx += this.doc.getTextWidth(txt);
      }
      yy += leading * PT;
    }
    return yy - y;
  }

  /** A flowing paragraph with page breaks between lines. */
  para(runs: Run[], size: number, leading: number, opts: { color?: RGB; before?: number; after?: number; x?: number; width?: number } = {}): void {
    const x = opts.x ?? M_LEFT;
    const width = opts.width ?? this.avail - (x - M_LEFT);
    if (opts.before) this.y += opts.before * PT;
    const lines = this.layout(runs, size, width);
    this.need(Math.min(lines.length, 2) * leading * PT);
    for (const line of lines) {
      this.need(leading * PT);
      this.y += this.drawLines([line], x, this.y, size, leading, opts.color);
    }
    if (opts.after) this.y += opts.after * PT;
  }
}

// ---------------------------------------------------------------------------
// crops
// ---------------------------------------------------------------------------

type Bitmap = { width: number; height: number; close?: () => void } & CanvasImageSource;

/** Crops from the stored page images, drawn with the same highlights as the review screen. */
export function storedImageCrops(): { crop: (o: OpeningRow, page: PageRow) => Promise<CropImage | null>; close: () => void } {
  const cache = new Map<string, Promise<Bitmap | null>>();
  const bitmap = (page: PageRow): Promise<Bitmap | null> => {
    let b = cache.get(page.id);
    if (!b) {
      b = imageBlob(`${page.id}:image`).then((blob) => (blob ? (createImageBitmap(blob) as Promise<Bitmap>) : null)).catch(() => null);
      cache.set(page.id, b);
      // keep at most two decoded pages in memory
      while (cache.size > 2) {
        const [k, old] = cache.entries().next().value!;
        cache.delete(k);
        void old.then((x) => x?.close?.());
      }
    }
    return b;
  };
  return {
    crop: async (o, page) => {
      const img = await bitmap(page);
      if (!img || !o.bbox || !page.width) return null;
      return cropWithHighlight(img, page.width, o.bbox, dimsFor(o));
    },
    close: () => {
      for (const b of cache.values()) void b.then((x) => x?.close?.());
      cache.clear();
    },
  };
}

interface DimMark {
  bbox: BBoxDict;
  line: { x0: number; y0: number; x1: number; y1: number } | null;
}

function dimsFor(o: OpeningRow): DimMark[] {
  const out: DimMark[] = [];
  for (const m of [o.width, o.height]) {
    if (m && m.page_index === o.page_index && m.bbox) out.push({ bbox: m.bbox, line: (m.line as DimMark["line"]) ?? null });
  }
  return out;
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function canvasJpeg(c: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob =
    "convertToBlob" in c
      ? await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })
      : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("crop failed"))), "image/jpeg", 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Crop a page image around an opening: opening in red, its dimensions in blue. */
async function cropWithHighlight(img: Bitmap, pageW: number, bbox: BBoxDict, dims: DimMark[], marginFrac = 0.8, maxSide = 900): Promise<CropImage | null> {
  const k = img.width / pageW;
  let x0 = bbox.x;
  let y0 = bbox.y;
  let x1 = x0 + bbox.width;
  let y1 = y0 + bbox.height;
  for (const d of dims) {
    x0 = Math.min(x0, d.bbox.x);
    y0 = Math.min(y0, d.bbox.y);
    x1 = Math.max(x1, d.bbox.x + d.bbox.width);
    y1 = Math.max(y1, d.bbox.y + d.bbox.height);
  }
  const pad = Math.max(Math.max(x1 - x0, y1 - y0) * marginFrac, 25);
  const cx0 = Math.floor(Math.max(0, (x0 - pad) * k));
  const cy0 = Math.floor(Math.max(0, (y0 - pad) * k));
  const cx1 = Math.floor(Math.min(img.width, (x1 + pad) * k));
  const cy1 = Math.floor(Math.min(img.height, (y1 + pad) * k));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw < 2 || ch < 2) return null;
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const W = Math.max(1, Math.round(cw * s));
  const H = Math.max(1, Math.round(ch * s));
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, cx0, cy0, cw, ch, 0, 0, W, H);
  const px = (v: number, o: number) => (v * k - o) * s;
  const rect = (b: BBoxDict, color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(px(b.x, cx0), px(b.y, cy0), b.width * k * s, b.height * k * s);
  };
  for (const d of dims) {
    if (d.line) {
      ctx.strokeStyle = "rgb(29,78,216)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px(d.line.x0, cx0), px(d.line.y0, cy0));
      ctx.lineTo(px(d.line.x1, cx0), px(d.line.y1, cy0));
      ctx.stroke();
    }
    rect(d.bbox, "rgb(29,78,216)", 2);
  }
  rect(bbox, "rgb(220,38,38)", 3);
  return { data: await canvasJpeg(c), format: "JPEG", width: W, height: H };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function utcStamp(d: Date, withTime: boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC` : date;
}

export async function buildReport(input: ReportInput): Promise<Blob> {
  const bytes = await buildReportBytes(input);
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

export async function buildReportBytes(input: ReportInput): Promise<Uint8Array> {
  const { info, schedule, kind, includeNotes } = input;
  const now = input.now ?? new Date();
  const doc = new jsPDF({ unit: "mm", format: input.pageSize.toLowerCase(), orientation: input.orientation, compress: true });
  const title = pdfSafe(info.project_name || input.projectName || t("Project"));
  doc.setProperties({
    title: `${title} - ${pdfSafe(t("Measurement schedule"))}`,
    author: pdfSafe(info.prepared_by || input.generatedBy || "PlanMeasure AI"),
    subject: pdfSafe(t("Opening measurement schedule")),
    creator: "PlanMeasure AI",
  });
  const f = new Flow(doc);
  const unit = schedule.unit;

  // title and project information
  f.para([{ text: t("Opening Measurement Schedule"), bold: true }], 16, 20, { after: 2 });
  const infoRows: [string, string][] = [];
  for (const [label, key] of [
    [t("Project name"), "project_name"],
    [t("Drawing set"), "drawing_set_name"],
    [t("Project address"), "project_address"],
    [t("Prepared by"), "prepared_by"],
    [t("Date"), "date"],
  ] as const) {
    const v = info[key] || (key === "project_name" ? input.projectName : null);
    if (v) infoRows.push([label, v]);
  }
  for (const [label, v] of infoRows) {
    const lines = f.layout([{ text: v }], 8.5, f.avail - 35);
    const h = lines.length * 11 * PT + 4 * PT;
    f.need(h);
    f.drawLines([[{ text: label, bold: true }]], M_LEFT, f.y + 2 * PT, 7.5, 11, MUTED);
    f.drawLines(lines, M_LEFT + 35, f.y + 2 * PT, 8.5, 11);
    f.y += h;
  }
  f.y += 4;

  const rowCount = schedule.groups.reduce((a, g) => a + g.rows.length, 0);
  const summary: Run[] = [
    { text: tp(schedule.total_openings, "{n} opening", "{n} openings"), bold: true },
    { text: " " + t("in {r} schedule rows. Dimensions in {unit}.", { r: rowCount, unit: unitLabel(unit) }) },
  ];
  if (schedule.unverified_count) {
    summary.push({ text: " " }, { text: t("{n} item(s) are not yet verified", { n: schedule.unverified_count }), bold: true, color: AMBER }, { text: " " + t("and are marked in the status column.") });
  }
  f.para(summary, 8.5, 11);
  if (schedule.has_inferred) f.para([{ text: "* " + t("Inferred from the drawing scale – not an explicitly dimensioned value.") }], 7.2, 9, { color: MUTED });
  if (includeNotes && info.notes) {
    f.y += 2;
    f.para([{ text: t("Notes"), bold: true }], 8.5, 11);
    for (const line of String(info.notes).split(/\r?\n/)) f.para([{ text: line || " " }], 8.5, 11);
  }

  // one table per group
  const head = [t("Tag"), t("Type"), t("Width"), t("Height"), t("Qty"), t("Drawing ref"), t("Floor"), t("Status"), ...(includeNotes ? [t("Notes")] : [])].map(pdfSafe);
  const fr = [0.09, 0.14, 0.13, 0.13, 0.06, 0.13, 0.12, 0.1, ...(includeNotes ? [0.1] : [])];
  const frTotal = fr.reduce((a, b) => a + b, 0);
  const columnStyles = Object.fromEntries(fr.map((x, i) => [i, { cellWidth: (f.avail * x) / frTotal }]));
  for (const g of schedule.groups) {
    f.need(40);
    f.para([{ text: g.title, bold: true }], 11.5, 15, { before: 10, after: 4 });
    const body = g.rows.map((r) => {
      const meas = (text: string, st: string) => (st === "missing" ? t("Needs review") : text);
      const row = [r.tag, r.type_label, meas(r.width, r.width_status), meas(r.height, r.height_status), String(r.quantity), r.drawing_reference, r.floor, statusText(r.verified, r.status)[0]];
      if (includeNotes) row.push(r.notes);
      return row.map(pdfSafe);
    });
    const foot = [["", "", "", pdfSafe(t("Total")), String(g.total_quantity), ...head.slice(5).map(() => "")]];
    autoTable(doc, {
      theme: "plain",
      head: [head],
      body,
      foot,
      startY: f.y,
      showHead: "everyPage",
      showFoot: "lastPage",
      rowPageBreak: "avoid",
      margin: { left: M_LEFT, right: M_RIGHT, top: M_TOP, bottom: M_BOTTOM },
      tableWidth: f.avail,
      columnStyles,
      styles: { font: "helvetica", fontSize: 8, textColor: CHARCOAL, cellPadding: { top: 3 * PT, bottom: 3 * PT, left: 1.6, right: 1.6 }, valign: "middle", overflow: "linebreak", lineWidth: 0, minCellHeight: 0 },
      headStyles: { fillColor: HEAD_BG, textColor: MUTED, fontStyle: "bold", fontSize: 7.5, lineWidth: { bottom: 0.8 * PT }, lineColor: CHARCOAL },
      bodyStyles: { fillColor: false as unknown as RGB, lineWidth: { bottom: 0.3 * PT }, lineColor: LINE },
      footStyles: { fillColor: false as unknown as RGB, textColor: CHARCOAL, fontStyle: "normal", fontSize: 8, lineWidth: { top: 0.8 * PT }, lineColor: CHARCOAL },
      didParseCell: (d: CellHookData) => {
        const col = d.column.index;
        if (d.section === "foot") {
          if (col === 3) Object.assign(d.cell.styles, { textColor: MUTED, fontStyle: "bold", fontSize: 7.5 });
          if (col === 4) d.cell.styles.fontStyle = "bold";
          return;
        }
        if (d.section !== "body") return;
        const r = g.rows[d.row.index];
        if (col === 0 || col === 4) d.cell.styles.fontStyle = "bold";
        else if (col === 2 || col === 3) {
          const st = col === 2 ? r.width_status : r.height_status;
          if (st === "conflict") d.cell.styles.textColor = RED;
          else if (st === "missing") d.cell.styles.textColor = AMBER;
        } else if (col === 7) d.cell.styles.textColor = statusText(r.verified, r.status)[1];
        else if (col === 8) Object.assign(d.cell.styles, { fontSize: 7.2, textColor: MUTED });
      },
    });
    f.y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  }

  // detailed: one source block per opening
  if (kind === "detailed") {
    f.need(80);
    f.para([{ text: t("Source detail for each opening"), bold: true }], 11.5, 15, { before: 10, after: 4 });
    f.para([{ text: t("Each crop shows the opening (red) and the dimension used for its size (blue) on the source drawing.") }], 7.2, 9, { color: MUTED });
    const pageByIndex = new Map(input.pages.map((p) => [p.page_index, p]));
    const stored = input.crop ? null : storedImageCrops();
    const crop = input.crop ?? stored!.crop;
    // same order as the schedule tables
    const order = new Map<string, number>();
    for (const g of schedule.groups) for (const r of g.rows) if (!order.has(r.id)) order.set(r.id, order.size);
    const ordered = [...input.openings].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    try {
      for (const o of ordered) {
        const page = o.page_index !== null ? pageByIndex.get(o.page_index) : undefined;
        let img: CropImage | null = null;
        if (page && page.has_image && o.bbox) {
          try {
            img = await crop(o, page);
          } catch {
            img = null;
          }
        }
        detailBlock(f, o, unit, img);
      }
    } finally {
      stored?.close();
    }
  }

  // header and footer on every page
  const generated = utcStamp(now, true);
  const dateTxt = pdfSafe(info.date || utcStamp(now, false));
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    const w = f.pageW;
    const h = f.pageH;
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.6 * PT);
    doc.line(M_LEFT, 17, w - M_RIGHT, 17);
    f.font(true, 10.5);
    doc.text(title.slice(0, 90), M_LEFT, 12);
    f.font(false, 8, MUTED);
    const sub = [info.drawing_set_name ? pdfSafe(info.drawing_set_name) : null, pdfSafe(t("Date {d}", { d: dateTxt }))].filter(Boolean).join(" · ");
    doc.text(sub.slice(0, 140), M_LEFT, 15.5);
    doc.text(pdfSafe(kind === "detailed" ? t("Measurement Schedule — Detailed") : t("Measurement Schedule")), w - M_RIGHT, 12, { align: "right" });
    doc.line(M_LEFT, h - 11, w - M_RIGHT, h - 11);
    f.font(false, 7, MUTED);
    doc.text(pdfSafe(t("PlanMeasure AI · extraction v{v} · generated {g} from the current reviewed data", { v: EXTRACTION_VERSION, g: generated })), M_LEFT, h - 7);
    doc.text(pdfSafe(t("Page {i} of {n}", { i, n })), w - M_RIGHT, h - 7, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

function detailBlock(f: Flow, o: OpeningRow, unit: string, img: CropImage | null): void {
  const typeLabel = tx(OPENING_TYPE_LABELS[o.type] ?? o.type);
  const heading: Run[] = [
    { text: `${o.tag || t("Untagged")} — ${typeLabel}  `, bold: true },
    { text: o.ref, size: 8, color: MUTED },
  ];
  const [status] = statusText(o.verified, o.status);
  const facts: [string, string][] = [
    [t("Width"), measurementDetail(o.width, unit)],
    [t("Height"), measurementDetail(o.height, unit)],
    [t("Quantity"), `${o.quantity ?? 0}` + (o.quantity_basis ? ` (${t(o.quantity_basis.replace(/_/g, " "))})` : "")],
    [t("Source page"), o.page_index !== null ? `${o.drawing_reference || "—"} (${t("page {n}", { n: o.page_index + 1 })})` : "—"],
    [t("Status"), status],
    [t("Confidence"), `${Math.round((o.confidence?.overall ?? 0) * 100)}%`],
  ];
  if (o.notes) facts.push([t("Notes"), o.notes]);
  const open = !o.verified ? (o.flags ?? []).filter((x) => x.severity === "warning" || x.severity === "error").map((x) => tx(x.message)) : [];
  if (open.length) facts.push([t("Open issues"), open.slice(0, 4).join("; ")]);

  let iw = 0;
  let ih = 0;
  if (img) {
    iw = Math.min(78, f.avail * 0.45);
    ih = (iw * img.height) / img.width;
    if (ih > 70) {
      ih = 70;
      iw = (ih * img.width) / img.height;
    }
  }
  const fx = M_LEFT + (img ? iw + 4 : 0);
  const labelW = 26;
  const valueW = f.avail - (fx - M_LEFT) - labelW;
  const factLines = facts.map(([k, v]) => [k, f.layout([{ text: v }], 8, valueW - 2)] as const);
  const rowH = (lines: Run[][]) => lines.length * 10 * PT + 3 * PT;
  const factsH = factLines.reduce((a, [, lines]) => a + rowH(lines), 0);
  const headLines = f.layout(heading, 10, f.avail);
  const headH = 6 * PT + headLines.length * 13 * PT + 2 * PT;
  const blockH = headH + Math.max(ih, factsH) + 3;

  // keep the block together when it fits on a page
  if (f.y + blockH > f.bottom && blockH <= f.bottom - M_TOP) f.newPage();
  else f.need(headH + Math.min(ih, 30));
  f.y += 6 * PT;
  f.y += f.drawLines(headLines, M_LEFT, f.y, 10, 13);
  f.y += 2 * PT;

  const top = f.y;
  const startPage = f.doc.getCurrentPageInfo().pageNumber;
  if (img) f.doc.addImage(img.data, img.format, M_LEFT, top, iw, ih, undefined, "FAST");
  let y = top;
  for (const [k, lines] of factLines) {
    const h = rowH(lines);
    if (y + h > f.bottom) {
      f.newPage();
      y = f.y;
    }
    f.drawLines([[{ text: k, bold: true }]], fx, y + 1.5 * PT, 7.5, 10, MUTED);
    f.drawLines(lines, fx + labelW, y + 1.5 * PT, 8, 10);
    y += h;
  }
  // the image only extends the block on the page it was drawn on
  f.y = (f.doc.getCurrentPageInfo().pageNumber === startPage ? Math.max(y, top + ih) : y) + 3;
}
