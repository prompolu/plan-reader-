/**
 * OCR for raster drawings with tesseract.js (runs locally - nothing is sent anywhere).
 * Drawings contain rotated text (vertical dimension strings), so recognition
 * runs on the upright image and on a 90-degree rotated copy.
 */
import { BBox, TextLine } from "./types";
import type { GrayImage, OCRProvider } from "./platform";

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number; // 0..100
  line: number; // line id within one recognition pass
}

/** Minimal interface over a tesseract.js worker (browser or Node). */
export interface TesseractBackend {
  /** sparse text (psm 11): words with their line ids */
  words(img: GrayImage): Promise<OcrWord[]>;
  /** single line (psm 7) with a character whitelist */
  line(img: GrayImage, whitelist: string): Promise<{ text: string; confidence: number }[]>;
  version(): string | null;
}

const STRIP = new Set([...",;|_«»~`“”‘’()[]{}<>"]);

/** Remove punctuation OCR picks up from nearby strokes (inch and foot marks are kept). */
export function cleanOcrText(t: string): string {
  let s = t.trim();
  while (s && (STRIP.has(s[0]) || s[0] === ".")) s = s.slice(1);
  while (s && (STRIP.has(s[s.length - 1]) || s[s.length - 1] === ".")) s = s.slice(0, -1);
  return s.trim();
}

/** Reject OCR noise: line strokes read as 'I', '|', '1', '-' and similar fragments. */
export function isMeaningful(t: string): boolean {
  return t.replace(/[^A-Za-z0-9]/g, "").length >= 2;
}

interface Word {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
  line: number;
}

function groupWords(words: Word[]): Word[][] {
  const lines = new Map<number, Word[]>();
  for (const wd of words) {
    if (!lines.has(wd.line)) lines.set(wd.line, []);
    lines.get(wd.line)!.push(wd);
  }
  const out: Word[][] = [];
  for (const items of lines.values()) {
    items.sort((a, b) => a.x - b.x);
    // split a tesseract "line" at large gaps (separate annotations)
    let cur = [items[0]];
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1];
      const b = items[i];
      if (b.x - (a.x + a.w) > 1.5 * Math.max(a.h, b.h)) {
        out.push(cur);
        cur = [b];
      } else cur.push(b);
    }
    out.push(cur);
  }
  return out;
}

function mkLine(words: Word[], angle: number, tf: (x: number, y: number) => [number, number], upp: number): TextLine {
  const parts: string[] = [];
  const boxes: BBox[] = [];
  words.forEach((wd, k) => {
    if (k) {
      parts.push(" ");
      const prev = boxes[boxes.length - 1];
      boxes.push(new BBox(prev.x1, prev.y, 0, 0));
    }
    const n = wd.text.length;
    for (let j = 0; j < n; j++) {
      const x0 = wd.x + (wd.w * j) / n;
      const x1 = wd.x + (wd.w * (j + 1)) / n;
      const p0 = tf(x0, wd.y);
      const p1 = tf(x1, wd.y + wd.h);
      boxes.push(BBox.fromPoints(p0[0] * upp, p0[1] * upp, p1[0] * upp, p1[1] * upp));
    }
    parts.push(wd.text);
  });
  const real = boxes.filter((b) => b.w > 0 || b.h > 0);
  let bb = real[0];
  for (const b of real.slice(1)) bb = bb.union(b);
  const size = Math.max(...words.map((wd) => wd.h)) * upp;
  const conf = words.reduce((a, wd) => a + wd.conf, 0) / words.length;
  return new TextLine("", parts.join(""), bb, boxes, angle, size, "ocr", conf);
}

/** Drop lines that overlap a higher-confidence line (the same text read at the wrong angle). */
function dedupe(lines: TextLine[]): TextLine[] {
  const keyed = lines.map((ln, i) => ({ ln, i, k: -ln.confidence * Math.max(ln.text.trim().length, 1) ** 0.5 }));
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  const kept: TextLine[] = [];
  for (const { ln } of keyed) {
    const clash = kept.some((k) => ln.bbox.intersectionArea(k.bbox) > 0.5 * Math.min(ln.bbox.area, k.bbox.area));
    if (!clash) kept.push(ln);
  }
  return kept;
}

function rotateCW(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  // rotated image is h wide, w tall: (xr, yr) <- (x = yr, y = h - 1 - xr)
  for (let yr = 0; yr < w; yr++) for (let xr = 0; xr < h; xr++) out[yr * h + xr] = data[(h - 1 - xr) * w + yr];
  return { width: h, height: w, data: out };
}

export class TesseractOCR implements OCRProvider {
  readonly name = "tesseract";

  constructor(
    private readonly backend: TesseractBackend,
    private readonly minConf = 30,
  ) {}

  available(): boolean {
    return true;
  }

  version(): string | null {
    return this.backend.version();
  }

  private async run(img: GrayImage): Promise<Word[]> {
    const raw = await this.backend.words(img);
    const out: Word[] = [];
    for (const wd of raw) {
      const t0 = (wd.text ?? "").trim();
      if (!t0 || wd.conf < this.minConf) continue;
      const t = cleanOcrText(t0);
      if (!t) continue;
      out.push({ text: t, x: wd.x, y: wd.y, w: wd.w, h: wd.h, conf: wd.conf / 100, line: wd.line });
    }
    return out;
  }

  async recognize(img: GrayImage, unitPerPx: number, idPrefix: string): Promise<TextLine[]> {
    const h = img.height;
    let out: TextLine[] = [];
    // pass 1: upright text
    for (const ln of groupWords(await this.run(img))) out.push(mkLine(ln, 0, (x, y) => [x, y], unitPerPx));
    // pass 2: text reading bottom-to-top (rotate the image clockwise so it becomes upright)
    for (const ln of groupWords(await this.run(rotateCW(img)))) out.push(mkLine(ln, 90, (xr, yr) => [yr, h - 1 - xr], unitPerPx));
    out = dedupe(out).filter((ln) => isMeaningful(ln.text));
    out.forEach((ln, i) => (ln.id = `${idPrefix}-o${i}`));
    return out;
  }

  recognizeLine(img: GrayImage, whitelist: string): Promise<{ text: string; confidence: number }[]> {
    return this.backend.line(img, whitelist);
  }
}
