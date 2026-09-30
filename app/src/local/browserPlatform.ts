/**
 * Browser implementation of the engine platform, used inside the engine Web
 * Worker: PDF.js runs in the same thread (no nested worker), rendering uses
 * OffscreenCanvas, OpenCV.js and tesseract.js load on demand from bundled files.
 */
// the legacy build carries polyfills (e.g. Promise.withResolvers) for the desktop
// app's Chromium 116 (macOS 10.13 support) and iPhones before iOS 17.4
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
// PDF.js runs its parser in this (worker) thread when the handler is registered globally
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { readyOpenCV, setPlatform, type Platform, type RgbaImage } from "../engine/platform";
import { imageDpi } from "../engine/imagemeta";

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

interface CanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

/** PDF.js canvas factory backed by OffscreenCanvas (there is no DOM in a worker). */
export class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(cc: CanvasAndContext, width: number, height: number): void {
    if (!cc.canvas) return;
    cc.canvas.width = Math.max(1, Math.ceil(width));
    cc.canvas.height = Math.max(1, Math.ceil(height));
  }
  destroy(cc: CanvasAndContext): void {
    if (cc.canvas) {
      cc.canvas.width = 0;
      cc.canvas.height = 0;
    }
    cc.canvas = null;
    cc.context = null;
  }
}

/** SVG filters need a DOM; drawings rarely use transfer functions, so filters are skipped. */
export class NoFilterFactory {
  addFilter() {
    return "none";
  }
  addHCMFilter() {
    return "none";
  }
  addAlphaFilter() {
    return "none";
  }
  addLuminosityFilter() {
    return "none";
  }
  addHighlightHCMFilter() {
    return "none";
  }
  destroy() {}
}

let cvPromise: Promise<unknown> | null = null;

export function browserPlatform(assetBase: string): Platform {
  return {
    pdfjs: {
      ...pdfjs,
      getDocument: (params: Record<string, unknown>) =>
        pdfjs.getDocument({
          ...params,
          CanvasFactory: OffscreenCanvasFactory,
          FilterFactory: NoFilterFactory,
          disableFontFace: true,
          isOffscreenCanvasSupported: true,
          cMapUrl: `${assetBase}pdfjs/cmaps/`,
          cMapPacked: true,
          // decided explicitly: PDF.js' default reads document.baseURI, which workers lack
          useWorkerFetch: false,
        } as never),
    },
    standardFontDataUrl: `${assetBase}pdfjs/standard_fonts/`,
    createCanvas: (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) as never,
    async decodeImage(bytes) {
      const blob = new Blob([bytes as BlobPart]);
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
      } catch {
        // "from-image" exists from Chrome 111; older engines (the Windows 7 app) apply the photo's orientation by default
        bmp = await createImageBitmap(blob);
      }
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
      bmp.close();
      return { width: d.width, height: d.height, data: d.data, dpi: imageDpi(bytes) };
    },
    async encodePng(img: RgbaImage) {
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext("2d")!;
      ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    },
    loadOpenCV() {
      if (!cvPromise) cvPromise = import("@techstark/opencv-js").then(readyOpenCV);
      return cvPromise as Promise<never>;
    },
  };
}

export function installBrowserPlatform(assetBase: string): void {
  setPlatform(browserPlatform(assetBase));
}
