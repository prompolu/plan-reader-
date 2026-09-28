/**
 * PDF parsing with PDF.js. Produces the same page model PyMuPDF did for the
 * original pipeline: text lines with per-character boxes, and drawn paths as
 * line / rect / quad / curve items in displayed (rotation-applied) points.
 */
import { BBox, TextLine, newQuality, type PageData, type Pt } from "./types";
import { extractVectorGeometry, type DrawingPath, type PathItem } from "./geometry";
import { platform, type RgbaImage } from "./platform";
import { degrees } from "./py";

export const PDF_MM_PER_PT = 25.4 / 72;

type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 then m2 (PDF.js Util.transform order: apply m2 first, then m1). */
function mul(m1: Mat, m2: Mat): Mat {
  return [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
}

function apply(m: Mat, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const f32 = Math.fround;

/** fz_concat in single precision: apply `one` first, then `two`. */
function concat32(one: Mat, two: Mat): Mat {
  const [a1, b1, c1, d1, e1, g1] = one.map(f32);
  const [a2, b2, c2, d2, e2, g2] = two.map(f32);
  return [
    f32(f32(a1 * a2) + f32(b1 * c2)),
    f32(f32(a1 * b2) + f32(b1 * d2)),
    f32(f32(c1 * a2) + f32(d1 * c2)),
    f32(f32(c1 * b2) + f32(d1 * d2)),
    f32(f32(f32(e1 * a2) + f32(g1 * c2)) + e2),
    f32(f32(f32(e1 * b2) + f32(g1 * d2)) + g2),
  ];
}

/** fz_transform_point in single precision. */
function apply32(m: Mat, x: number, y: number): Pt {
  const px = f32(x);
  const py = f32(y);
  return [f32(f32(f32(px * m[0]) + f32(py * m[2])) + m[4]), f32(f32(f32(px * m[1]) + f32(py * m[3])) + m[5])];
}

function inverse(m: Mat): Mat {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}

interface PChar {
  c: string;
  box: BBox;
  size: number;
}

interface Run {
  chars: PChar[];
  dir: Pt; // displayed reading direction (unit)
  angle: number;
  origin: Pt; // displayed baseline origin
  end: Pt; // displayed baseline end
  size: number;
  hlen: number;
}

export class PdfDocument {
  readonly kind = "pdf";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(
    private doc: any,
    readonly filename: string,
  ) {}

  static async open(data: Uint8Array, filename = "document.pdf"): Promise<PdfDocument> {
    const { pdfjs, standardFontDataUrl } = platform();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: data.slice(), verbosity: 0, isEvalSupported: false, standardFontDataUrl, useSystemFonts: false, fontExtraProperties: true }).promise;
    } catch (e) {
      if (e && typeof e === "object" && "name" in e && (e as { name: string }).name === "PasswordException") throw new Error("PDF is password protected");
      throw e;
    }
    return new PdfDocument(doc, filename);
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  async pageSize(i: number): Promise<[number, number, "pt"]> {
    const page = await this.doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    return [vp.width, vp.height, "pt"];
  }

  async extract(i: number, index = 0, documentIndex = 0): Promise<PageData> {
    const page = await this.doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const vp0 = page.getViewport({ scale: 1, rotation: 0 });
    const disp = vp.transform as Mat; // PDF space -> displayed
    const unrot = vp0.transform as Mat; // PDF space -> unrotated, y down
    const rot = mul(disp, inverse(unrot)); // unrotated -> displayed

    const { paths, runs } = await this.walk(page, disp, unrot, rot, vp.width, vp.height);
    const lines = this.textLines(runs, `p${index}`);
    const geom = extractVectorGeometry(paths);
    const nChars = lines.reduce((a, ln) => a + ln.text.length, 0);
    const quality = newQuality("vector");
    const hasText = nChars >= 20;
    if (!hasText && geom.segments.length < 50) quality.kind = "raster";
    else if (!hasText) quality.kind = "vector_outlined_text";
    page.cleanup();
    return {
      index,
      documentIndex,
      pageInDocument: i,
      width: Math.fround(vp.width),
      height: Math.fround(vp.height),
      unit: "pt",
      mmPerUnit: PDF_MM_PER_PT,
      rotation: page.rotate,
      lines,
      geometry: geom,
      quality,
      hasTextLayer: hasText,
      label: `${this.filename} p.${i + 1}`,
    };
  }

  // -- text and vector paths (one pass over the operator list) ----------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async walk(page: any, disp: Mat, unrot: Mat, rot: Mat, pw: number, ph: number): Promise<{ paths: DrawingPath[]; runs: Run[] }> {
    const { pdfjs } = platform();
    const OPS = pdfjs.OPS;
    const ol = await page.getOperatorList();
    const paths: DrawingPath[] = [];
    const runs: Run[] = [];
    interface GState {
      ctm: Mat;
      lineWidth: number;
      dashed: boolean;
      fontId: string | null;
      fontSize: number;
      charSpacing: number;
      wordSpacing: number;
      hScale: number;
      leading: number;
      rise: number;
    }
    // gs.ctm maps user space straight to unrotated device space (y down), as MuPDF's gstate does
    let gs: GState = { ctm: unrot.map(f32) as Mat, lineWidth: 1, dashed: false, fontId: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0 };
    const stack: GState[] = [];
    // text object state
    let tm: Mat = IDENTITY;
    let tx = 0;
    let ty = 0;
    let lineX = 0;
    let lineY = 0;
    // raw path ops captured with the CTM in force when they were issued
    let raw: { op: number; pts: number[]; ctm: Mat }[] = [];

    // MuPDF computes page coordinates in single precision; matching it keeps
    // tie-breaks (grid cells, equal candidates) identical to the reference engine
    const toUnrot = (ctm: Mat, x: number, y: number): Pt => apply32(ctm, x, y);
    const toDisp = (p: Pt): Pt => apply(rot, p[0], p[1]);

    const paint = (fill: boolean, stroke: boolean, close: boolean) => {
      if (close) raw.push({ op: OPS.closePath, pts: [], ctm: gs.ctm });
      if (!raw.length) return;
      const items = walkPath(raw, OPS, toUnrot, fill && !stroke);
      raw = [];
      if (!items.items.length) return;
      const det = Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]);
      paths.push({
        items: items.items.map((it) => displayItem(it, toDisp)),
        width: stroke ? Math.sqrt(Math.fround(det)) * Math.fround(gs.lineWidth) : 0,
        dashed: stroke && gs.dashed,
        fill,
        closePath: items.closePath,
      });
    };

    const fonts = new Map<string, { asc: number; desc: number; scale: number; vertical: boolean }>();
    const fontInfo = (id: string | null) => {
      if (!id) return { asc: 1.075, desc: -0.299, scale: 0.001, vertical: false };
      let f = fonts.get(id);
      if (!f) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let obj: any = null;
        try {
          obj = page.commonObjs.get(id);
        } catch {
          obj = null;
        }
        const name = `${obj?.name ?? ""} ${obj?.loadedName ?? ""}`;
        const bold = !!obj?.bold || /bold|black|heavy/i.test(name);
        let asc = bold ? 1.07 : 1.075;
        let desc = bold ? -0.307 : -0.299;
        // metrics as MuPDF reports them for Helvetica-like fonts; the font's own otherwise
        if (!/helvetica|arial|nimbus\s*sans/i.test(name) && obj && obj.ascent > 0.4 && obj.ascent < 1.6 && obj.descent < 0 && obj.descent > -0.8) {
          asc = obj.ascent;
          desc = obj.descent;
        }
        const scale = obj?.isType3Font && Array.isArray(obj.fontMatrix) ? obj.fontMatrix[0] : 0.001;
        f = { asc, desc, scale, vertical: !!obj?.vertical };
        fonts.set(id, f);
      }
      return f;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const showText = (glyphs: any[]) => {
      const f = fontInfo(gs.fontId);
      const fs = Math.abs(gs.fontSize);
      if (!fs || f.vertical) return;
      const trm = mul(gs.ctm, tm); // text space -> unrotated device space
      const ux0 = trm[0];
      const uy0 = trm[1];
      const hlen = Math.hypot(ux0, uy0) || 1;
      const size = fs * Math.hypot(trm[2], trm[3]);
      const dxr = rot[0] * ux0 + rot[2] * uy0;
      const dyr = rot[1] * ux0 + rot[3] * uy0;
      const dn = Math.hypot(dxr, dyr) || 1;
      const dir: Pt = [dxr / dn, dyr / dn];
      const chars: PChar[] = [];
      let x = 0;
      const startX = tx;
      for (const g of glyphs) {
        if (typeof g === "number") {
          x -= (g * fs) / 1000;
          continue;
        }
        if (!g) continue;
        const adv = (g.width ?? 0) * f.scale * fs;
        const spacing = (g.isSpace ? gs.wordSpacing : 0) + gs.charSpacing;
        const x0 = tx + x * gs.hScale;
        const x1 = x0 + adv * gs.hScale;
        const y0 = ty + gs.rise + f.desc * fs;
        const y1 = ty + gs.rise + f.asc * fs;
        const corners = [apply(trm, x0, y0), apply(trm, x1, y0), apply(trm, x0, y1), apply(trm, x1, y1)].map((u) => apply(rot, f32(u[0]), f32(u[1])));
        const box = BBox.around(corners);
        const text: string = g.unicode ?? "";
        // TEXT_MEDIABOX_CLIP: characters outside the page are ignored
        if (text && !(box.cx < 0 || box.cy < 0 || box.cx > pw || box.cy > ph)) {
          for (const c of text) chars.push({ c, box, size });
        }
        x += adv + spacing;
      }
      tx = startX + x * gs.hScale;
      if (!chars.length) return;
      const o = apply(rot, ...apply(trm, startX, ty + gs.rise));
      const e = apply(rot, ...apply(trm, tx, ty + gs.rise));
      runs.push({ chars, dir, angle: degrees(Math.atan2(-dir[1], dir[0])), origin: o, end: e, size, hlen });
    };

    const moveText = (x: number, y: number) => {
      lineX += x;
      lineY += y;
      // PDF: Tlm = [1 0 0 1 x y] x Tlm ; Tm = Tlm
      tx = lineX;
      ty = lineY;
    };

    for (let k = 0; k < ol.fnArray.length; k++) {
      const fn = ol.fnArray[k];
      const args = ol.argsArray[k];
      switch (fn) {
        case OPS.save:
          stack.push({ ...gs });
          break;
        case OPS.restore:
          gs = stack.pop() ?? gs;
          break;
        case OPS.transform:
          gs = { ...gs, ctm: concat32(args as Mat, gs.ctm) };
          break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ...gs });
          if (args?.[0]) gs = { ...gs, ctm: concat32(args[0] as Mat, gs.ctm) };
          break;
        case OPS.paintFormXObjectEnd:
          gs = stack.pop() ?? gs;
          break;
        case OPS.setLineWidth:
          gs = { ...gs, lineWidth: args[0] };
          break;
        case OPS.setDash:
          gs = { ...gs, dashed: Array.isArray(args[0]) && args[0].length > 0 };
          break;
        case OPS.setGState:
          for (const [key, value] of args[0] ?? []) {
            if (key === "LW") gs = { ...gs, lineWidth: value };
            else if (key === "D") gs = { ...gs, dashed: Array.isArray(value?.[0]) && value[0].length > 0 };
            else if (key === "Font" && Array.isArray(value)) gs = { ...gs, fontId: value[0]?.loadedName ?? gs.fontId, fontSize: value[1] ?? gs.fontSize };
          }
          break;
        case OPS.constructPath: {
          const ops: number[] = args[0];
          const coords: number[] = args[1];
          let c = 0;
          for (const op of ops) {
            const n = op === OPS.rectangle ? 4 : op === OPS.moveTo || op === OPS.lineTo ? 2 : op === OPS.curveTo ? 6 : op === OPS.curveTo2 || op === OPS.curveTo3 ? 4 : 0;
            raw.push({ op, pts: coords.slice(c, c + n), ctm: gs.ctm });
            c += n;
          }
          break;
        }
        case OPS.stroke:
          paint(false, true, false);
          break;
        case OPS.closeStroke:
          paint(false, true, true);
          break;
        case OPS.fill:
        case OPS.eoFill:
          paint(true, false, false);
          break;
        case OPS.fillStroke:
        case OPS.eoFillStroke:
          paint(true, true, false);
          break;
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke:
          paint(true, true, true);
          break;
        case OPS.endPath:
          raw = [];
          break;
        // -- text state
        case OPS.beginText:
          tm = IDENTITY;
          tx = ty = lineX = lineY = 0;
          break;
        case OPS.setFont:
          gs = { ...gs, fontId: args[0], fontSize: args[1] };
          break;
        case OPS.setCharSpacing:
          gs = { ...gs, charSpacing: args[0] };
          break;
        case OPS.setWordSpacing:
          gs = { ...gs, wordSpacing: args[0] };
          break;
        case OPS.setHScale:
          gs = { ...gs, hScale: args[0] / 100 };
          break;
        case OPS.setLeading:
          gs = { ...gs, leading: -args[0] };
          break;
        case OPS.setTextRise:
          gs = { ...gs, rise: args[0] };
          break;
        case OPS.setTextMatrix:
          tm = args as Mat;
          tx = ty = lineX = lineY = 0;
          break;
        case OPS.moveText:
          moveText(args[0], args[1]);
          break;
        case OPS.setLeadingMoveText:
          gs = { ...gs, leading: args[1] };
          moveText(args[0], args[1]);
          break;
        case OPS.nextLine:
          moveText(0, gs.leading);
          break;
        case OPS.showText:
        case OPS.showSpacedText:
          showText(args[0]);
          break;
        case OPS.nextLineShowText:
          moveText(0, gs.leading);
          showText(args[0]);
          break;
        case OPS.nextLineSetSpacingShowText:
          gs = { ...gs, wordSpacing: args[0], charSpacing: args[1] };
          moveText(0, gs.leading);
          showText(args[2]);
          break;
        default:
          break;
      }
    }
    return { paths, runs };
  }

  private textLines(runs: Run[], idPrefix: string): TextLine[] {
    // runs continuing on the same baseline form one line (as PyMuPDF's text lines)
    const groups: Run[][] = [];
    for (const r of runs) {
      const g = groups[groups.length - 1];
      const prev = g?.[g.length - 1];
      if (prev && Math.abs(prev.angle - r.angle) < 0.5) {
        const [ux, uy] = prev.dir;
        const off = Math.abs(-(r.origin[0] - prev.origin[0]) * uy + (r.origin[1] - prev.origin[1]) * ux);
        const gap = (r.origin[0] - prev.end[0]) * ux + (r.origin[1] - prev.end[1]) * uy;
        const size = Math.max(prev.size, r.size, 1);
        if (off < 0.2 * size && gap <= 0.9 * size && gap >= -3 * size) {
          g.push(r);
          continue;
        }
      }
      groups.push([r]);
    }
    const out: TextLine[] = [];
    let n = 0;
    for (const g of groups) {
      const chars = g.flatMap((r) => r.chars);
      for (let piece of splitOnGaps(chars, g[0].dir)) {
        let lo = 0;
        let hi = piece.length;
        while (lo < hi && /\s/.test(piece[lo].c)) lo++;
        while (hi > lo && /\s/.test(piece[hi - 1].c)) hi--;
        if (lo >= hi) continue;
        piece = piece.slice(lo, hi);
        const text = piece.map((p) => p.c).join("");
        const boxes = piece.map((p) => p.box);
        let bb = boxes[0];
        for (const b of boxes.slice(1)) bb = bb.union(b);
        const size = Math.max(...piece.map((p) => p.size));
        out.push(new TextLine(`${idPrefix}-l${n}`, text, bb, boxes, g[0].angle, size, "pdf", 1));
        n++;
      }
    }
    return out;
  }

  // -- rendering ---------------------------------------------------------------

  /** Render page `i` at `scale` pixels per point, optionally clipped to a displayed-space box. */
  async render(i: number, scale: number, clip?: BBox | null): Promise<RgbaImage> {
    const page = await this.doc.getPage(i + 1);
    const vp = page.getViewport({ scale });
    let w = Math.max(1, Math.ceil(vp.width));
    let h = Math.max(1, Math.ceil(vp.height));
    let tx = 0;
    let ty = 0;
    if (clip) {
      const x0 = Math.max(0, clip.x0 * scale);
      const y0 = Math.max(0, clip.y0 * scale);
      const x1 = Math.min(vp.width, clip.x1 * scale);
      const y1 = Math.min(vp.height, clip.y1 * scale);
      if (x1 <= x0 || y1 <= y0) return { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
      tx = -Math.floor(x0);
      ty = -Math.floor(y0);
      w = Math.max(1, Math.ceil(x1) - Math.floor(x0));
      h = Math.max(1, Math.ceil(y1) - Math.floor(y0));
    }
    const canvas = platform().createCanvas(w, h);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = canvas.getContext("2d") as any;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, tx, ty], background: "#ffffff" }).promise;
    const img = ctx.getImageData(0, 0, w, h);
    page.cleanup();
    return { width: w, height: h, data: img.data };
  }

  async close(): Promise<void> {
    await this.doc.destroy();
  }
}

type UnrotItem = { op: "l"; p1: Pt; p2: Pt } | { op: "re"; rect: [number, number, number, number] } | { op: "qu"; corners: [Pt, Pt, Pt, Pt] } | { op: "c"; p0: Pt; p1: Pt; p2: Pt; p3: Pt };

/**
 * Walk a path the way PyMuPDF's line-art device does: rectangles and closed
 * 4-line figures become "re" / "qu" items, closing a figure adds its last line.
 */
function walkPath(raw: { op: number; pts: number[]; ctm: Mat }[], OPS: Record<string, number>, toUnrot: (ctm: Mat, x: number, y: number) => Pt, isFill: boolean): { items: UnrotItem[]; closePath: boolean } {
  const items: UnrotItem[] = [];
  let last: Pt = [0, 0];
  let first: Pt = [0, 0];
  let havemove = false;
  let linecount = 0;
  let closePath: boolean | undefined;
  const eq = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

  const checkquad = () => {
    const n = items.length;
    const lines = items.slice(n - 4) as { op: "l"; p1: Pt; p2: Pt }[];
    const lp = lines[3].p2;
    const f0 = lines[0].p1;
    if (!eq(lp, f0)) return;
    linecount = 0;
    // corners in order ul, ur, lr, ll (line start points: 0=ul, 1=ll, 2=lr, 3=ur)
    const ul = lines[0].p1;
    const ll = lines[1].p1;
    const lr = lines[2].p1;
    const ur = lines[3].p1;
    items.splice(n - 4, 4, { op: "qu", corners: [ul, ur, lr, ll] });
  };

  const checkrect = (): boolean => {
    linecount = 0;
    const n = items.length;
    const line0 = items[n - 3] as { op: "l"; p1: Pt; p2: Pt };
    const line2 = items[n - 1] as { op: "l"; p1: Pt; p2: Pt };
    const ll = line0.p1;
    const lr = line0.p2;
    const ur = line2.p1;
    const ul = line2.p2;
    if (ll[1] !== lr[1] || ll[0] !== ul[0] || ur[1] !== ul[1] || ur[0] !== lr[0]) return false;
    const r: [number, number, number, number] = ul[1] < lr[1] ? [ul[0], ul[1], lr[0], lr[1]] : [ll[0], ll[1], ur[0], ur[1]];
    items.splice(n - 3, 3, { op: "re", rect: r });
    return true;
  };

  const moveto = (p: Pt) => {
    last = p;
    first = p;
    havemove = true;
    linecount = 0;
  };
  const lineto = (p: Pt) => {
    items.push({ op: "l", p1: last, p2: p });
    last = p;
    linecount++;
    if (linecount === 4 && !isFill) checkquad();
  };
  const curveto = (p1: Pt, p2: Pt, p3: Pt) => {
    linecount = 0;
    items.push({ op: "c", p0: last, p1, p2, p3 });
    last = p3;
  };
  const closepath = () => {
    if (linecount === 3 && checkrect()) return;
    linecount = 0;
    if (havemove) {
      if (!eq(last, first)) {
        items.push({ op: "l", p1: last, p2: first });
        last = first;
      }
      closePath = false;
    } else {
      closePath = true;
    }
    havemove = false;
  };

  for (const r of normalizePath(raw, OPS)) {
    const P = (k: number) => toUnrot(r.ctm, r.pts[2 * k], r.pts[2 * k + 1]);
    if (r.op === OPS.moveTo) moveto(P(0));
    else if (r.op === OPS.lineTo) lineto(P(0));
    else if (r.op === OPS.curveTo) curveto(P(0), P(1), P(2));
    else if (r.op === OPS.curveTo2) {
      // "v": first control point is the current point
      const cur = last;
      curveto(cur, P(0), P(1));
    } else if (r.op === OPS.curveTo3) {
      // "y": second control point is the end point
      const p3 = P(1);
      curveto(P(0), p3, p3);
    } else if (r.op === OPS.closePath) closepath();
    else if (r.op === OPS.rectangle) {
      const [x, y, w, h] = r.pts;
      const c = (px: number, py: number) => toUnrot(r.ctm, px, py);
      moveto(c(x, y));
      lineto(c(x + w, y));
      lineto(c(x + w, y + h));
      lineto(c(x, y + h));
      closepath();
    }
  }
  return { items, closePath: closePath ?? false };
}

/**
 * MuPDF's path builder rules: a moveto replaces a preceding moveto, a
 * zero-length lineto is dropped (unless it follows a moveto), and a close
 * directly after a rectangle or another close is a no-op.
 */
function normalizePath(raw: { op: number; pts: number[]; ctm: Mat }[], OPS: Record<string, number>): { op: number; pts: number[]; ctm: Mat }[] {
  const out: { op: number; pts: number[]; ctm: Mat }[] = [];
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  for (const r of raw) {
    const last = out[out.length - 1];
    if (r.op === OPS.moveTo) {
      if (last && last.op === OPS.moveTo) out.pop();
      out.push(r);
      cur = start = [r.pts[0], r.pts[1]];
    } else if (r.op === OPS.lineTo) {
      if (!cur) continue;
      if (last && last.op !== OPS.moveTo && cur[0] === r.pts[0] && cur[1] === r.pts[1]) continue;
      out.push(r);
      cur = [r.pts[0], r.pts[1]];
    } else if (r.op === OPS.closePath) {
      if (!last || last.op === OPS.closePath || last.op === OPS.rectangle) continue;
      out.push(r);
      cur = start;
    } else if (r.op === OPS.rectangle) {
      out.push(r);
      cur = start = [r.pts[0], r.pts[1]];
    } else {
      if (!cur) continue;
      out.push(r);
      const n = r.pts.length;
      cur = [r.pts[n - 2], r.pts[n - 1]];
    }
  }
  return out;
}

function displayItem(it: UnrotItem, toDisp: (p: Pt) => Pt): PathItem {
  switch (it.op) {
    case "l":
      return { op: "l", p1: toDisp(it.p1), p2: toDisp(it.p2) };
    case "c":
      return { op: "c", p0: toDisp(it.p0), p1: toDisp(it.p1), p2: toDisp(it.p2), p3: toDisp(it.p3) };
    case "qu":
      return { op: "qu", corners: it.corners.map(toDisp) as [Pt, Pt, Pt, Pt] };
    case "re": {
      const [x0, y0, x1, y1] = it.rect;
      const tl: Pt = [Math.min(x0, x1), Math.min(y0, y1)];
      const br: Pt = [Math.max(x0, x1), Math.max(y0, y1)];
      const tr: Pt = [br[0], tl[1]];
      const bl: Pt = [tl[0], br[1]];
      return { op: "re", corners: [toDisp(tl), toDisp(tr), toDisp(br), toDisp(bl)] };
    }
  }
}

/** Split a PDF text line where characters are far apart (separate annotations). */
function splitOnGaps(chars: PChar[], d: Pt): PChar[][] {
  if (!chars.length) return [];
  const norm = Math.hypot(d[0], d[1]) || 1;
  const ux = d[0] / norm;
  const uy = d[1] / norm;
  const pieces: PChar[][] = [[chars[0]]];
  for (let i = 1; i < chars.length; i++) {
    const pb = chars[i - 1].box;
    const cb = chars[i].box;
    const size = Math.max(chars[i - 1].size, chars[i].size, 1);
    const pHi = Math.max(pb.x0 * ux + pb.y0 * uy, pb.x1 * ux + pb.y1 * uy, pb.x0 * ux + pb.y1 * uy, pb.x1 * ux + pb.y0 * uy);
    const cLo = Math.min(cb.x0 * ux + cb.y0 * uy, cb.x1 * ux + cb.y1 * uy, cb.x0 * ux + cb.y1 * uy, cb.x1 * ux + cb.y0 * uy);
    const gap = cLo - pHi;
    if (gap > 0.9 * size || gap < -3 * size) pieces.push([chars[i]]);
    else pieces[pieces.length - 1].push(chars[i]);
  }
  return pieces;
}
