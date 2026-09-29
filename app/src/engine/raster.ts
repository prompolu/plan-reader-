/**
 * Raster (scan) processing: ink mask, long-line removal for OCR, line / arc /
 * arrowhead detection, tag-symbol OCR and scan-quality assessment.
 * OpenCV.js is loaded on demand - vector PDFs never need it.
 */
import { BBox, Arc, FilledShape, Segment, TextLine, emptyGeometry, newQuality, type PageGeometry, type PageQuality } from "./types";
import { mergeCollinear, splitAtIntersections } from "./geometry";
import { platform, type GrayImage, type OCRProvider } from "./platform";
import { median, mean, pyRound } from "./py";
import { parseTag } from "./tags";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CV = any;

// ---------------------------------------------------------------------------
// Pixel helpers (no OpenCV needed)
// ---------------------------------------------------------------------------

/** Otsu threshold of an 8-bit image (as cv2.THRESH_OTSU computes it). */
function otsu(g: GrayImage): number {
  const hist = new Float64Array(256);
  const n = g.data.length;
  for (let i = 0; i < n; i++) hist[g.data[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let maxVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      best = t;
    }
  }
  return best;
}

/**
 * Ink mask. Drawings are dark ink on a light background; thin anti-aliased
 * lines are light grey, so the Otsu threshold is raised to keep them.
 */
export function binarize(gray: GrayImage): GrayImage {
  const thr = Math.min(Math.max(otsu(gray) + 60, 170), 235);
  const out = new Uint8Array(gray.data.length);
  for (let i = 0; i < out.length; i++) out[i] = gray.data[i] < thr ? 255 : 0;
  return { width: gray.width, height: gray.height, data: out };
}

/** Morphological opening with a 1-D line kernel (erode then dilate, OpenCV anchor/border rules). */
function openLine(bw: GrayImage, len: number, horizontal: boolean): Uint8Array {
  const { width: w, height: h, data } = bw;
  const a = Math.floor(len / 2);
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const at = (line: number, k: number) => (horizontal ? line * w + k : k * w + line);
  const eroded = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const zeroPrefix = new Int32Array(n + 1);
  const onePrefix = new Int32Array(n + 1);
  for (let line = 0; line < lines; line++) {
    // erosion: min over window [k - a, k - a + len - 1]; outside pixels count as ink
    for (let k = 0; k < n; k++) zeroPrefix[k + 1] = zeroPrefix[k] + (data[at(line, k)] ? 0 : 1);
    for (let k = 0; k < n; k++) {
      const lo = Math.max(0, k - a);
      const hi = Math.min(n - 1, k - a + len - 1);
      eroded[at(line, k)] = zeroPrefix[hi + 1] - zeroPrefix[lo] === 0 ? 255 : 0;
    }
    // dilation: max over the same window; outside pixels are ignored
    for (let k = 0; k < n; k++) onePrefix[k + 1] = onePrefix[k] + (eroded[at(line, k)] ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const lo = Math.max(0, k - a);
      const hi = Math.min(n - 1, k - a + len - 1);
      out[at(line, k)] = hi >= lo && onePrefix[hi + 1] - onePrefix[lo] > 0 ? 255 : 0;
    }
  }
  return out;
}

function dilate3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !v; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (mask[yy * w + xx]) v = 255;
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Erase long straight lines (walls, dimension lines, frames) so OCR sees isolated text. */
export async function removeLongLines(gray: GrayImage, minLen: number): Promise<GrayImage> {
  const bw = binarize(gray);
  const hmask = openLine(bw, minLen, true);
  const vmask = openLine(bw, minLen, false);
  const mask = new Uint8Array(hmask.length);
  for (let i = 0; i < mask.length; i++) mask[i] = hmask[i] | vmask[i];
  const dil = dilate3(mask, gray.width, gray.height);
  const out = Uint8Array.from(gray.data);
  for (let i = 0; i < out.length; i++) if (dil[i]) out[i] = 255;
  return { width: gray.width, height: gray.height, data: out };
}

// ---------------------------------------------------------------------------
// OpenCV-backed geometry
// ---------------------------------------------------------------------------

function toMat(cv: CV, img: GrayImage | { width: number; height: number; data: Uint8Array }): CV {
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC1);
  m.data.set(img.data);
  return m;
}

function components(cv: CV, bin: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number; area: number }[] {
  const m = toMat(cv, { width: w, height: h, data: bin });
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(m, labels, stats, cents, 8, cv.CV_32S);
  const out = [];
  // read the raw int32 buffer: per-row accessors return only the first column in some builds
  const st: Int32Array = stats.data32S;
  const cols = stats.cols;
  for (let i = 1; i < n; i++) {
    const o = i * cols;
    out.push({ x: st[o], y: st[o + 1], w: st[o + 2], h: st[o + 3], area: st[o + 4] });
  }
  m.delete();
  labels.delete();
  stats.delete();
  cents.delete();
  return out;
}

function lsqCircle(pts: [number, number][]): [number, number, number, number] | null {
  // least squares for x^2 + y^2 = A x + B y + C
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const M = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const v = [sxz, syz, sz];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  const solve = (col: number) => det(M.map((row, i) => row.map((val, j) => (j === col ? v[i] : val)))) / D;
  const A = solve(0);
  const B = solve(1);
  const C = solve(2);
  const cx = A / 2;
  const cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  let resid = 0;
  for (const [x, y] of pts) resid += Math.abs(Math.hypot(x - cx, y - cy) - r);
  return [cx, cy, r, resid / n];
}

function angularExtent(ang: number[]): number {
  const a = ang.map((x) => ((x % 360) + 360) % 360).sort((p, q) => p - q);
  if (a.length < 2) return 0;
  let maxGap = 0;
  for (let i = 0; i < a.length; i++) {
    const next = i + 1 < a.length ? a[i + 1] : a[0] + 360;
    maxGap = Math.max(maxGap, next - a[i]);
  }
  return 360 - maxGap;
}

function arcEndpoints(ang: number[]): [number, number] {
  const a = ang.map((x) => ((x % 360) + 360) % 360).sort((p, q) => p - q);
  let k = 0;
  let maxGap = -1;
  for (let i = 0; i < a.length; i++) {
    const next = i + 1 < a.length ? a[i + 1] : a[0] + 360;
    if (next - a[i] > maxGap) {
      maxGap = next - a[i];
      k = i;
    }
  }
  return [a[(k + 1) % a.length], a[k]];
}

/**
 * Detect line segments, arcs, arrowheads and circles in a raster drawing.
 * `maskBoxes` (in output units) are blanked first so OCR'd characters are not
 * mistaken for short lines.
 */
export async function extractRasterGeometry(gray: GrayImage, unitPerPx = 1, maskBoxes: BBox[] = []): Promise<PageGeometry> {
  const cv: CV = await platform().loadOpenCV();
  const bw = binarize(gray);
  const { width: w, height: h } = bw;
  for (const b of maskBoxes) {
    const x0 = Math.max(Math.trunc(b.x0 / unitPerPx) - 1, 0);
    const y0 = Math.max(Math.trunc(b.y0 / unitPerPx) - 1, 0);
    const x1 = Math.max(Math.trunc(b.x1 / unitPerPx) + 1, 0);
    const y1 = Math.max(Math.trunc(b.y1 / unitPerPx) + 1, 0);
    for (let y = y0; y < Math.min(y1, h); y++) bw.data.fill(0, y * w + x0, y * w + Math.min(x1, w));
  }
  const g = emptyGeometry();
  const minLen = Math.max(8, Math.trunc(Math.min(h, w) * 0.004));

  // straight horizontal / vertical structure via morphology (robust to thick walls)
  const segs: Segment[] = [];
  for (const axis of ["h", "v"] as const) {
    const lines = openLine(bw, minLen, axis === "h");
    for (const { x, y, w: ww, h: hh } of components(cv, lines, w, h)) {
      if (axis === "h") {
        if (ww < minLen) continue;
        // thick bands (e.g. walls drawn solid) produce two edge lines
        if (hh > 4) {
          segs.push(new Segment(x, y, x + ww, y, 1));
          segs.push(new Segment(x, y + hh, x + ww, y + hh, 1));
        } else {
          const cy = y + hh / 2;
          segs.push(new Segment(x, cy, x + ww, cy, hh));
        }
      } else {
        if (hh < minLen) continue;
        if (ww > 4) {
          segs.push(new Segment(x, y, x, y + hh, 1));
          segs.push(new Segment(x + ww, y, x + ww, y + hh, 1));
        } else {
          const cx = x + ww / 2;
          segs.push(new Segment(cx, y, cx, y + hh, ww));
        }
      }
    }
  }

  // oblique short segments (dimension ticks) via probabilistic Hough on the residual
  const residual = toMat(cv, bw);
  for (const s of segs) cv.line(residual, new cv.Point(Math.trunc(s.x0), Math.trunc(s.y0)), new cv.Point(Math.trunc(s.x1), Math.trunc(s.y1)), new cv.Scalar(0), Math.max(3, Math.trunc(s.width) + 2));
  const hl = new cv.Mat();
  cv.HoughLinesP(residual, hl, 1, Math.PI / 180, 8, Math.max(5, Math.floor(minLen / 2)), 2);
  const hd: Int32Array = hl.data32S;
  for (let i = 0; i < hl.rows; i++) {
    const [x0, y0, x1, y1] = [hd[4 * i], hd[4 * i + 1], hd[4 * i + 2], hd[4 * i + 3]];
    const s = new Segment(x0, y0, x1, y1, 1);
    if (s.orientation(8) === null && s.length < minLen * 4) segs.push(s);
  }
  hl.delete();

  // arcs and circles from the residual curve pixels
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(residual.clone(), contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  for (let ci = 0; ci < contours.size(); ci++) {
    const c = contours.get(ci);
    if (c.rows < 20) {
      c.delete();
      continue;
    }
    const pts: [number, number][] = [];
    const cd: Int32Array = c.data32S;
    for (let k = 0; k < c.rows; k++) pts.push([cd[2 * k], cd[2 * k + 1]]);
    const br = cv.boundingRect(c);
    c.delete();
    if (Math.max(br.width, br.height) < minLen) continue;
    const fit = lsqCircle(pts);
    if (!fit) continue;
    const [cx, cy, r, resid] = fit;
    if (resid > Math.max(1.5, 0.04 * r) || r < minLen * 0.7) continue;
    const ang = pts.map(([x, y]) => (Math.atan2(y - cy, x - cx) * 180) / Math.PI);
    const sweep = angularExtent(ang);
    if (sweep > 340) g.circles.push([cx * unitPerPx, cy * unitPerPx, r * unitPerPx]);
    else if (sweep >= 60 && sweep <= 120) {
      const [a0, a1] = arcEndpoints(ang);
      const ps: [number, number] = [cx + r * Math.cos((a0 * Math.PI) / 180), cy + r * Math.sin((a0 * Math.PI) / 180)];
      const pe: [number, number] = [cx + r * Math.cos((a1 * Math.PI) / 180), cy + r * Math.sin((a1 * Math.PI) / 180)];
      g.arcs.push(new Arc(cx * unitPerPx, cy * unitPerPx, r * unitPerPx, [ps[0] * unitPerPx, ps[1] * unitPerPx], [pe[0] * unitPerPx, pe[1] * unitPerPx], sweep));
    }
  }
  contours.delete();
  hier.delete();
  residual.delete();

  // small filled triangles (arrowheads)
  const bwMat = toMat(cv, bw);
  const ext = new cv.MatVector();
  const hier2 = new cv.Mat();
  cv.findContours(bwMat, ext, hier2, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let ci = 0; ci < ext.size(); ci++) {
    const c = ext.get(ci);
    const area = cv.contourArea(c);
    if (area < 6 || area > (minLen * 1.5) ** 2) {
      c.delete();
      continue;
    }
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.12 * cv.arcLength(c, true), true);
    const br = cv.boundingRect(c);
    const fillRatio = area / Math.max(br.width * br.height, 1);
    if (approx.rows === 3 && fillRatio > 0.3) {
      const pts: [number, number][] = [];
      const ad: Int32Array = approx.data32S;
      for (let k = 0; k < 3; k++) pts.push([ad[2 * k] * unitPerPx, ad[2 * k + 1] * unitPerPx]);
      g.fills.push(new FilledShape(pts, "triangle"));
    }
    approx.delete();
    c.delete();
  }
  ext.delete();
  hier2.delete();
  bwMat.delete();

  const merged = splitAtIntersections(mergeCollinear(segs, 1.5, 2), 2.5);
  g.segments = merged.map((s) => new Segment(s.x0 * unitPerPx, s.y0 * unitPerPx, s.x1 * unitPerPx, s.y1 * unitPerPx, s.width * unitPerPx));
  return g;
}

// ---------------------------------------------------------------------------
// Tag symbols
// ---------------------------------------------------------------------------

/** Common OCR confusions inside tag numbers: O->0, I/l->1, S->5 after the prefix. */
export function fixTagOcr(t: string): string {
  const m = /^([A-Z]{1,3})([-.\s]?)([0-9OIlS]{1,3})([A-Z]?)$/.exec(t.toUpperCase());
  if (!m) return t;
  const num = m[3].replace(/O/g, "0").replace(/[IL]/g, "1").replace(/S/g, "5");
  return `${m[1]}${m[2]}${num}${m[4]}`;
}

function cropGray(gray: GrayImage, x: number, y: number, w: number, h: number): GrayImage {
  const out = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) out.set(gray.data.subarray((y + yy) * gray.width + x, (y + yy) * gray.width + x + w), yy * w);
  return { width: w, height: h, data: out };
}

/**
 * OCR the inside of small closed symbols (tag circles, hexagons, boxes).
 * General OCR struggles with text touching an outline; reading each symbol's
 * interior as a single line with a restricted alphabet is far more reliable.
 * Returns [tag text lines, symbol boxes] in page units.
 */
export async function readSymbolTags(gray: GrayImage, unitPerPx: number, idPrefix: string, textPx: number, ocr: OCRProvider): Promise<[TextLine[], BBox[]]> {
  if (!ocr.recognizeLine) return [[], []];
  const cv: CV = await platform().loadOpenCV();
  const bw = toMat(cv, binarize(gray));
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bw, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const lo = (2 * textPx) ** 2;
  const hi = (8 * textPx) ** 2;
  const lines: TextLine[] = [];
  const boxes: BBox[] = [];
  const seen: [number, number, number, number][] = [];
  const cands: { x: number; y: number; w: number; h: number }[] = [];
  for (let ci = 0; ci < contours.size(); ci++) {
    const c = contours.get(ci);
    const { x, y, width: w, height: h } = cv.boundingRect(c);
    let keep = lo <= w * h && w * h <= hi && 0.5 <= w / Math.max(h, 1) && w / Math.max(h, 1) <= 3;
    if (keep) {
      const area = cv.contourArea(c);
      if (area < 0.45 * w * h) keep = false; // open shapes / arcs
      else {
        const peri = cv.arcLength(c, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, 0.02 * peri, true);
        const circ = (4 * Math.PI * area) / Math.max(peri ** 2, 1);
        keep = (approx.rows >= 4 && approx.rows <= 8) || circ > 0.75;
        approx.delete();
      }
    }
    c.delete();
    if (!keep) continue;
    if (seen.some(([a, b, cw]) => Math.abs(x - a) < 4 && Math.abs(y - b) < 4 && Math.abs(w - cw) < 6)) continue; // inner/outer edge of the same stroke
    seen.push([x, y, w, h]);
    cands.push({ x, y, w, h });
  }
  contours.delete();
  hier.delete();
  bw.delete();

  for (const { x, y, w, h } of cands) {
    const mx = Math.trunc(w * 0.16);
    const my = Math.trunc(h * 0.18);
    const cw = w - 2 * mx;
    const ch = h - 2 * my;
    if (cw <= 0 || ch <= 0) continue;
    // 2x upscale with a white border, as tesseract reads isolated lines best that way
    const crop = cropGray(gray, x + mx, y + my, cw, ch);
    const src = toMat(cv, crop);
    const big = new cv.Mat();
    cv.resize(src, big, new cv.Size(0, 0), 2, 2, cv.INTER_CUBIC);
    const pad = new cv.Mat();
    cv.copyMakeBorder(big, pad, 12, 12, 12, 12, cv.BORDER_CONSTANT, new cv.Scalar(255));
    const img: GrayImage = { width: pad.cols, height: pad.rows, data: Uint8Array.from(pad.data) };
    src.delete();
    big.delete();
    pad.delete();
    let words: { text: string; confidence: number }[];
    try {
      words = (await ocr.recognizeLine(img, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")).filter((wd) => wd.text.trim());
    } catch {
      continue;
    }
    if (!words.length) continue;
    const text = fixTagOcr(words.map((wd) => wd.text.trim()).join(""));
    if (!parseTag(text)) continue;
    const conf = Math.max(0.3, Math.min(1, mean(words.map((wd) => wd.confidence)) / 100));
    const bb = new BBox((x + mx) * unitPerPx, (y + my) * unitPerPx, cw * unitPerPx, ch * unitPerPx);
    const n = text.length;
    const charBoxes = Array.from({ length: n }, (_, k) => new BBox(bb.x + (bb.w * k) / n, bb.y, bb.w / n, bb.h));
    lines.push(new TextLine(`${idPrefix}-g${lines.length}`, text, bb, charBoxes, 0, bb.h, "ocr", conf));
    boxes.push(new BBox(x * unitPerPx, y * unitPerPx, w * unitPerPx, h * unitPerPx));
  }
  return [lines, boxes];
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

/** Raster page quality assessment (flag poor scans instead of trusting them). */
export async function assessRaster(gray: GrayImage, lines: TextLine[], pxPerUnit: number, knownDpi: number | null, kind: PageQuality["kind"] = "raster"): Promise<PageQuality> {
  const q = newQuality(kind);
  const { width: w, height: h, data } = gray;
  // Laplacian (3x3, reflect-101 border) variance and grey-level standard deviation
  const px = (x: number, y: number) => {
    const xx = x < 0 ? -x : x >= w ? 2 * w - 2 - x : x;
    const yy = y < 0 ? -y : y >= h ? 2 * h - 2 - y : y;
    return data[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))];
  };
  let s = 0;
  let s2 = 0;
  let g1 = 0;
  let g2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = data[y * w + x];
      const lap = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4 * c;
      s += lap;
      s2 += lap * lap;
      g1 += c;
      g2 += c * c;
    }
  }
  const n = w * h;
  q.blur_score = pyRound(s2 / n - (s / n) ** 2, 1);
  q.contrast = pyRound(Math.sqrt(Math.max(0, g2 / n - (g1 / n) ** 2)), 1);
  if (lines.length) q.mean_ocr_confidence = pyRound(mean(lines.map((ln) => ln.confidence)), 3);
  if (knownDpi) q.effective_dpi = pyRound(knownDpi, 1);
  else {
    // estimate from text height: architectural annotation is ~2.5 mm tall
    const heights = lines.filter((ln) => ln.size > 0).map((ln) => ln.size * pxPerUnit);
    if (heights.length) q.effective_dpi = pyRound((median(heights) / 2.5) * 25.4, 1);
  }
  const reasons: string[] = [];
  if (q.effective_dpi !== null && q.effective_dpi < 120) reasons.push(`low resolution (~${Math.round(q.effective_dpi)} dpi)`);
  if (q.blur_score !== null && q.blur_score < 60) reasons.push("blurry");
  if (q.contrast !== null && q.contrast < 18) reasons.push("low contrast");
  if (q.mean_ocr_confidence !== null && q.mean_ocr_confidence < 0.6) reasons.push("text hard to read (possibly handwritten)");
  if (!lines.length) reasons.push("no readable text");
  q.reasons = reasons;
  q.poor = reasons.length > 0;
  return q;
}
