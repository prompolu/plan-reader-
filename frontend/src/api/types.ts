export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  preferences: { display_unit?: DisplayUnit; thresholds?: Thresholds };
  workspace?: boolean;
}

export type DisplayUnit = "original" | "mm" | "cm" | "m" | "ft_in";

export interface Thresholds {
  high: number;
  medium: number;
}

export interface JobStep {
  label: string;
  status: "pending" | "running" | "done";
  detail: string | null;
}

export interface Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  step: string | null;
  steps: Record<string, JobStep>;
  message: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  run_id: string | null;
}

export interface ProjectInfo {
  project_name?: string | null;
  drawing_set_name?: string | null;
  project_address?: string | null;
  prepared_by?: string | null;
  date?: string | null;
  notes?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  info: ProjectInfo;
  settings: { thresholds: Thresholds; display_unit: DisplayUnit; default_unit: string };
  is_demo: boolean;
  role: "owner" | "editor" | "viewer" | null;
  created_at: string;
  updated_at: string | null;
  last_processed_at: string | null;
  current_run_id: string | null;
  stats?: {
    pages: number;
    opening_types: number;
    openings: number;
    needs_review: number;
    verified: number;
    documents: number;
    job: Job | null;
  };
}

export interface DocumentInfo {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  page_count: number;
  status: string;
  error: string | null;
  created_at: string;
}

export interface ScaleInfo {
  text: string | null;
  ratio: number | null;
  source: "detected" | "calibrated" | "manual" | "none";
  confidence: number;
  not_to_scale: boolean;
  notes: string[];
}

export interface PageInfo {
  id: string;
  document_id: string;
  document: string | null;
  page_index: number;
  page: number;
  page_in_document: number;
  width: number;
  height: number;
  unit: "pt" | "px";
  mm_per_unit: number | null;
  rotation: number;
  image_url: string | null;
  thumb_url: string | null;
  image_width: number | null;
  image_height: number | null;
  region_token: string;
  page_type: string | null;
  page_type_detected: string | null;
  page_type_override: string | null;
  page_type_label: string;
  classification_confidence: number | null;
  classification_signals: { type: string; weight: number; code: string; detail: string }[];
  secondary_types: string[];
  sheet_number: string | null;
  sheet_title: string | null;
  floor: string | null;
  scale: { primary?: ScaleInfo | null; views?: { id: string; title: string | null; view_type: string; scale: ScaleInfo }[] };
  scale_override: { text: string; ratio: number } | null;
  quality: { kind?: string; poor?: boolean; reasons?: string[]; effective_dpi?: number | null; mean_ocr_confidence?: number | null };
  analysed: boolean;
}

export interface OverlayDim {
  id: string;
  text: string;
  value_mm: number;
  kind: string;
  axis: "h" | "v" | null;
  text_bbox: BBox;
  line: Seg | null;
  extension_lines: Seg[];
  chain_id: string | null;
}

export interface Overlay {
  views: { id: string; bbox: BBox; view_type: string; title: string | null }[];
  dimensions: OverlayDim[];
  tags: { id: string; text: string; bbox: BBox }[];
  detections: { id: string; kind: string; bbox: BBox; tag: string | null; confidence: number; view_type: string }[];
  schedule_rows: { id: string; tag: string; row_bbox: BBox }[];
  text: { id: string; text: string; bbox: BBox }[];
}

export interface Evidence {
  code: string;
  label: string;
  passed: boolean | null;
  detail: string | null;
  score: number | null;
  page_index: number | null;
  bbox: BBox | null;
  target: string | null;
}

export interface Candidate {
  value: number;
  unit: string;
  original_text: string;
  source: string;
  label: string;
  confidence: number;
  page_index: number;
  sheet: string;
  bbox: BBox | null;
  dimension_id: string | null;
}

export interface Measurement {
  value: number | null;
  unit: string;
  original_text: string | null;
  source: "explicit_dimension" | "callout" | "schedule" | "drawing_scale" | "user" | "conflict";
  status: "explicit" | "inferred" | "user" | "conflict";
  confidence: number;
  page_index: number | null;
  sheet?: string;
  bbox: BBox | null;
  dimension_id?: string | null;
  line?: Seg | null;
  extension_lines?: Seg[];
  unit_basis?: string;
  view_type?: string;
  view_title?: string | null;
  evidence: Evidence[];
  candidates?: Candidate[];
  previous?: MeasurementSummary | null;
}

export interface MeasurementSummary {
  value: number | null;
  unit: string;
  original_text: string | null;
  source: string;
  status: string;
  confidence: number;
}

export interface Flag {
  code: string;
  severity: "info" | "warning" | "error";
  label: string;
  message: string;
  field?: string;
  page_index?: number;
}

export interface Instance {
  detection_id: string | null;
  page_index: number;
  sheet: string | null;
  floor?: string | null;
  room?: string | null;
  view_type?: string;
  view_title?: string | null;
  bbox: BBox;
  kind: string;
  confidence: number;
  tag_text: string | null;
  tag_bbox?: BBox | null;
  width_text?: string | null;
  counted: boolean;
  note?: string | null;
  geometry_missing?: boolean;
}

export interface Opening {
  id: string;
  ref: string;
  type: string;
  type_label: string;
  tag: string | null;
  tag_key: string | null;
  width: Measurement | null;
  height: Measurement | null;
  quantity: number | null;
  quantity_basis: string | null;
  page_id: string | null;
  page_index: number | null;
  page: number | null;
  drawing_reference: string | null;
  bbox: BBox | null;
  floor: string | null;
  room: string | null;
  status: "extracted" | "needs_review" | "verified";
  source: "ai" | "user";
  confidence: { detection?: number | null; tag?: number | null; width?: number | null; height?: number | null; association?: number | null; overall?: number | null };
  flags: Flag[];
  evidence: Evidence[];
  instances: Instance[];
  references: Instance[];
  schedule: Record<string, unknown> | null;
  notes: string;
  edited_fields: string[];
  ai_original: { type: string; tag: string | null; width: MeasurementSummary | null; height: MeasurementSummary | null; quantity: number | null } | null;
  pending_ai: { type: string; tag: string | null; width: MeasurementSummary | null; height: MeasurementSummary | null; quantity: number | null } | null;
  verification: { verified: boolean; verified_by_user: boolean; verified_by: string | null; verified_at: string | null };
  version: number;
}

export interface AuditEvent {
  id: number;
  opening_id: string | null;
  opening_ref: string | null;
  actor: "ai" | "user" | "system";
  user: string | null;
  action: string;
  field: string | null;
  message: string;
  created_at: string;
}

export interface ReviewItem extends Flag {
  opening_id: string;
  ref: string;
  tag: string | null;
  type: string;
}

export interface ScheduleRow {
  id: string;
  ref: string;
  tag: string;
  type: string;
  type_label: string;
  width: string;
  height: string;
  width_status: string;
  height_status: string;
  quantity: number;
  drawing_reference: string;
  floor: string;
  room: string;
  status: string;
  verified: boolean;
  notes: string;
  open_flags: string[];
}

export interface Schedule {
  group_by: string;
  unit: string;
  groups: { key: string; title: string; rows: ScheduleRow[]; total_quantity: number }[];
  total_openings: number;
  unverified_count: number;
  needs_review_count: number;
  has_inferred: boolean;
}

export interface Run {
  id: string;
  version: string;
  models: { ocr?: string; vision_provider?: string; vision_model?: string | null; vision_calls?: number };
  status: string;
  trigger: string;
  stats: { pages?: number; records?: number; physical_openings?: number; needs_review?: number; merge?: Record<string, number> };
  warnings: string[];
  started_at: string;
  finished_at: string | null;
  current: boolean;
}

export interface SystemInfo {
  app_version: string;
  extraction_version: string;
  ocr: { provider: string; available: boolean; version: string | null };
  vision: { provider: string; model: string | null; configured: boolean; used_for: string };
  limits: { max_upload_mb: number; max_pages_per_document: number; max_files_per_upload: number };
  opening_types: Record<string, string>;
  page_types: Record<string, string>;
  storage: string;
}
