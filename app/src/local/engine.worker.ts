/// <reference lib="webworker" />
/**
 * Engine worker: opens drawings, renders page images and runs the extraction
 * pipeline off the main thread. Everything happens on this device.
 */
import { installBrowserPlatform } from "./browserPlatform";
import { openDocument } from "../engine/runner";
import { TesseractOCR } from "../engine/ocr";
import { createTesseractBackend } from "../engine/tesseract";
import { BBox } from "../engine/types";
import type { GrayImage, OCRProvider, RgbaImage } from "../engine/platform";
import type { TextLine } from "../engine/types";
import type { ProcessConfig, WorkerDoc } from "./engineClient";
import { inspect, processDocs, type Encoder } from "./engineCore";

declare const self: DedicatedWorkerGlobalScope;

let installedBase: string | null = null;
function ensurePlatform(assetBase: string) {
  if (installedBase !== assetBase) {
    installBrowserPlatform(assetBase);
    installedBase = assetBase;
  }
}

/** OCR is only needed for scans; tesseract.js and its model load on first use. */
class LazyOCR implements OCRProvider {
  readonly name = "tesseract";
  private inner: Promise<TesseractOCR> | null = null;
  constructor(private readonly assetBase: string) {}
  available() {
    return true;
  }
  private get(): Promise<TesseractOCR> {
    if (!this.inner) {
      const b = this.assetBase;
      const p = createTesseractBackend({ workerPath: `${b}tesseract/worker.min.js`, corePath: `${b}tesseract/core`, langPath: `${b}tesseract/lang` }).then((be) => new TesseractOCR(be));
      // a failed load (e.g. missing files) is retried on the next scan
      p.catch(() => {
        if (this.inner === p) this.inner = null;
      });
      this.inner = p;
    }
    return this.inner;
  }
  async recognize(img: GrayImage, upp: number, prefix: string): Promise<TextLine[]> {
    return (await this.get()).recognize(img, upp, prefix);
  }
  async recognizeLine(img: GrayImage, whitelist: string) {
    return (await this.get()).recognizeLine(img, whitelist);
  }
}

let ocr: LazyOCR | null = null;

const encode: Encoder = async (img: RgbaImage, type, quality, maxW) => {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext("2d")!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  if (maxW && img.width > maxW) {
    const s = maxW / img.width;
    const t = new OffscreenCanvas(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
    const ctx = t.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(c, 0, 0, t.width, t.height);
    return { blob: await t.convertToBlob({ type, quality }), width: t.width, height: t.height };
  }
  return { blob: await c.convertToBlob({ type, quality }), width: img.width, height: img.height };
};

// open documents for region rendering (most recently used last)
const regionDocs = new Map<string, Awaited<ReturnType<typeof openDocument>>>();
const REGION_CACHE = 4;

async function region(msg: { docId: string; filename: string; data: Uint8Array | null; pageInDocument: number; x: number; y: number; w: number; h: number; scale: number }): Promise<Blob> {
  let doc = regionDocs.get(msg.docId);
  if (!doc) {
    if (!msg.data) throw new Error("document data required");
    doc = await openDocument(msg.data, msg.filename);
    regionDocs.set(msg.docId, doc);
    while (regionDocs.size > REGION_CACHE) {
      const [k, old] = regionDocs.entries().next().value!;
      regionDocs.delete(k);
      await old.close();
    }
  } else {
    regionDocs.delete(msg.docId);
    regionDocs.set(msg.docId, doc);
  }
  const scale = Math.min(msg.scale, 4096 / Math.max(msg.w, msg.h));
  const img = await doc.render(msg.pageInDocument, scale, new BBox(msg.x, msg.y, msg.w, msg.h));
  return (await encode(img, "image/png")).blob;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as Record<string, unknown> & { id: number; type: string };
  const reply = (type: string, extra: Record<string, unknown>) => self.postMessage({ id: m.id, type, ...extra });
  try {
    if (m.type === "inspect") {
      ensurePlatform(m.assetBase as string);
      reply("result", { result: await inspect(m.data as Uint8Array, m.filename as string) });
    } else if (m.type === "process") {
      const config = m.config as ProcessConfig;
      ensurePlatform(config.assetBase);
      if (!ocr) ocr = new LazyOCR(config.assetBase);
      const result = await processDocs(m.docs as WorkerDoc[], config, (step, frac, msg) => reply("progress", { step, frac, msg }), ocr, encode);
      reply("result", { result });
    } else if (m.type === "region") {
      ensurePlatform(m.assetBase as string);
      reply("result", { result: await region(m as never) });
    } else reply("error", { error: `unknown request ${m.type}` });
  } catch (err) {
    console.error(err);
    reply("error", { error: err instanceof Error ? err.message : String(err) });
  }
};
