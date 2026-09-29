/**
 * tesseract.js backend. Paths point at local copies of the worker, the WASM
 * core and the English model, so OCR works offline.
 */
import type { GrayImage } from "./platform";
import { platform } from "./platform";
import type { OcrWord, TesseractBackend } from "./ocr";

export interface TesseractPaths {
  langPath: string;
  workerPath?: string;
  corePath?: string;
}

function grayToRgba(img: GrayImage) {
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i];
    data[4 * i] = v;
    data[4 * i + 1] = v;
    data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

export async function createTesseractBackend(paths: TesseractPaths): Promise<TesseractBackend & { terminate(): Promise<void> }> {
  const T = await import("tesseract.js");
  const createWorker = T.createWorker ?? (T as unknown as { default: typeof T }).default.createWorker;
  const worker = await createWorker("eng", 1, {
    langPath: paths.langPath,
    // the bundled worker script is same-origin: load it directly (no blob: URL)
    ...(paths.workerPath ? { workerPath: paths.workerPath, workerBlobURL: false } : {}),
    ...(paths.corePath ? { corePath: paths.corePath } : {}),
    gzip: true,
    cacheMethod: "none",
    logger: () => {},
    errorHandler: () => {},
  });
  let mode: "sparse" | "line" | null = null;
  let wl = "";
  const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined";

  const input = async (img: GrayImage): Promise<unknown> => {
    const png = await platform().encodePng(grayToRgba(img));
    if (isNode) return Buffer.from(png);
    return new Blob([png as BlobPart], { type: "image/png" });
  };

  return {
    version: () => "tesseract.js 5",
    async words(img) {
      if (mode !== "sparse") {
        await worker.setParameters({ tessedit_pageseg_mode: "11" as never, preserve_interword_spaces: "1", tessedit_char_whitelist: "" });
        mode = "sparse";
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = (await worker.recognize((await input(img)) as never, {}, { blocks: true, text: false } as never)) as any;
      const out: OcrWord[] = [];
      let lineId = 0;
      for (const b of data.blocks ?? []) {
        for (const p of b.paragraphs ?? []) {
          for (const l of p.lines ?? []) {
            for (const wd of l.words ?? []) {
              out.push({ text: wd.text, x: wd.bbox.x0, y: wd.bbox.y0, w: wd.bbox.x1 - wd.bbox.x0, h: wd.bbox.y1 - wd.bbox.y0, conf: wd.confidence, line: lineId });
            }
            lineId++;
          }
        }
      }
      return out;
    },
    async line(img, whitelist) {
      if (mode !== "line" || wl !== whitelist) {
        await worker.setParameters({ tessedit_pageseg_mode: "7" as never, tessedit_char_whitelist: whitelist });
        mode = "line";
        wl = whitelist;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = (await worker.recognize((await input(img)) as never, {}, { blocks: true, text: false } as never)) as any;
      const out: { text: string; confidence: number }[] = [];
      for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const wd of l.words ?? []) out.push({ text: wd.text, confidence: wd.confidence });
      return out;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
