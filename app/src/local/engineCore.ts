/**
 * Engine operations shared by the Web Worker (app) and the in-process engine
 * (tests): validate a drawing, render page images and run the extraction.
 */
import { defaultConfig, ExtractionPipeline, openDocument, type PageResult } from "../engine/runner";
import { Thresholds } from "../engine/confidence";
import { classificationToDict } from "../engine/types";
import { pyRound } from "../engine/py";
import type { OCRProvider, RgbaImage } from "../engine/platform";
import type { AnalysedPage, ProcessConfig, ProcessResult, RenderedPage, WorkerDoc } from "./engineClient";

export type Progress = (step: string, frac: number, msg: string) => void;

/** Encodes rendered pages (PNG) and thumbnails (JPEG, downscaled). */
export type Encoder = (img: RgbaImage, type: "image/png" | "image/jpeg", quality?: number, maxW?: number) => Promise<{ blob: Blob; width: number; height: number }>;

export const RENDER_DPI = 200;
export const RENDER_MAX_PX = 6000;
export const THUMB_WIDTH = 360;

export function renderScale(w: number, h: number, unit: string): number {
  const s = unit === "pt" ? RENDER_DPI / 72 : 1;
  return Math.min(s, RENDER_MAX_PX / Math.max(w, h));
}

function overlay(pr: PageResult) {
  return {
    views: pr.views.map((v) => v.toDict()),
    dimensions: pr.dims.map((d) => ({
      id: d.id,
      text: d.text,
      value_mm: pyRound(d.valueMm, 2),
      kind: d.kind,
      axis: d.axis,
      text_bbox: d.textBBox.toDict(),
      line: d.line ? d.line.toDict() : null,
      extension_lines: d.extensionLines.map((s) => s.toDict()),
      chain_id: d.chainId,
      scale_check: d.scaleCheck,
    })),
    tags: pr.tags.map((t) => ({ id: t.id, text: t.text, bbox: t.bbox.toDict() })),
    detections: pr.detections.map((d) => ({
      id: d.id,
      kind: d.kind,
      bbox: d.bbox.toDict(),
      tag: d.tag ? d.tag.text : null,
      confidence: pyRound(d.confidence, 3),
      view_type: d.viewType,
      width_dimension_id: d.widthAssoc ? d.widthAssoc.dimensionId : null,
      height_dimension_id: d.heightAssoc ? d.heightAssoc.dimensionId : null,
    })),
    schedule_rows: pr.schedules.map((s) => ({ id: s.id, tag: s.tag, row_bbox: s.rowBBox.toDict() })),
    text: pr.page.lines.map((ln) => ({ id: ln.id, text: ln.text, bbox: ln.bbox.toDict() })),
  };
}

function analysedPage(pr: PageResult): AnalysedPage {
  const drawingViews = pr.views.filter((v) => v.viewType !== "notes" && v.viewType !== "cover");
  const primary = drawingViews[0] ?? pr.views[0] ?? null;
  return {
    index: pr.page.index,
    docIndex: pr.page.documentIndex,
    pageInDocument: pr.page.pageInDocument,
    width: pr.page.width,
    height: pr.page.height,
    unit: pr.page.unit,
    mmPerUnit: pr.page.mmPerUnit,
    rotation: pr.page.rotation,
    classification: classificationToDict(pr.cls),
    pageType: pr.cls.pageType,
    sheetNumber: pr.cls.sheetNumber,
    sheetTitle: pr.cls.sheetTitle,
    floor: pr.cls.floor,
    quality: { ...pr.page.quality },
    scale: { primary: primary ? primary.scale.toDict() : null, views: pr.views.map((v) => ({ id: v.id, title: v.title, view_type: v.viewType, scale: v.scale.toDict() })) },
    overlay: overlay(pr),
  };
}

export const MAX_PAGES = 300;

/** Check that a file can be opened and is within limits. */
export async function inspect(data: Uint8Array, filename: string): Promise<{ pageCount: number; error: string | null }> {
  let doc;
  try {
    doc = await openDocument(data, filename);
  } catch (e) {
    console.warn(`could not open ${filename}:`, e instanceof Error ? e.stack : e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) return { pageCount: 0, error: "Password-protected PDFs are not supported - remove the password and add it again" };
    return { pageCount: 0, error: data[0] === 0x25 ? "The PDF could not be read (damaged or not a PDF)" : "The image could not be read (damaged or unsupported)" };
  }
  try {
    const n = doc.pageCount;
    if (n === 0) return { pageCount: 0, error: "The PDF has no pages" };
    if (n > MAX_PAGES) return { pageCount: n, error: `The PDF has ${n} pages; the limit is ${MAX_PAGES}` };
    for (let i = 0; i < n; i++) {
      const [w, h, unit] = await doc.pageSize(i);
      if (w <= 0 || h <= 0 || (unit === "pt" && Math.max(w, h) > 14400)) return { pageCount: n, error: "The PDF has an invalid page size" };
      if (unit === "px" && w * h > 120_000_000) return { pageCount: n, error: "Image resolution is too large" };
    }
    return { pageCount: n, error: null };
  } finally {
    await doc.close();
  }
}

/** Render page images for new documents, then run the extraction on all documents. */
export async function processDocs(docs: WorkerDoc[], config: ProcessConfig, progress: Progress, ocr: OCRProvider, encode: Encoder): Promise<ProcessResult> {
  const rendered: RenderedPage[] = [];
  const toRender = docs.filter((d) => d.render);
  let r = 0;
  progress("rendered", 0, "Rendering pages");
  for (const d of toRender) {
    const doc = await openDocument(d.data, d.filename);
    try {
      for (let i = 0; i < doc.pageCount; i++) {
        const [w, h, unit] = await doc.pageSize(i);
        const img = await doc.render(i, renderScale(w, h, unit));
        const full = await encode(img, "image/png");
        const thumb = await encode(img, "image/jpeg", 0.8, THUMB_WIDTH);
        rendered.push({ docId: d.id, pageInDocument: i, width: w, height: h, unit, image: full.blob, thumb: thumb.blob, imageWidth: img.width, imageHeight: img.height });
        progress("rendered", (r + (i + 1) / doc.pageCount) / Math.max(toRender.length, 1), `Rendered ${d.filename} page ${i + 1} of ${doc.pageCount}`);
      }
    } finally {
      await doc.close();
    }
    r++;
  }
  progress("rendered", 1, `${rendered.length} pages rendered`);

  const cfg = defaultConfig({
    thresholds: Thresholds.fromDict(config.thresholds),
    manualScales: new Map(config.manualScales),
    pageTypeOverrides: new Map(config.pageTypeOverrides),
  });
  const result = await new ExtractionPipeline(ocr, null, cfg).run(
    docs.map((d) => ({ index: d.index, filename: d.filename, data: d.data })),
    progress,
  );
  return {
    rendered,
    pages: result.pages.map(analysedPage),
    records: result.records,
    models: result.models,
    stages: result.stages,
    warnings: result.warnings,
  };
}
