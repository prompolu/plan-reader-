/**
 * Environment services the engine needs but does not own: PDF.js, a canvas
 * for rendering, image decoding, OpenCV (scans only) and OCR. The app
 * provides browser implementations; tests provide Node ones.
 */
import type { TextLine } from "./types";

export interface GrayImage {
  width: number;
  height: number;
  /** one byte per pixel, row major */
  data: Uint8Array;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Canvas2D {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
}

export interface OCRProvider {
  name: string;
  available(): boolean;
  /** Return text lines in page units (pixel coordinates * unitPerPx). */
  recognize(img: GrayImage, unitPerPx: number, idPrefix: string): Promise<TextLine[]>;
  /** Single-line recognition of a small crop with a restricted alphabet (tag symbols). */
  recognizeLine?(img: GrayImage, whitelist: string): Promise<{ text: string; confidence: number }[]>;
  version?(): string | null;
}

export interface VisionProvider {
  name: string;
  model: string | null;
  available(): boolean;
  classifyPage(imagePng: Uint8Array, textExcerpt: string): Promise<{ page_type: string; confidence: number; rationale: string } | null>;
  adjudicateAssociation(imagePng: Uint8Array, question: Record<string, unknown>): Promise<{ choice: string; confidence: number; rationale: string } | null>;
}

export interface Platform {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjs: any;
  /** Standard font data for pdf.js (URL in the browser, path in Node). */
  standardFontDataUrl?: string;
  createCanvas(width: number, height: number): Canvas2D;
  decodeImage(bytes: Uint8Array): Promise<RgbaImage & { dpi: number | null }>;
  encodePng(img: RgbaImage): Promise<Uint8Array>;
  /** OpenCV.js, loaded on demand (only needed for scanned drawings). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadOpenCV(): Promise<any>;
}

let current: Platform | null = null;

export function setPlatform(p: Platform): void {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error("engine platform not configured");
  return current;
}

export function toGray(img: RgbaImage): GrayImage {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    // same weights as OpenCV's RGB2GRAY
    out[i] = Math.round(0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]);
  }
  return { width: img.width, height: img.height, data: out };
}
