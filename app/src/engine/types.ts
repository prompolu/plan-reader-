/**
 * Core data structures shared by all pipeline stages.
 *
 * Every page has its own coordinate space in *page units*, origin at the
 * top-left corner of the page as displayed (after rotation), y pointing down:
 * vector PDF pages use PDF points, raster images use pixels.
 * `PageData.mm_per_unit` converts page units to millimetres on paper.
 */
import { degrees, pmod, pyRound } from "./py";

export type Axis = "h" | "v";
export type Pt = [number, number];

export interface BBoxDict {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class BBox {
  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
  ) {}

  static fromPoints(x0: number, y0: number, x1: number, y1: number): BBox {
    return new BBox(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  static around(pts: readonly Pt[]): BBox {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return BBox.fromPoints(x0, y0, x1, y1);
  }

  static fromDict(d: BBoxDict): BBox {
    return new BBox(d.x, d.y, d.width, d.height);
  }

  get x0() {
    return this.x;
  }
  get y0() {
    return this.y;
  }
  get x1() {
    return this.x + this.w;
  }
  get y1() {
    return this.y + this.h;
  }
  get cx() {
    return this.x + this.w / 2;
  }
  get cy() {
    return this.y + this.h / 2;
  }
  get area() {
    return Math.max(this.w, 0) * Math.max(this.h, 0);
  }

  union(o: BBox): BBox {
    return BBox.fromPoints(Math.min(this.x0, o.x0), Math.min(this.y0, o.y0), Math.max(this.x1, o.x1), Math.max(this.y1, o.y1));
  }

  intersectionArea(o: BBox): number {
    const ix = Math.min(this.x1, o.x1) - Math.max(this.x0, o.x0);
    const iy = Math.min(this.y1, o.y1) - Math.max(this.y0, o.y0);
    if (ix <= 0 || iy <= 0) return 0;
    return ix * iy;
  }

  iou(o: BBox): number {
    const inter = this.intersectionArea(o);
    if (inter <= 0) return 0;
    return inter / (this.area + o.area - inter);
  }

  containsPoint(x: number, y: number, tol = 0): boolean {
    return this.x0 - tol <= x && x <= this.x1 + tol && this.y0 - tol <= y && y <= this.y1 + tol;
  }

  contains(o: BBox, tol = 0): boolean {
    return o.x0 >= this.x0 - tol && o.y0 >= this.y0 - tol && o.x1 <= this.x1 + tol && o.y1 <= this.y1 + tol;
  }

  expand(d: number): BBox {
    return new BBox(this.x - d, this.y - d, this.w + 2 * d, this.h + 2 * d);
  }

  distanceTo(o: BBox): number {
    const dx = Math.max(o.x0 - this.x1, this.x0 - o.x1, 0);
    const dy = Math.max(o.y0 - this.y1, this.y0 - o.y1, 0);
    return Math.hypot(dx, dy);
  }

  distanceToPoint(x: number, y: number): number {
    const dx = Math.max(this.x0 - x, 0, x - this.x1);
    const dy = Math.max(this.y0 - y, 0, y - this.y1);
    return Math.hypot(dx, dy);
  }

  toDict(nd = 2): BBoxDict {
    return { x: pyRound(this.x, nd), y: pyRound(this.y, nd), width: pyRound(this.w, nd), height: pyRound(this.h, nd) };
  }
}

export interface SegDict {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Segment {
  constructor(
    public x0: number,
    public y0: number,
    public x1: number,
    public y1: number,
    public width = 0,
    public dashed = false,
    public pathId = -1,
  ) {}

  get length() {
    return Math.hypot(this.x1 - this.x0, this.y1 - this.y0);
  }

  /** Undirected angle in degrees in [0, 180). */
  get angle() {
    const a = degrees(Math.atan2(-(this.y1 - this.y0), this.x1 - this.x0));
    return pmod(a, 180);
  }

  orientation(tolDeg = 2): Axis | null {
    const a = this.angle;
    if (a <= tolDeg || a >= 180 - tolDeg) return "h";
    if (Math.abs(a - 90) <= tolDeg) return "v";
    return null;
  }

  get mid(): Pt {
    return [(this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2];
  }

  get bbox(): BBox {
    return BBox.fromPoints(this.x0, this.y0, this.x1, this.y1);
  }

  axisRange(axis: Axis): [number, number] {
    if (axis === "h") return [Math.min(this.x0, this.x1), Math.max(this.x0, this.x1)];
    return [Math.min(this.y0, this.y1), Math.max(this.y0, this.y1)];
  }

  /** Coordinate perpendicular to `axis` (y for horizontal lines). */
  crossCoord(axis: Axis): number {
    if (axis === "h") return (this.y0 + this.y1) / 2;
    return (this.x0 + this.x1) / 2;
  }

  distanceToPoint(px: number, py: number): number {
    const dx = this.x1 - this.x0;
    const dy = this.y1 - this.y0;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - this.x0, py - this.y0);
    const t = Math.max(0, Math.min(1, ((px - this.x0) * dx + (py - this.y0) * dy) / l2));
    return Math.hypot(px - (this.x0 + t * dx), py - (this.y0 + t * dy));
  }

  /** Field equality (Python dataclass ==). */
  equals(o: Segment): boolean {
    return this.x0 === o.x0 && this.y0 === o.y0 && this.x1 === o.x1 && this.y1 === o.y1 && this.width === o.width && this.dashed === o.dashed && this.pathId === o.pathId;
  }

  toDict(): SegDict {
    return { x0: pyRound(this.x0, 2), y0: pyRound(this.y0, 2), x1: pyRound(this.x1, 2), y1: pyRound(this.y1, 2) };
  }
}

export class Arc {
  constructor(
    public cx: number,
    public cy: number,
    public r: number,
    public start: Pt,
    public end: Pt,
    public sweepDeg: number,
    public pathId = -1,
  ) {}

  get bbox(): BBox {
    const a0 = Math.atan2(this.start[1] - this.cy, this.start[0] - this.cx);
    const a1 = Math.atan2(this.end[1] - this.cy, this.end[0] - this.cx);
    const d = pmod(a1 - a0 + Math.PI, 2 * Math.PI) - Math.PI;
    const pts: Pt[] = [];
    for (let t = 0; t < 9; t++) pts.push([this.cx + this.r * Math.cos(a0 + (d * t) / 8), this.cy + this.r * Math.sin(a0 + (d * t) / 8)]);
    return BBox.around(pts);
  }
}

export class FilledShape {
  constructor(
    public points: Pt[],
    public kind: "triangle" | "dot" | "other",
  ) {}
  get bbox(): BBox {
    return BBox.around(this.points);
  }
  get center(): Pt {
    const b = this.bbox;
    return [b.cx, b.cy];
  }
}

export interface PageGeometry {
  segments: Segment[];
  arcs: Arc[];
  fills: FilledShape[];
  rects: BBox[];
  circles: [number, number, number][];
  polygons: Pt[][];
}

export function emptyGeometry(): PageGeometry {
  return { segments: [], arcs: [], fills: [], rects: [], circles: [], polygons: [] };
}

export class TextLine {
  constructor(
    public id: string,
    public text: string,
    public bbox: BBox,
    public charBoxes: BBox[],
    /** reading direction, degrees counter-clockwise from +x (visual) */
    public angle: number,
    /** text height in page units */
    public size: number,
    public source: "pdf" | "ocr" = "pdf",
    public confidence = 1,
  ) {}

  subBBox(start: number, end: number): BBox {
    const boxes = this.charBoxes.slice(start, end).filter((b) => b.w > 0 || b.h > 0);
    if (!boxes.length) return this.bbox;
    let out = boxes[0];
    for (const b of boxes.slice(1)) out = out.union(b);
    return out;
  }

  get axis(): Axis | null {
    const a = pmod(this.angle, 180);
    if (a < 10 || a > 170) return "h";
    if (Math.abs(a - 90) < 10) return "v";
    return null;
  }

  toDict() {
    return { id: this.id, text: this.text, bbox: this.bbox.toDict(), angle: pyRound(this.angle, 1), size: pyRound(this.size, 2), source: this.source, confidence: pyRound(this.confidence, 3) };
  }
}

export interface PageQuality {
  kind: "vector" | "raster" | "vector_outlined_text";
  effective_dpi: number | null;
  blur_score: number | null;
  contrast: number | null;
  mean_ocr_confidence: number | null;
  poor: boolean;
  reasons: string[];
}

export function newQuality(kind: PageQuality["kind"], effectiveDpi: number | null = null): PageQuality {
  return { kind, effective_dpi: effectiveDpi, blur_score: null, contrast: null, mean_ocr_confidence: null, poor: false, reasons: [] };
}

export interface PageData {
  index: number;
  documentIndex: number;
  pageInDocument: number;
  width: number;
  height: number;
  unit: "pt" | "px";
  mmPerUnit: number | null;
  rotation: number;
  lines: TextLine[];
  geometry: PageGeometry;
  quality: PageQuality;
  hasTextLayer: boolean;
  label: string;
}

export class ScaleInfo {
  constructor(
    public text: string | null,
    public ratio: number | null,
    public source: "detected" | "calibrated" | "manual" | "none",
    public confidence: number,
    public bbox: BBox | null = null,
    public notToScale = false,
    public notes: string[] = [],
  ) {}

  toDict() {
    return {
      text: this.text,
      ratio: this.ratio,
      source: this.source,
      confidence: pyRound(this.confidence, 3),
      bbox: this.bbox ? this.bbox.toDict() : null,
      not_to_scale: this.notToScale,
      notes: this.notes,
    };
  }
}

export const PAGE_TYPES = ["floor_plan", "elevation", "section", "door_schedule", "window_schedule", "opening_schedule", "detail", "site_plan", "cover", "notes", "other"] as const;

export const PAGE_TYPE_LABELS: Record<string, string> = {
  floor_plan: "Floor plan",
  elevation: "Elevation",
  section: "Section",
  door_schedule: "Door schedule",
  window_schedule: "Window schedule",
  opening_schedule: "Opening schedule",
  detail: "Detail",
  site_plan: "Site plan",
  cover: "Cover page",
  notes: "Notes/specifications",
  other: "Other",
};

export const SCHEDULE_TYPES = new Set(["door_schedule", "window_schedule", "opening_schedule"]);

export class View {
  constructor(
    public id: string,
    public bbox: BBox,
    public viewType: string,
    public title: string | null,
    public titleBBox: BBox | null,
    public scale: ScaleInfo,
    public enlarged = false,
  ) {}

  toDict() {
    return {
      id: this.id,
      bbox: this.bbox.toDict(),
      view_type: this.viewType,
      title: this.title,
      title_bbox: this.titleBBox ? this.titleBBox.toDict() : null,
      scale: this.scale.toDict(),
      enlarged: this.enlarged,
    };
  }
}

export interface Signal {
  type: string;
  weight: number;
  code: string;
  detail: string;
}

export interface PageClassification {
  pageType: string;
  confidence: number;
  signals: Signal[];
  secondaryTypes: string[];
  sheetNumber: string | null;
  sheetTitle: string | null;
  floor: string | null;
  titleBlock: BBox | null;
  defaultUnit: string;
  unitBasis: string;
  /** Language of the drawing's text: decides what some tag prefixes mean (GD: garage door / garde-corps). */
  language?: "en" | "fr" | "es";
}

export function classificationToDict(c: PageClassification) {
  return {
    page_type: c.pageType,
    confidence: pyRound(c.confidence, 3),
    signals: c.signals,
    secondary_types: c.secondaryTypes,
    sheet_number: c.sheetNumber,
    sheet_title: c.sheetTitle,
    floor: c.floor,
    title_block: c.titleBlock ? c.titleBlock.toDict() : null,
    default_unit: c.defaultUnit,
    unit_basis: c.unitBasis,
  };
}

export interface TagDetection {
  id: string;
  pageIndex: number;
  /** as written, e.g. "W-03" */
  text: string;
  /** normalised, e.g. "W3" */
  key: string;
  prefix: string;
  bbox: BBox;
  confidence: number;
  enclosure: "circle" | "polygon" | "rect" | null;
  lineId: string;
  viewId: string | null;
  enclosureBBox: BBox | null;
  /** where the tag's leader line (a thin line drawn from the tag to its element) ends */
  leaderTo?: Pt | null;
}

export function tagToDict(t: TagDetection) {
  return {
    id: t.id,
    page_index: t.pageIndex,
    text: t.text,
    key: t.key,
    prefix: t.prefix,
    bbox: t.bbox.toDict(),
    confidence: pyRound(t.confidence, 3),
    enclosure: t.enclosure,
    view_id: t.viewId,
    ...(t.leaderTo ? { leader_to: [pyRound(t.leaderTo[0], 2), pyRound(t.leaderTo[1], 2)] } : {}),
  };
}

export interface Terminator {
  pos: number;
  kind: string;
}

export interface ScaleCheck {
  scale_ratio: number;
  drawn_length_mm: number;
  relative_error: number;
  consistent: boolean;
}

export interface DimensionAnnotation {
  id: string;
  pageIndex: number;
  /** original text exactly as detected */
  text: string;
  valueMm: number;
  unit: string;
  unitExplicit: boolean;
  unitBasis: string;
  textBBox: BBox;
  textAngle: number;
  kind: "linear" | "callout";
  confidence: number;
  source: "pdf" | "ocr";
  axis: Axis | null;
  span: [number, number] | null;
  linePos: number | null;
  line: Segment | null;
  terminators: Terminator[];
  extensionLines: Segment[];
  chainId: string | null;
  chainSize: number;
  scaleCheck: ScaleCheck | null;
  viewId: string | null;
  pairRole: "width" | "height" | null;
  pairId: string | null;
  notes: string[];
}

export function newDimension(p: Pick<DimensionAnnotation, "id" | "pageIndex" | "text" | "valueMm" | "unit" | "unitExplicit" | "unitBasis" | "textBBox" | "textAngle" | "kind" | "confidence" | "source" | "viewId"> & Partial<DimensionAnnotation>): DimensionAnnotation {
  return {
    axis: null,
    span: null,
    linePos: null,
    line: null,
    terminators: [],
    extensionLines: [],
    chainId: null,
    chainSize: 1,
    scaleCheck: null,
    pairRole: null,
    pairId: null,
    notes: [],
    ...p,
  };
}

export function dimensionToDict(d: DimensionAnnotation) {
  return {
    id: d.id,
    page_index: d.pageIndex,
    text: d.text,
    value_mm: pyRound(d.valueMm, 2),
    unit: d.unit,
    unit_explicit: d.unitExplicit,
    unit_basis: d.unitBasis,
    text_bbox: d.textBBox.toDict(),
    text_angle: pyRound(d.textAngle, 1),
    kind: d.kind,
    confidence: pyRound(d.confidence, 3),
    source: d.source,
    axis: d.axis,
    span: d.span ? [pyRound(d.span[0], 2), pyRound(d.span[1], 2)] : null,
    line_pos: d.linePos !== null ? pyRound(d.linePos, 2) : null,
    line: d.line ? d.line.toDict() : null,
    terminators: d.terminators,
    extension_lines: d.extensionLines.map((s) => s.toDict()),
    chain_id: d.chainId,
    chain_size: d.chainSize,
    scale_check: d.scaleCheck,
    view_id: d.viewId,
    pair_role: d.pairRole,
    pair_id: d.pairId,
    notes: d.notes,
  };
}

export const OPENING_TYPES = ["door", "double_door", "sliding_door", "window", "sliding_window", "garage_door", "curtain_wall", "opening", "other"] as const;

export const OPENING_TYPE_LABELS: Record<string, string> = {
  door: "Door",
  double_door: "Double door",
  sliding_door: "Sliding door",
  window: "Window",
  sliding_window: "Sliding window",
  garage_door: "Garage door",
  curtain_wall: "Curtain wall",
  railing: "Railing",
  opening: "Opening",
  other: "Other",
};

export interface Evidence {
  code: string;
  label: string;
  passed: boolean | null;
  detail: string | null;
  score: number | null;
  page_index: number | null;
  bbox: BBoxDict | null;
  target: string | null;
}

export function evidence(
  code: string,
  label: string,
  passed: boolean | null,
  opts: { detail?: string | null; score?: number | null; pageIndex?: number | null; bbox?: BBox | null; target?: string | null } = {},
): Evidence {
  return {
    code,
    label,
    passed,
    detail: opts.detail ?? null,
    score: opts.score !== undefined && opts.score !== null ? pyRound(opts.score, 3) : null,
    page_index: opts.pageIndex ?? null,
    bbox: opts.bbox ? opts.bbox.toDict() : null,
    target: opts.target ?? null,
  };
}

export interface Association {
  dimensionId: string;
  role: "width" | "height";
  score: number;
  signals: Evidence[];
  /** other opening ids sharing a level dimension */
  sharedWith: string[];
}

export interface OpeningDetection {
  id: string;
  pageIndex: number;
  viewId: string | null;
  viewType: string;
  kind: string;
  bbox: BBox;
  /** axis along which the width is measured */
  axis: Axis;
  /** width edges along `axis` */
  edges: [number, number];
  /** extent perpendicular to `axis` (wall faces / top-bottom) */
  cross: [number, number];
  detector: string;
  confidence: number;
  evidence: Evidence[];
  features: Record<string, unknown>;
  tag: TagDetection | null;
  tagScore: number;
  tagEvidence: Evidence[];
  widthAssoc: Association | null;
  heightAssoc: Association | null;
  candidateAssocs: Association[];
  room: string | null;
}

export function newDetection(p: Pick<OpeningDetection, "id" | "pageIndex" | "viewId" | "viewType" | "kind" | "bbox" | "axis" | "edges" | "cross" | "detector" | "confidence"> & Partial<OpeningDetection>): OpeningDetection {
  return {
    evidence: [],
    features: {},
    tag: null,
    tagScore: 0,
    tagEvidence: [],
    widthAssoc: null,
    heightAssoc: null,
    candidateAssocs: [],
    room: null,
    ...p,
  };
}

function assocDict(a: Association | null) {
  if (!a) return null;
  return { dimension_id: a.dimensionId, role: a.role, score: pyRound(a.score, 3), signals: a.signals, shared_with: a.sharedWith };
}

export function detectionToDict(d: OpeningDetection) {
  return {
    id: d.id,
    page_index: d.pageIndex,
    view_id: d.viewId,
    view_type: d.viewType,
    kind: d.kind,
    bbox: d.bbox.toDict(),
    axis: d.axis,
    edges: [pyRound(d.edges[0], 2), pyRound(d.edges[1], 2)],
    cross: [pyRound(d.cross[0], 2), pyRound(d.cross[1], 2)],
    detector: d.detector,
    confidence: pyRound(d.confidence, 3),
    evidence: d.evidence,
    features: d.features,
    tag: d.tag ? tagToDict(d.tag) : null,
    tag_score: pyRound(d.tagScore, 3),
    room: d.room,
    width_assoc: assocDict(d.widthAssoc),
    height_assoc: assocDict(d.heightAssoc),
  };
}

export interface ParsedMeasurement {
  value_mm: number;
  unit: string;
  unit_explicit: boolean;
  system: string;
  original_text: string;
}

export interface ScheduleEntry {
  id: string;
  pageIndex: number;
  scheduleKind: "door" | "window" | "opening";
  scheduleTitle: string;
  tag: string;
  tagKey: string;
  typeText: string | null;
  width: ParsedMeasurement | null;
  height: ParsedMeasurement | null;
  quantity: number | null;
  quantityText: string | null;
  remarks: string | null;
  rowBBox: BBox;
  cells: Record<string, string>;
  confidence: number;
}

export function scheduleToDict(s: ScheduleEntry) {
  return {
    id: s.id,
    page_index: s.pageIndex,
    schedule_kind: s.scheduleKind,
    schedule_title: s.scheduleTitle,
    tag: s.tag,
    tag_key: s.tagKey,
    type_text: s.typeText,
    width: s.width,
    height: s.height,
    quantity: s.quantity,
    quantity_text: s.quantityText,
    remarks: s.remarks,
    row_bbox: s.rowBBox.toDict(),
    cells: s.cells,
    confidence: pyRound(s.confidence, 3),
  };
}
