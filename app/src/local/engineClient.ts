/**
 * Main-thread client of the engine worker. The worker opens drawings with
 * PDF.js, renders page images and runs the extraction pipeline, so the
 * interface stays responsive while a drawing set is analysed.
 */
import type { OpeningRecord } from "../engine/crossref";

export interface WorkerDoc {
  id: string;
  index: number;
  filename: string;
  data: Uint8Array;
  /** render page images for this document (new uploads) */
  render: boolean;
}

export interface RenderedPage {
  docId: string;
  pageInDocument: number;
  width: number;
  height: number;
  unit: "pt" | "px";
  image: Blob;
  thumb: Blob;
  imageWidth: number;
  imageHeight: number;
}

export interface AnalysedPage {
  index: number;
  docIndex: number;
  pageInDocument: number;
  width: number;
  height: number;
  unit: "pt" | "px";
  mmPerUnit: number | null;
  rotation: number;
  classification: Record<string, unknown>;
  pageType: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  floor: string | null;
  quality: Record<string, unknown>;
  scale: Record<string, unknown>;
  overlay: Record<string, unknown>;
}

export interface ProcessResult {
  rendered: RenderedPage[];
  pages: AnalysedPage[];
  records: OpeningRecord[];
  models: Record<string, unknown>;
  stages: { name: string; seconds: number }[];
  warnings: string[];
}

export interface ProcessConfig {
  thresholds: { high: number; medium: number };
  manualScales: [number, { text?: string | null; ratio: number }][];
  pageTypeOverrides: [number, string][];
  assetBase: string;
}

type Progress = (step: string, frac: number, msg: string) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  progress?: Progress;
}

class EngineClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private sentDocs = new Set<string>();

  constructor() {
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; type: "progress" | "result" | "error"; step?: string; frac?: number; msg?: string; result?: unknown; error?: string };
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") p.progress?.(m.step!, m.frac!, m.msg!);
      else {
        this.pending.delete(m.id);
        if (m.type === "result") p.resolve(m.result);
        else p.reject(new Error(m.error));
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "The analysis engine stopped unexpectedly"));
      this.pending.clear();
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: Progress): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  inspect(data: Uint8Array, filename: string): Promise<{ pageCount: number; error: string | null }> {
    return this.call({ type: "inspect", data: data.slice(), filename, assetBase: assetBase() });
  }

  process(docs: WorkerDoc[], config: ProcessConfig, progress: Progress): Promise<ProcessResult> {
    for (const d of docs) this.sentDocs.delete(d.id);
    return this.call({ type: "process", docs: docs.map((d) => ({ ...d, data: d.data.slice() })), config }, [], progress);
  }

  /** Render part of a page at high resolution (readable small text when zoomed in). */
  async renderRegion(doc: { id: string; filename: string; load: () => Promise<Uint8Array> }, pageInDocument: number, x: number, y: number, w: number, h: number, scale: number): Promise<Blob> {
    const data = this.sentDocs.has(doc.id) ? null : await doc.load();
    const blob = await this.call<Blob>({ type: "region", docId: doc.id, filename: doc.filename, data, pageInDocument, x, y, w, h, scale, assetBase: assetBase() });
    this.sentDocs.add(doc.id);
    return blob;
  }
}

let client: EngineClient | null = null;

export function engine(): EngineClient {
  if (!client) client = new EngineClient();
  return client;
}

export function assetBase(): string {
  return new URL("./", document.baseURI).href;
}
