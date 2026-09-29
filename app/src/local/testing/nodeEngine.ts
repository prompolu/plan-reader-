/**
 * Test support: runs the on-device app layer in Node - IndexedDB from
 * fake-indexeddb, the engine in-process instead of in a Web Worker, and the
 * few canvas APIs the app uses backed by @napi-rs/canvas.
 */
import "fake-indexeddb/auto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { useNodePlatform } from "../../engine/node/platform";
import { platform, type OCRProvider, type RgbaImage } from "../../engine/platform";
import { openDocument } from "../../engine/runner";
import { BBox } from "../../engine/types";
import { setEngine } from "../engineClient";
import { inspect, processDocs, type Encoder } from "../engineCore";

/** Vector PDFs never need OCR; a scan in a test would get no text. */
export const noOCR: OCRProvider = { name: "none", available: () => false, recognize: async () => [] };

const encode: Encoder = async (img: RgbaImage) => {
  const png = await platform().encodePng(img);
  return { blob: new Blob([png as BlobPart], { type: "image/png" }), width: img.width, height: img.height };
};

class NodeOffscreenCanvas {
  private c;
  constructor(width: number, height: number) {
    this.c = createCanvas(width, height);
  }
  get width() {
    return this.c.width;
  }
  get height() {
    return this.c.height;
  }
  getContext(kind: "2d") {
    return this.c.getContext(kind);
  }
  async convertToBlob(opts: { type?: string; quality?: number } = {}) {
    const type = opts.type === "image/jpeg" ? "jpeg" : "png";
    const buf = type === "jpeg" ? await this.c.encode("jpeg", Math.round((opts.quality ?? 0.92) * 100)) : await this.c.encode("png");
    return new Blob([buf as BlobPart], { type: `image/${type}` });
  }
}

let installed = false;

export function installNodeEngine(ocr: OCRProvider = noOCR): void {
  if (installed) return;
  installed = true;
  useNodePlatform();
  const g = globalThis as Record<string, unknown>;
  if (!g.OffscreenCanvas) g.OffscreenCanvas = NodeOffscreenCanvas;
  if (!g.createImageBitmap) {
    g.createImageBitmap = async (blob: Blob) => {
      const img = await loadImage(Buffer.from(await blob.arrayBuffer()));
      return Object.assign(img, { close() {} });
    };
  }
  setEngine({
    inspect,
    process: (docs, config, progress) => processDocs(docs, config, progress, ocr, encode),
    async renderRegion(doc, pageInDocument, x, y, w, h, scale) {
      const d = await openDocument(await doc.load(), doc.filename);
      try {
        return (await encode(await d.render(pageInDocument, scale, new BBox(x, y, w, h)), "image/png")).blob;
      } finally {
        await d.close();
      }
    },
  });
}
