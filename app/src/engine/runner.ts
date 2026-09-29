/**
 * Pipeline orchestration.
 *
 *   PDF / image -> text layer / OCR + geometry -> page classification ->
 *   view segmentation + scale -> dimensions -> scale calibration -> tags ->
 *   openings -> tag and dimension association -> schedules ->
 *   cross-reference, duplicates, conflicts, confidence
 */
import { assignTags, associateDimensions } from "./association";
import { classifyPage } from "./classify";
import { Thresholds } from "./confidence";
import { DetectionContext } from "./context";
import { buildRecords, type OpeningRecord, type PageContext } from "./crossref";
import { LinearDimensionDetector } from "./dimensions";
import { ImageDocument } from "./imagedoc";
import { ElevationOpeningDetector, PlanOpeningDetector } from "./openings";
import { PdfDocument } from "./pdfdoc";
import { platform, toGray, type OCRProvider, type VisionProvider } from "./platform";
import { calibrateFromDimensions, findScaleMentions, formatRatio, scaleCheck } from "./scale";
import { extractSchedules } from "./schedules";
import { detectTags, symbolSegments } from "./tags";
import {
  SCHEDULE_TYPES,
  ScaleInfo,
  classificationToDict,
  detectionToDict,
  dimensionToDict,
  evidence,
  scheduleToDict,
  tagToDict,
  type BBox,
  type DimensionAnnotation,
  type OpeningDetection,
  type PageClassification,
  type PageData,
  type ScheduleEntry,
  type TagDetection,
  type View,
} from "./types";
import { segmentViews } from "./views";
import { pyRound } from "./py";
import { EXTRACTION_VERSION, sniffType } from "./meta";

export { EXTRACTION_VERSION, STEPS, sniffType } from "./meta";


const DRAWING_VIEWS = new Set(["floor_plan", "elevation", "detail", "section"]);


export interface InputDocument {
  index: number;
  filename: string;
  data: Uint8Array;
}

export interface PipelineConfig {
  thresholds: Thresholds;
  ocrDpi: number;
  maxVisionCalls: number;
  visionClassifyBelow: number;
  /** user overrides keyed by global page index */
  manualScales: Map<number, { text?: string | null; ratio: number }>;
  pageTypeOverrides: Map<number, string>;
}

export function defaultConfig(p: Partial<PipelineConfig> = {}): PipelineConfig {
  return { thresholds: new Thresholds(), ocrDpi: 300, maxVisionCalls: 40, visionClassifyBelow: 0.6, manualScales: new Map(), pageTypeOverrides: new Map(), ...p };
}

export interface PageResult {
  page: PageData;
  cls: PageClassification;
  views: View[];
  dims: DimensionAnnotation[];
  tags: TagDetection[];
  detections: OpeningDetection[];
  orphanTags: TagDetection[];
  schedules: ScheduleEntry[];
  stageSeconds: Record<string, number>;
}

export function pageResultToDict(r: PageResult) {
  const p = r.page;
  const sec: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.stageSeconds)) sec[k] = pyRound(v, 3);
  return {
    index: p.index,
    document_index: p.documentIndex,
    page_in_document: p.pageInDocument,
    width: p.width,
    height: p.height,
    unit: p.unit,
    mm_per_unit: p.mmPerUnit,
    rotation: p.rotation,
    label: p.label,
    has_text_layer: p.hasTextLayer,
    quality: p.quality,
    classification: classificationToDict(r.cls),
    views: r.views.map((v) => v.toDict()),
    dimensions: r.dims.map(dimensionToDict),
    tags: r.tags.map(tagToDict),
    detections: r.detections.map(detectionToDict),
    orphan_tags: r.orphanTags.map(tagToDict),
    schedules: r.schedules.map(scheduleToDict),
    stage_seconds: sec,
  };
}

export interface ExtractionResult {
  pages: PageResult[];
  records: OpeningRecord[];
  version: string;
  models: Record<string, unknown>;
  stages: { name: string; seconds: number }[];
  visionLog: Record<string, unknown>[];
  warnings: string[];
}

export type ProgressFn = (step: string, frac: number, msg: string) => void;

type AnyDoc = PdfDocument | ImageDocument;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

class NullOCR implements OCRProvider {
  name = "none";
  available() {
    return false;
  }
  async recognize() {
    return [];
  }
}

export class ExtractionPipeline {
  visionCalls = 0;
  visionLog: Record<string, unknown>[] = [];
  warnings: string[] = [];

  constructor(
    readonly ocr: OCRProvider = new NullOCR(),
    readonly vision: VisionProvider | null = null,
    readonly config: PipelineConfig = defaultConfig(),
  ) {}

  // -- stage: per page -------------------------------------------------------

  /** Text layer + geometry; OCR and raster geometry when needed. */
  async analyzePage(doc: AnyDoc, i: number, index: number, documentIndex: number): Promise<PageData> {
    const pd = await doc.extract(i, index, documentIndex);
    const needsOcr = doc instanceof ImageDocument || pd.quality.kind === "raster" || pd.quality.kind === "vector_outlined_text";
    if (!needsOcr) return pd;
    const raster = await import("./raster");
    let scale: number;
    if (doc instanceof PdfDocument) scale = this.config.ocrDpi / 72;
    else {
      // upscale so small annotation text has enough pixels per character
      const dpi = doc.dpi ?? 150;
      scale = Math.max(1, Math.min(3, this.config.ocrDpi / dpi));
      if (Math.max(pd.width, pd.height) * scale > 12000) scale = Math.max(1, 12000 / Math.max(pd.width, pd.height));
    }
    const gray = toGray(await doc.render(i, scale));
    let symbolBoxes: BBox[] = [];
    if (this.ocr.available()) {
      const clean = await raster.removeLongLines(gray, Math.max(40, Math.trunc(Math.min(gray.width, gray.height) * 0.012)));
      pd.lines = await this.ocr.recognize(clean, 1 / scale, `p${index}`);
      if (this.ocr.recognizeLine) {
        const heights = pd.lines.filter((ln) => ln.size > 0 && ln.text.length >= 3).map((ln) => ln.size * scale);
        const textPx = heights.length ? medianOf(heights) : 20;
        const [tagLines, boxes] = await raster.readSymbolTags(gray, 1 / scale, `p${index}`, textPx, this.ocr);
        // symbol reads replace overlapping general OCR fragments
        pd.lines = pd.lines.filter((ln) => !boxes.some((sb) => sb.contains(ln.bbox, 2 / scale))).concat(tagLines);
        symbolBoxes = boxes;
      }
    } else {
      this.warnings.push(`${pd.label}: OCR is not available, text could not be read from this raster page`);
    }
    if (pd.quality.kind === "raster" || doc instanceof ImageDocument) {
      pd.geometry = await raster.extractRasterGeometry(
        gray,
        1 / scale,
        pd.lines.map((ln) => ln.bbox),
      );
      // tag symbols found by the symbol pass become closed outlines (enclosures)
      for (const sb of symbolBoxes)
        pd.geometry.polygons.push([
          [sb.x0, sb.y0],
          [sb.x1, sb.y0],
          [sb.x1, sb.y1],
          [sb.x0, sb.y1],
        ]);
    }
    const dpi = doc instanceof ImageDocument ? doc.dpi : null;
    pd.quality = await raster.assessRaster(gray, pd.lines, scale, dpi, pd.quality.kind);
    return pd;
  }

  async classify(doc: AnyDoc, pd: PageData): Promise<PageClassification> {
    const mentions = findScaleMentions(pd.lines)
      .filter((m) => m.ratio)
      .map((m) => m.text);
    const cls = classifyPage(pd, mentions);
    const override = this.config.pageTypeOverrides.get(pd.index);
    if (override) {
      cls.signals.push({ type: override, weight: 99, code: "manual", detail: "Page type set by user" });
      cls.pageType = override;
      cls.confidence = 1;
      return cls;
    }
    if (cls.confidence < this.config.visionClassifyBelow && this.visionBudget()) {
      try {
        const thumb = await this.thumb(doc, pd);
        const excerpt = pd.lines
          .slice(0, 200)
          .map((ln) => ln.text)
          .join("\n");
        const ans = await this.vision!.classifyPage(thumb, excerpt);
        this.visionLog.push({ page: pd.index, task: "classify", answer: ans });
        if (ans && ans.page_type && Number(ans.confidence ?? 0) >= 0.7) {
          cls.signals.push({ type: ans.page_type, weight: 2, code: "vision", detail: `Vision model: ${(ans.rationale ?? "").slice(0, 200)}` });
          if (ans.page_type !== cls.pageType) {
            cls.secondaryTypes = [cls.pageType, ...cls.secondaryTypes.filter((t) => t !== ans.page_type)];
            cls.pageType = ans.page_type;
          }
          cls.confidence = Math.max(cls.confidence, Math.min(0.85, Number(ans.confidence)));
        }
      } catch (exc) {
        this.visionLog.push({ page: pd.index, task: "classify", error: String(exc) });
      }
    }
    return cls;
  }

  private visionBudget(): boolean {
    if (!this.vision || !this.vision.available() || this.visionCalls >= this.config.maxVisionCalls) return false;
    this.visionCalls++;
    return true;
  }

  private async thumb(doc: AnyDoc, pd: PageData): Promise<Uint8Array> {
    const s = 1600 / Math.max(pd.width, pd.height);
    return platform().encodePng(await doc.render(pd.pageInDocument, s));
  }

  applyScales(pd: PageData, views: View[]): void {
    const manual = this.config.manualScales.get(pd.index);
    if (!manual) return;
    for (const v of views) {
      if (v.viewType === "notes" || v.viewType === "cover" || SCHEDULE_TYPES.has(v.viewType)) continue;
      const det = v.scale;
      v.scale = new ScaleInfo(manual.text || formatRatio(Number(manual.ratio)), Number(manual.ratio), "manual", 1, det.bbox, false, [det.text ? `Detected: ${det.text}` : "No scale detected"]);
    }
  }

  /** Check / derive each view's scale from its dimension lines. */
  calibrate(pd: PageData, views: View[], dims: DimensionAnnotation[]): void {
    for (const v of views) {
      const vd = dims.filter((d) => d.viewId === v.id);
      const cal = calibrateFromDimensions(vd, pd.mmPerUnit);
      if (cal === null) continue;
      const [ratio, n, agreement] = cal;
      if (v.scale.source === "manual") continue;
      if (v.scale.ratio === null && !v.scale.notToScale) {
        const imperial = Math.abs(ratio - Math.round(ratio)) > 0 || [48, 96, 64, 24, 32, 16, 192, 128].includes(ratio);
        v.scale = new ScaleInfo(formatRatio(ratio, imperial), ratio, "calibrated", Math.min(0.85, 0.5 + 0.05 * n), null, false, [`No scale notation found; derived from ${n} dimension lines`]);
      } else if (v.scale.ratio !== null && Math.abs(v.scale.ratio - ratio) / ratio > 0.02 && agreement > 0.6) {
        v.scale.notes.push(`Stated ${v.scale.text} but ${n} dimension lines indicate ${formatRatio(ratio)}; using ${formatRatio(ratio)}`);
        v.scale = new ScaleInfo(formatRatio(ratio), ratio, "calibrated", 0.8, v.scale.bbox, false, v.scale.notes);
      } else if (v.scale.ratio !== null) {
        v.scale.confidence = Math.min(0.99, v.scale.confidence + 0.08);
        v.scale.notes.push(`Verified against ${n} dimension lines`);
      }
      for (const d of vd) d.scaleCheck = scaleCheck(d, v.scale.ratio, pd.mmPerUnit);
    }
  }

  async processPage(doc: AnyDoc, i: number, index: number, documentIndex: number): Promise<PageResult> {
    const t: Record<string, number> = {};
    let t0 = now();
    const pd = await this.analyzePage(doc, i, index, documentIndex);
    t.analyze = now() - t0;
    t0 = now();
    const cls = await this.classify(doc, pd);
    t.classify = now() - t0;
    t0 = now();
    const views = segmentViews(pd, cls);
    this.applyScales(pd, views);
    t.views = now() - t0;
    const ctxFor = (v: View) => new DetectionContext(pd, v);

    t0 = now();
    const tags = detectTags(pd, views, cls.titleBlock, DRAWING_VIEWS);
    const symbols = symbolSegments(pd, tags);
    t.tags = now() - t0;

    t0 = now();
    const [dims, usedDims] = new LinearDimensionDetector(symbols).detect(pd, views, cls, ctxFor);
    this.calibrate(pd, views, dims);
    t.dimensions = now() - t0;

    t0 = now();
    // annotation graphics (dimensions, tag symbols) are not building geometry
    const used = new Set([...usedDims, ...symbols]);
    let detections: OpeningDetection[] = [];
    let orphans: TagDetection[] = [];
    for (const v of views) {
      const ctx = ctxFor(v);
      const vt = tags.filter((tg) => tg.viewId === v.id);
      let dets: OpeningDetection[];
      if (v.viewType === "floor_plan" || v.viewType === "detail") dets = new PlanOpeningDetector(used).detect(pd, v, vt, ctx);
      else if (v.viewType === "elevation") dets = new ElevationOpeningDetector(used).detect(pd, v, vt, ctx);
      else dets = [];
      const left = assignTags(dets, vt, ctx);
      if (ctx.raster) {
        // scanned geometry is noisy: an untagged empty gap is not reliable evidence,
        // and everything found on a raster page is marked for verification
        dets = dets.filter((d) => !(d.kind === "opening" && d.tag === null));
        for (const d of dets) {
          d.confidence = pyRound(d.confidence * 0.8, 3);
          d.evidence.push(evidence("raster", "Detected on a raster image (OCR + line detection) - verify against the drawing", null, { pageIndex: d.pageIndex, bbox: d.bbox }));
        }
      }
      orphans = orphans.concat(left);
      detections = detections.concat(dets);
    }
    t.openings = now() - t0;

    t0 = now();
    for (const v of views) {
      const vd = detections.filter((d) => d.viewId === v.id);
      if (!vd.length) continue;
      const ctx = ctxFor(v);
      const crop = async (b: BBox) => {
        const s = Math.min(4, 1400 / Math.max(b.w, b.h, 1));
        return platform().encodePng(await doc.render(pd.pageInDocument, s, b));
      };
      const vision = this.vision && this.vision.available() && this.visionCalls < this.config.maxVisionCalls ? this.vision : null;
      const before = this.visionLog.length;
      this.visionLog.push(...(await associateDimensions(vd, dims, v, ctx, vision, crop)));
      this.visionCalls += this.visionLog.length - before;
    }
    t.associate = now() - t0;

    t0 = now();
    let schedules: ScheduleEntry[] = [];
    if (SCHEDULE_TYPES.has(cls.pageType) || cls.secondaryTypes.some((s) => SCHEDULE_TYPES.has(s)) || views.some((v) => SCHEDULE_TYPES.has(v.viewType))) schedules = extractSchedules(pd, views, cls);
    t.schedules = now() - t0;
    return { page: pd, cls, views, dims, tags, detections, orphanTags: orphans, schedules, stageSeconds: t };
  }

  // -- whole set -------------------------------------------------------------

  async run(docs: InputDocument[], progress: ProgressFn = () => {}): Promise<ExtractionResult> {
    const stages: { name: string; seconds: number }[] = [];
    const opened: [InputDocument, AnyDoc][] = [];
    let totalPages = 0;
    for (const d of docs) {
      const doc = await openDocument(d.data, d.filename);
      opened.push([d, doc]);
      totalPages += doc.pageCount;
    }
    const results: PageResult[] = [];
    let index = 0;
    const tStart = now();
    try {
      for (const [d, doc] of opened) {
        for (let i = 0; i < doc.pageCount; i++) {
          progress("analyzed", index / Math.max(totalPages, 1), `Analyzing page ${index + 1} of ${totalPages}`);
          try {
            results.push(await this.processPage(doc, i, index, d.index));
          } catch (exc) {
            // one bad page must not sink the set
            console.error(`page ${index} failed`, exc);
            this.warnings.push(`${d.filename} page ${i + 1}: analysis failed (${exc instanceof Error ? exc.message : String(exc)})`);
          }
          index++;
        }
      }
    } finally {
      for (const [, doc] of opened) await doc.close();
    }
    stages.push({ name: "per_page", seconds: pyRound(now() - tStart, 3) });
    progress("classified", 1, "Pages classified");
    progress("dimensions", 1, `${results.reduce((a, r) => a + r.dims.length, 0)} dimensions found`);
    progress("openings", 1, `${results.reduce((a, r) => a + r.detections.length, 0)} opening appearances found`);
    progress("associated", 1, "Dimensions associated");

    const t0 = now();
    progress("schedules", 0.5, "Cross-checking schedules");
    const records = this.crossReference(results);
    stages.push({ name: "crossref", seconds: pyRound(now() - t0, 3) });
    progress("crossref", 1, `${records.length} opening types`);
    progress("scored", 1, "Confidence scored");
    return {
      pages: results,
      records,
      version: EXTRACTION_VERSION,
      models: { ocr: this.ocr.name ?? "none", vision_provider: this.vision?.name ?? "none", vision_model: this.vision?.model ?? null, vision_calls: this.visionCalls },
      stages,
      visionLog: this.visionLog,
      warnings: this.warnings,
    };
  }

  crossReference(results: PageResult[]): OpeningRecord[] {
    const pages = new Map<number, PageContext>();
    const dims = new Map<string, DimensionAnnotation>();
    let detections: OpeningDetection[] = [];
    const orphans: [TagDetection, string][] = [];
    let schedules: ScheduleEntry[] = [];
    for (const r of results) {
      const pc: PageContext = {
        index: r.page.index,
        pageType: r.cls.pageType,
        sheetNumber: r.cls.sheetNumber,
        sheetTitle: r.cls.sheetTitle,
        floor: r.cls.floor,
        views: new Map(r.views.map((v) => [v.id, v])),
        poorQuality: r.page.quality.poor,
        qualityReasons: r.page.quality.reasons,
        label: r.page.label,
      };
      pages.set(r.page.index, pc);
      for (const d of r.dims) dims.set(d.id, d);
      detections = detections.concat(r.detections);
      for (const t of r.orphanTags) {
        const v = pc.views.get(t.viewId ?? "");
        orphans.push([t, v ? v.viewType : r.cls.pageType]);
      }
      schedules = schedules.concat(r.schedules);
    }
    return buildRecords(pages, detections, orphans, dims, schedules, this.config.thresholds);
  }
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Identify file type by magic bytes (never trust the extension alone). */

export async function openDocument(data: Uint8Array, filename: string): Promise<AnyDoc> {
  const kind = sniffType(data);
  if (kind === "application/pdf") return PdfDocument.open(data, filename);
  if (kind === "image/png" || kind === "image/jpeg") return ImageDocument.open(data, filename);
  throw new Error("Unsupported file type");
}

export async function runOnBytes(files: [string, Uint8Array][], ocr?: OCRProvider, vision?: VisionProvider | null, config?: PipelineConfig, progress?: ProgressFn): Promise<ExtractionResult> {
  const docs = files.map(([name, data], i) => ({ index: i, filename: name, data }));
  return new ExtractionPipeline(ocr, vision ?? null, config ?? defaultConfig()).run(docs, progress);
}
