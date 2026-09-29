/** Node implementations of the engine platform (tests, benchmark CLI). */
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, loadImage, Path2D } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Platform, RgbaImage } from "../platform";
import { readyOpenCV, setPlatform } from "../platform";
import { imageDpi } from "../imagemeta";

const require = createRequire(import.meta.url);

export function nodePlatform(): Platform {
  // pdfjs-dist may bring its own copy of @napi-rs/canvas; glyph paths must come
  // from the same copy as the canvases we render into
  (globalThis as { Path2D?: unknown }).Path2D = Path2D;
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
      return { width: img.width, height: img.height, data: d.data as Uint8ClampedArray, dpi: imageDpi(bytes) };
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!cvPromise) cvPromise = readyOpenCV(require("@techstark/opencv-js"));
      return cvPromise as Promise<never>;
    },
  };
}

export function useNodePlatform(): Platform {
  const p = nodePlatform();
  setPlatform(p);
  return p;
}
