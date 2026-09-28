/** Node implementations of the engine platform (tests, benchmark CLI). */
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Platform, RgbaImage } from "../platform";
import { setPlatform } from "../platform";

const require = createRequire(import.meta.url);

function pngDpi(bytes: Uint8Array): number | null {
  // pHYs chunk: pixels per metre
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (!sig.every((b, i) => bytes[i] === b)) return jpegDpi(bytes);
  let p = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (p + 8 < bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8));
    if (type === "pHYs") {
      const ppmX = dv.getUint32(p + 8);
      const unit = bytes[p + 16];
      return unit === 1 && ppmX > 0 ? ppmX * 0.0254 : null;
    }
    if (type === "IDAT") break;
    p += 12 + len;
  }
  return null;
}

function jpegDpi(bytes: Uint8Array): number | null {
  // JFIF APP0: units (1 = dpi, 2 = dpcm), Xdensity
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.slice(6, 10)) === "JFIF") {
    const units = bytes[13];
    const xd = (bytes[14] << 8) | bytes[15];
    if (units === 1) return xd;
    if (units === 2) return xd * 2.54;
  }
  return null;
}

export function nodePlatform(): Platform {
  const fontDir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  let cvPromise: Promise<unknown> | null = null;
  return {
    pdfjs,
    standardFontDataUrl: fontDir,
    createCanvas: (w, h) => createCanvas(w, h) as never,
    async decodeImage(bytes) {
      const img = await loadImage(Buffer.from(bytes));
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height);
      return { width: img.width, height: img.height, data: d.data as Uint8ClampedArray, dpi: pngDpi(bytes) };
    },
    async encodePng(img: RgbaImage) {
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext("2d");
      const id = ctx.createImageData(img.width, img.height);
      id.data.set(img.data);
      ctx.putImageData(id, 0, 0);
      return new Uint8Array(await c.encode("png"));
    },
    loadOpenCV() {
      if (!cvPromise) {
        cvPromise = new Promise((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cv: any = require("@techstark/opencv-js");
          if (cv.Mat) resolve(cv);
          else cv.onRuntimeInitialized = () => resolve(cv);
        });
      }
      return cvPromise as Promise<never>;
    },
  };
}

export function useNodePlatform(): Platform {
  const p = nodePlatform();
  setPlatform(p);
  return p;
}
