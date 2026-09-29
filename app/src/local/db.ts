/**
 * On-device storage (IndexedDB). Everything - projects, the uploaded drawings,
 * rendered pages, extraction results, edits and the audit trail - stays in
 * this browser / app profile. Nothing is sent to a server.
 */
import { openDB, type DBSchema, type IDBPDatabase, type StoreValue } from "idb";
import type { BBoxDict } from "../engine/types";
import type { Flag } from "../engine/confidence";
import type { Evidence } from "../engine/types";

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  info: Record<string, string | null>;
  settings: { thresholds: { high: number; medium: number }; display_unit: string; default_unit: string };
  is_demo: boolean;
  current_run_id: string | null;
  last_processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  project_id: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  page_count: number;
  status: "uploaded" | "rendered" | "processed" | "failed";
  error: string | null;
  created_at: string;
}

export interface PageRow {
  id: string;
  project_id: string;
  document_id: string;
  page_index: number;
  page_in_document: number;
  width: number;
  height: number;
  unit: "pt" | "px";
  mm_per_unit: number | null;
  rotation: number;
  image_width: number | null;
  image_height: number | null;
  has_image: boolean;
  page_type: string | null;
  page_type_override: string | null;
  classification: Record<string, unknown>;
  sheet_number: string | null;
  sheet_title: string | null;
  floor: string | null;
  scale: Record<string, unknown>;
  scale_override: { text: string; ratio: number } | null;
  quality: Record<string, unknown>;
  analysed: boolean;
  run_id: string | null;
  created_at: string;
}

export interface MeasurementRow {
  value: number | null;
  unit: string;
  original_text: string | null;
  source: string;
  status: string;
  confidence: number;
  page_index?: number | null;
  bbox?: BBoxDict | null;
  evidence?: Evidence[];
  candidates?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface OpeningRow {
  id: string;
  project_id: string;
  run_id: string | null;
  ref: string;
  type: string;
  tag: string | null;
  tag_key: string | null;
  width: MeasurementRow | null;
  height: MeasurementRow | null;
  quantity: number | null;
  quantity_basis: string | null;
  page_id: string | null;
  page_index: number | null;
  drawing_reference: string | null;
  bbox: BBoxDict | null;
  floor: string | null;
  room: string | null;
  status: "extracted" | "needs_review" | "verified";
  source: "ai" | "user";
  confidence: Record<string, number | null>;
  flags: Flag[];
  evidence: Evidence[];
  instances: Record<string, unknown>[];
  references: Record<string, unknown>[];
  schedule: Record<string, unknown> | null;
  source_detections: string[];
  notes: string;
  edited_fields: string[];
  ai_snapshot: Record<string, unknown> | null;
  pending_ai: Record<string, unknown> | null;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  sort_index: number;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  version: string;
  models: Record<string, unknown>;
  status: "running" | "succeeded" | "failed";
  trigger: string;
  stats: Record<string, unknown>;
  warnings: string[];
  started_at: string;
  finished_at: string | null;
}

export interface JobRow {
  id: string;
  project_id: string;
  run_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  step: string | null;
  steps: Record<string, { label: string; status: "pending" | "running" | "done"; detail: string | null }>;
  message: string | null;
  error: string | null;
  trigger: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AuditRow {
  id?: number;
  project_id: string;
  opening_id: string | null;
  opening_ref: string | null;
  actor: "ai" | "user" | "system";
  user: string | null;
  action: string;
  field: string | null;
  old_value: unknown;
  new_value: unknown;
  message: string;
  created_at: string;
}

interface Schema extends DBSchema {
  projects: { key: string; value: ProjectRow };
  documents: { key: string; value: DocumentRow; indexes: { project: string } };
  /** original uploaded files, keyed by document id */
  files: { key: string; value: Blob };
  pages: { key: string; value: PageRow; indexes: { project: string; document: string } };
  /** rendered page images and thumbnails, keyed "<page id>:image" / "<page id>:thumb" */
  images: { key: string; value: Blob };
  /** per-page overlay data for the viewer (dimensions, tags, detections, text) */
  overlays: { key: string; value: Record<string, unknown> };
  openings: { key: string; value: OpeningRow; indexes: { project: string } };
  runs: { key: string; value: RunRow; indexes: { project: string } };
  jobs: { key: string; value: JobRow; indexes: { project: string } };
  audit: { key: number; value: AuditRow; indexes: { project: string; opening: string } };
  meta: { key: string; value: unknown };
}

export type DB = IDBPDatabase<Schema>;

let dbPromise: Promise<DB> | null = null;

export function db(): Promise<DB> {
  if (!dbPromise) {
    dbPromise = openDB<Schema>("planmeasure", 1, {
      upgrade(d) {
        d.createObjectStore("projects", { keyPath: "id" });
        d.createObjectStore("documents", { keyPath: "id" }).createIndex("project", "project_id");
        d.createObjectStore("files");
        const pages = d.createObjectStore("pages", { keyPath: "id" });
        pages.createIndex("project", "project_id");
        pages.createIndex("document", "document_id");
        d.createObjectStore("images");
        d.createObjectStore("overlays");
        d.createObjectStore("openings", { keyPath: "id" }).createIndex("project", "project_id");
        d.createObjectStore("runs", { keyPath: "id" }).createIndex("project", "project_id");
        d.createObjectStore("jobs", { keyPath: "id" }).createIndex("project", "project_id");
        const audit = d.createObjectStore("audit", { keyPath: "id", autoIncrement: true });
        audit.createIndex("project", "project_id");
        audit.createIndex("opening", "opening_id");
        d.createObjectStore("meta");
      },
    });
  }
  return dbPromise;
}

/** For tests: forget the open connection (a fresh fake IndexedDB can then be installed). */
export function resetDbForTests(): void {
  dbPromise = null;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function byProject<S extends "documents" | "pages" | "openings" | "runs" | "jobs" | "audit">(store: S, projectId: string): Promise<StoreValue<Schema, S>[]> {
  return (await db()).getAllFromIndex(store, "project" as never, projectId as never) as Promise<StoreValue<Schema, S>[]>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
