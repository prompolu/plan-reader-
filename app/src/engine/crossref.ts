/**
 * Cross-referencing across the drawing set.
 *
 * - groups appearances of the same tag into one opening *type* record
 * - counts physical *instances* from floor plans only; elevations, sections,
 *   enlarged plans and schedules are *references* and are never counted again
 * - reconciles sizes from dimensions, callouts and schedules; disagreements are
 *   reported as conflicts and never resolved automatically
 * - detects duplicates (duplicate sheets, doubled tags, overlapping detections)
 */
import { flag, needsReview, overall, type Flag, type Thresholds } from "./confidence";
import { scheduleTypeKind } from "./schedules";
import { tagClass } from "./tags";
import { BBox, OPENING_TYPE_LABELS, PAGE_TYPE_LABELS, evidence, scheduleToDict, type BBoxDict, type DimensionAnnotation, type Evidence, type OpeningDetection, type ScheduleEntry, type SegDict, type TagDetection, type View } from "./types";
import { approxEqualMm, formatLength } from "./units";
import { cmpTuple, maxBy, pyPercent, pyRound, pyTitle, sortedBy, sortedStrings, type Tuple } from "./py";

const KIND_ORDER = ["window", "sliding_window", "curtain_wall", "door", "double_door", "sliding_door", "garage_door", "railing", "opening", "other"];

export interface PageContext {
  index: number;
  pageType: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  floor: string | null;
  views: Map<string, View>;
  poorQuality: boolean;
  qualityReasons: string[];
  label: string;
  language?: string;
}

export function pageRef(p: PageContext): string {
  return p.sheetNumber || `Page ${p.index + 1}`;
}

interface Appearance {
  det: OpeningDetection;
  page: PageContext;
  view: View | null;
  counted: boolean;
  role: "instance" | "reference";
  note: string | null;
}

export interface MeasCandidate {
  value: number;
  unit: string;
  original_text: string | null;
  source: string;
  confidence: number;
  page_index: number;
  sheet: string;
  view_type: string;
  view_title: string | null;
  bbox: BBoxDict | null;
  dimension_id: string | null;
  line: SegDict | null;
  extension_lines: SegDict[];
  unit_basis: string;
  evidence: Evidence[];
  role: string;
  chain_id?: string | null;
  shared_with?: string[];
}

export interface CandSummary {
  value: number;
  unit: string;
  original_text: string | null;
  source: string;
  label: string;
  confidence: number;
  page_index: number;
  sheet: string;
  bbox: BBoxDict | null;
  dimension_id: string | null;
}

export interface MeasurementRecord {
  value: number | null;
  unit: string;
  original_text: string | null;
  source: string;
  status: "explicit" | "inferred" | "user" | "conflict";
  confidence: number;
  page_index: number | null;
  sheet?: string;
  bbox: BBoxDict | null;
  dimension_id?: string | null;
  line?: SegDict | null;
  extension_lines?: SegDict[];
  unit_basis?: string;
  view_type?: string;
  view_title?: string | null;
  evidence: Evidence[];
  candidates?: CandSummary[];
  [k: string]: unknown;
}

export interface InstanceOut {
  detection_id: string | null;
  page_index: number;
  sheet: string | null;
  floor?: string | null;
  room?: string | null;
  view_type?: string;
  view_title?: string | null;
  bbox: BBoxDict;
  kind: string;
  confidence: number;
  tag_text: string | null;
  tag_bbox?: BBoxDict | null;
  width_text?: string | null;
  counted: boolean;
  note?: string | null;
  geometry_missing?: boolean;
}

export interface OpeningRecord {
  ref: string;
  type: string;
  tag: string | null;
  tag_key: string | null;
  width: MeasurementRecord | null;
  height: MeasurementRecord | null;
  quantity: number;
  quantity_basis: string;
  page_index: number | null;
  drawing_reference: string | null;
  bbox: BBoxDict | null;
  floor: string | null;
  room: string | null;
  status: "needs_review" | "extracted";
  flags: Flag[];
  evidence: Evidence[];
  confidence: Record<string, number | null>;
  instances: InstanceOut[];
  references: InstanceOut[];
  schedule: ReturnType<typeof scheduleToDict> | null;
  source_detections: string[];
  source: "ai";
}

function natural(tag: string | null): Tuple {
  if (!tag) return ["~", 10 ** 9, ""];
  const m = /^([A-Z]+)\D*(\d+)(.*)/.exec(tag.toUpperCase());
  if (!m) return [tag, 0, ""];
  return [m[1], parseInt(m[2], 10), m[3]];
}

function measCandidate(d: DimensionAnnotation, score: number, signals: Evidence[], app: Appearance, role: string): MeasCandidate {
  return {
    value: d.valueMm,
    unit: d.unit,
    original_text: d.text,
    source: d.kind === "linear" ? "explicit_dimension" : "callout",
    confidence: pyRound(Math.min(0.99, score), 3),
    page_index: d.pageIndex,
    sheet: pageRef(app.page),
    view_type: app.view ? app.view.viewType : app.page.pageType,
    view_title: app.view ? app.view.title : null,
    bbox: d.textBBox.toDict(),
    dimension_id: d.id,
    line: d.line ? d.line.toDict() : null,
    extension_lines: d.extensionLines.map((s) => s.toDict()),
    unit_basis: d.unitBasis,
    evidence: signals,
    role,
    chain_id: d.chainId,
  };
}

function scheduleCandidate(e: ScheduleEntry, which: "width" | "height", page: PageContext): MeasCandidate | null {
  const m = which === "width" ? e.width : e.height;
  if (!m) return null;
  return {
    value: m.value_mm,
    unit: m.unit,
    original_text: m.original_text,
    source: "schedule",
    confidence: pyRound(e.confidence * 0.97, 3),
    page_index: e.pageIndex,
    sheet: pageRef(page),
    view_type: "schedule",
    view_title: e.scheduleTitle,
    bbox: e.rowBBox.toDict(),
    dimension_id: null,
    line: null,
    extension_lines: [],
    unit_basis: m.unit_explicit ? "explicit" : "schedule",
    evidence: [evidence("schedule_row", `${pyTitle(e.scheduleTitle)} row ${e.tag}: ${which} ${m.original_text}`, true, { pageIndex: e.pageIndex, bbox: e.rowBBox, target: e.id })],
    role: which,
  };
}

function sourceLabel(c: { source: string; view_title?: string | null; view_type?: string | null; sheet: string }): string {
  if (c.source === "schedule") return pyTitle(c.view_title || "Schedule");
  // e.g. "West Elevation A-202" - distinguishes several views on one sheet
  if (c.view_title) return `${pyTitle(c.view_title)} ${c.sheet}`;
  const vt = PAGE_TYPE_LABELS[c.view_type ?? ""] ?? "Drawing";
  return `${vt} ${c.sheet}`;
}

function candSummary(c: MeasCandidate): CandSummary {
  return {
    value: c.value,
    unit: c.unit,
    original_text: c.original_text,
    source: c.source,
    label: sourceLabel(c),
    confidence: c.confidence,
    page_index: c.page_index,
    sheet: c.sheet,
    bbox: c.bbox ?? null,
    dimension_id: c.dimension_id ?? null,
  };
}

/** Combine candidate values for one measurement. Returns [measurement, flags]. */
export function reconcile(cands: MeasCandidate[], which: "width" | "height"): [MeasurementRecord | null, Flag[]] {
  const flags: Flag[] = [];
  if (!cands.length) return [null, flags];
  const clusters: MeasCandidate[][] = [];
  for (const c of sortedBy(cands, (c) => -c.confidence)) {
    const cl = clusters.find((cl) => approxEqualMm(cl[0].value, c.value));
    if (cl) cl.push(c);
    else clusters.push([c]);
  }
  const whichT = pyTitle(which);
  if (clusters.length === 1) {
    const cl = clusters[0];
    const nonSched = cl.filter((c) => c.source !== "schedule");
    const primary = nonSched.length ? maxBy(nonSched, (c) => c.confidence) : cl[0];
    // independent sources agreeing raise confidence (noisy-OR over source kinds)
    const bestByKind = new Map<string, number>();
    for (const c of cl) bestByKind.set(c.source, Math.max(bestByKind.get(c.source) ?? 0, c.confidence));
    let miss = 1;
    for (const v of bestByKind.values()) miss *= 1 - v;
    const pages = new Set(cl.map((c) => c.page_index));
    const conf = 1 - miss + 0.01 * Math.min(pages.size - 1, 2);
    const ev = [...primary.evidence];
    for (const c of cl) {
      if (c === primary) continue;
      ev.push(evidence("corroborated", `Confirmed by ${sourceLabel(c)}: ${c.original_text}`, true, { pageIndex: c.page_index, bbox: c.bbox ? BBox.fromDict(c.bbox) : null, target: c.dimension_id }));
    }
    const m: MeasurementRecord = {
      value: primary.value,
      unit: primary.unit,
      original_text: primary.original_text,
      source: primary.source,
      page_index: primary.page_index,
      sheet: primary.sheet,
      bbox: primary.bbox,
      dimension_id: primary.dimension_id,
      line: primary.line,
      extension_lines: primary.extension_lines,
      unit_basis: primary.unit_basis,
      view_type: primary.view_type,
      view_title: primary.view_title,
      status: "explicit",
      confidence: pyRound(Math.min(conf, 0.99), 3),
      evidence: ev,
      candidates: cl.map(candSummary),
    };
    if (primary.unit_basis === "assumed" && !cl.some((c) => ["explicit", "note", "scale"].includes(c.unit_basis))) {
      flags.push(flag("unit_assumed", `${whichT} ${primary.original_text} has no unit and no unit note was found; millimetres assumed`, { field: which }));
    }
    return [m, flags];
  }
  // conflict: show every source, decide nothing
  const summ = clusters.flatMap((cl) => cl.map(candSummary));
  const hasSched = clusters.some((cl) => cl.some((c) => c.source === "schedule"));
  const parts = clusters.map((cl) => `${sortedStrings(new Set(cl.map(sourceLabel))).join(", ")}: ${cl[0].original_text}`);
  const msg = `${whichT} conflict - ` + parts.join(" vs ");
  flags.push(flag(hasSched ? "schedule_conflict" : "dimension_conflict", msg, { field: which, values: clusters.map((cl) => cl[0].value) }));
  const f = clusters[0][0];
  const m: MeasurementRecord = {
    value: null,
    unit: f.unit,
    original_text: null,
    source: "conflict",
    status: "conflict",
    confidence: 0,
    page_index: f.page_index,
    sheet: f.sheet,
    bbox: f.bbox,
    dimension_id: f.dimension_id,
    line: f.line,
    extension_lines: f.extension_lines,
    unit_basis: f.unit_basis,
    evidence: clusters.map((cl) => evidence("conflict", `${sourceLabel(cl[0])} says ${cl[0].original_text}`, false, { pageIndex: cl[0].page_index, bbox: cl[0].bbox ? BBox.fromDict(cl[0].bbox) : null, target: cl[0].dimension_id })),
    candidates: summ,
  };
  return [m, flags];
}

function inferred(apps: Appearance[], which: "width" | "height"): MeasurementRecord | null {
  const key = which === "width" ? "inferred_width_mm" : "inferred_height_mm";
  let vals = apps.filter((a) => a.det.features[key]).map((a) => [a, a.det.features[key] as number] as const);
  if (!vals.length) return null;
  // prefer floor-plan instances for widths
  vals = sortedBy(vals, (t) => [t[0].role !== "instance" ? 1 : 0, -t[0].det.confidence]);
  const [a, v] = vals[0];
  const scaleText = (a.det.features.scale_text as string | null) || "the drawing scale";
  const conf = pyRound(Math.min(0.55, a.det.confidence * 0.6), 3);
  return {
    value: Number(v),
    unit: "mm",
    original_text: null,
    source: "drawing_scale",
    status: "inferred",
    confidence: conf,
    page_index: a.det.pageIndex,
    sheet: pageRef(a.page),
    bbox: a.det.bbox.toDict(),
    dimension_id: null,
    line: null,
    extension_lines: [],
    unit_basis: "scale",
    view_type: a.view ? a.view.viewType : a.page.pageType,
    view_title: a.view ? a.view.title : null,
    evidence: [
      evidence("scale_inferred", `Inferred from drawing scale (${scaleText}) - no ${which} dimension found`, null, {
        detail: `Measured ${formatLength(v, "mm")} between the opening edges on ${pageRef(a.page)}`,
        pageIndex: a.det.pageIndex,
        bbox: a.det.bbox,
      }),
    ],
    candidates: [],
  };
}

export function buildRecords(pages: Map<number, PageContext>, detections: OpeningDetection[], orphanTags: [TagDetection, string][], dims: Map<string, DimensionAnnotation>, schedules: ScheduleEntry[], thresholds: Thresholds): OpeningRecord[] {
  // ---- duplicate plan sheets (same floor / same sheet number twice) ----
  const planPages = [...pages.values()].filter((p) => p.pageType === "floor_plan");
  const dupSheet = new Map<number, string>();
  const seenFloor = new Map<string, number>();
  const seenNumber = new Map<string, number>();
  for (const p of sortedBy(planPages, (p) => p.index)) {
    if (p.sheetNumber && seenNumber.has(p.sheetNumber)) {
      dupSheet.set(p.index, `Sheet ${p.sheetNumber} appears more than once (pages ${seenNumber.get(p.sheetNumber)! + 1} and ${p.index + 1})`);
      continue;
    }
    if (p.floor && seenFloor.has(p.floor)) {
      dupSheet.set(p.index, `${p.floor} plan appears on ${pageRef(pages.get(seenFloor.get(p.floor)!)!)} and ${pageRef(p)}`);
      continue;
    }
    if (p.sheetNumber) seenNumber.set(p.sheetNumber, p.index);
    if (p.floor) seenFloor.set(p.floor, p.index);
  }

  const apps: Appearance[] = [];
  for (const d of detections) {
    const pc = pages.get(d.pageIndex)!;
    const view = pc.views.get(d.viewId ?? "") ?? null;
    const vt = view ? view.viewType : pc.pageType;
    if (vt === "floor_plan" && !(view && view.enlarged)) {
      if (dupSheet.has(d.pageIndex)) apps.push({ det: d, page: pc, view, counted: false, role: "reference", note: dupSheet.get(d.pageIndex)! });
      else apps.push({ det: d, page: pc, view, counted: true, role: "instance", note: null });
    } else if (["elevation", "detail", "section"].includes(vt) || (view && view.enlarged)) {
      apps.push({ det: d, page: pc, view, counted: false, role: "reference", note: null });
    }
  }

  // ---- group by tag ----
  const groups = new Map<string, Appearance[]>();
  const untagged: Appearance[] = [];
  for (const a of apps) {
    if (a.det.tag !== null) {
      if (!groups.has(a.det.tag.key)) groups.set(a.det.tag.key, []);
      groups.get(a.det.tag.key)!.push(a);
    } else untagged.push(a);
  }
  const schedByKey = new Map<string, ScheduleEntry>();
  for (const e of schedules) if (!schedByKey.has(e.tagKey)) schedByKey.set(e.tagKey, e);
  const orphanByKey = new Map<string, [TagDetection, string][]>();
  for (const [t, vt] of orphanTags) {
    if (!orphanByKey.has(t.key)) orphanByKey.set(t.key, []);
    orphanByKey.get(t.key)!.push([t, vt]);
  }

  const keys = sortedStrings(new Set([...groups.keys(), ...schedByKey.keys(), ...orphanByKey.keys()]));
  let records: OpeningRecord[] = [];
  for (const key of keys) records.push(record(key, groups.get(key) ?? [], schedByKey.get(key) ?? null, orphanByKey.get(key) ?? [], pages, dims, thresholds));
  for (const a of untagged) {
    // an untagged opening on an elevation/detail cannot be tied to a plan opening
    if (a.role === "reference") continue;
    records.push(record(null, [a], null, [], pages, dims, thresholds));
  }
  records = sortedBy(records, (r) => [KIND_ORDER.includes(r.type) ? KIND_ORDER.indexOf(r.type) : 99, ...natural(r.tag), r.page_index ?? 0]);
  records.forEach((r, i) => (r.ref = `OPEN-${String(i + 1).padStart(3, "0")}`));
  return records;
}

function record(key: string | null, group: Appearance[], sched: ScheduleEntry | null, orphans: [TagDetection, string][], pages: Map<number, PageContext>, dims: Map<string, DimensionAnnotation>, thr: Thresholds): OpeningRecord {
  const flags: Flag[] = [];
  const ev: Evidence[] = [];
  let instances = sortedBy(
    group.filter((a) => a.role === "instance"),
    (a) => [a.det.pageIndex, a.det.bbox.y, a.det.bbox.x],
  );
  const refs = group.filter((a) => a.role === "reference");

  // overlapping instances with the same tag on the same page -> one physical opening
  const merged: Appearance[] = [];
  for (const a of instances) {
    const twin = merged.find((m) => m.det.pageIndex === a.det.pageIndex && m.det.bbox.iou(a.det.bbox) > 0.3);
    if (twin) {
      flags.push(flag("possible_duplicate", `Two detections overlap at the same location on ${pageRef(a.page)}; counted once`, { page_index: a.det.pageIndex, field: "quantity" }));
      continue;
    }
    merged.push(a);
  }
  instances = merged;

  let tagText: string | null = null;
  if (instances.length && instances[0].det.tag) tagText = instances[0].det.tag.text;
  else if (refs.length && refs[0].det.tag) tagText = refs[0].det.tag.text;
  // as written on the plan ("WT13") rather than in a legend ("WT 13")
  else if (orphans.length) tagText = orphans[0][0].text;
  else if (sched) tagText = sched.tag;

  // tags found on plans with no opening geometry: still evidence of an opening
  const geoMissing = orphans.filter(([, vt]) => vt === "floor_plan").map(([t]) => t);
  if (geoMissing.length) {
    const where = sortedStrings(new Set(geoMissing.map((t) => pageRef(pages.get(t.pageIndex)!)))).join(", ");
    flags.push(flag("geometry_not_found", `Tag ${tagText} found on ${where} but the opening symbol could not be located`));
  }

  // ---- kind ----
  const votes = new Map<string, number>();
  for (const a of [...instances, ...refs]) {
    const w = a.role === "instance" ? 1 : 0.4;
    votes.set(a.det.kind, (votes.get(a.det.kind) ?? 0) + w * a.det.confidence);
  }
  let prefix: string | null = null;
  if (instances.length || refs.length) {
    const t0 = [...instances, ...refs][0].det.tag;
    prefix = t0 ? t0.prefix : null;
  } else if (sched || orphans.length) {
    const m = /^([A-Z]+)/.exec((tagText ?? "").toUpperCase());
    prefix = m ? m[1] : null;
  }
  const pageIdx = [...instances, ...refs][0]?.det.pageIndex ?? sched?.pageIndex ?? orphans[0]?.[0].pageIndex;
  const tclass = prefix ? tagClass(prefix, pageIdx !== undefined ? pages.get(pageIdx)?.language : undefined) : null;
  let kind = votes.size ? maxBy([...votes.keys()], (k) => votes.get(k)!) : tclass || "other";
  const schedKind = sched ? scheduleTypeKind(sched.typeText, sched.scheduleKind, prefix ?? "") : null;
  if (tclass && tclass !== "other") {
    const fam = (k: string) => (["window", "sliding_window", "curtain_wall"].includes(k) ? "window" : ["door", "double_door", "sliding_door", "garage_door"].includes(k) ? "door" : "opening");
    const family = fam(tclass);
    const geoFamily = fam(kind);
    if (family !== geoFamily && votes.size) {
      if (geoFamily !== "opening") flags.push(flag("unclear_type", `Tag prefix '${prefix}' suggests a ${family}, but the drawing symbol looks like a ${(OPENING_TYPE_LABELS[kind] ?? kind).toLowerCase()}`, { field: "type" }));
      kind = tclass in OPENING_TYPE_LABELS ? tclass : family;
    } else if (!["door", "window", "opening"].includes(tclass)) {
      kind = tclass; // SD/GD/SW/CW/GC prefixes are specific
    }
  }
  if (schedKind) kind = schedKind;
  if (!votes.size && !tclass) flags.push(flag("unclear_type", "Opening type could not be determined", { field: "type" }));

  // ---- measurements ----
  const candsFor = (which: "width" | "height"): MeasCandidate[] => {
    const out: MeasCandidate[] = [];
    for (const a of [...instances, ...refs]) {
      const assoc = which === "width" ? a.det.widthAssoc : a.det.heightAssoc;
      if (assoc === null) continue;
      const d = dims.get(assoc.dimensionId);
      if (!d) continue;
      const c = measCandidate(d, assoc.score * Math.min(1, a.det.confidence + 0.1), assoc.signals, a, which);
      c.shared_with = assoc.sharedWith;
      out.push(c);
    }
    if (sched) {
      const sc = scheduleCandidate(sched, which, pages.get(sched.pageIndex)!);
      if (sc) out.push(sc);
    }
    return out;
  };

  const measurements: Record<"width" | "height", MeasurementRecord | null> = { width: null, height: null };
  for (const which of ["width", "height"] as const) {
    const whichT = pyTitle(which);
    let [m, fl] = reconcile(candsFor(which), which);
    flags.push(...fl);
    if (m === null) {
      const inf = inferred([...instances, ...refs], which);
      if (inf !== null) {
        m = inf;
        flags.push(flag("scale_inferred", `${whichT} ${formatLength(inf.value, "mm")} inferred from drawing scale - no explicit dimension found`, { field: which }));
      } else flags.push(flag(`missing_${which}`, `${whichT} could not be determined from the drawings - needs review`, { field: which }));
    } else if (m.status === "explicit") {
      const weak = m.evidence.filter((e) => e.code === "ambiguous");
      if (m.confidence < 0.65 || weak.length) flags.push(flag("uncertain_association", `${whichT} ${m.original_text} - dimension association is uncertain`, { field: which }));
      if (m.evidence.some((e) => e.code === "level_alignment") && !(m.candidates ?? []).some((c) => c.source === "schedule") && m.confidence < thr.high) {
        flags.push(flag("uncertain_association", `${whichT} taken from a level dimension shared with other openings`, { field: which }));
      }
    }
    measurements[which] = m;
    void fl;
  }

  // ---- quantity ----
  const nInst = instances.length + geoMissing.length;
  let qtyBasis = "plan_instances";
  let qty: number;
  if (nInst) qty = nInst;
  else if (refs.length) {
    const elev = refs.filter((a) => a.view && a.view.viewType === "elevation");
    if (elev.length && !refs.some((a) => a.note)) {
      qty = elev.length;
      qtyBasis = "elevation_references";
      flags.push(flag("counted_from_elevations", `No floor-plan instance found; quantity ${qty} counted from elevations`, { field: "quantity" }));
    } else {
      qty = refs.filter((a) => a.note).length || 0;
      qtyBasis = "reference_only";
      flags.push(flag("reference_only", "Shown only on details/duplicate sheets - not located on a floor plan", { field: "quantity" }));
    }
  } else if (sched) {
    qty = 0;
    qtyBasis = "schedule_only";
    flags.push(flag("schedule_only", `${pyTitle(sched.scheduleTitle)} lists ${sched.tag}` + (sched.quantity !== null ? ` (qty ${sched.quantity})` : "") + " but it was not found on any drawing; not counted", { field: "quantity" }));
  } else {
    qty = 0;
    qtyBasis = "none";
  }
  if (sched && sched.quantity !== null && qtyBasis !== "schedule_only" && sched.quantity !== qty) {
    flags.push(flag("quantity_conflict", `Schedule quantity ${sched.quantity} vs ${qty} located on the drawings`, { schedule_quantity: sched.quantity, located: qty, field: "quantity" }));
  }

  // ---- duplicates ----
  for (const a of instances) {
    const dups = (a.det.features.duplicate_tags as unknown[] | undefined) ?? [];
    if (dups.length) flags.push(flag("possible_duplicate", `Tag ${tagText} is written ${dups.length + 1} times at one opening on ${pageRef(a.page)}; counted once`, { page_index: a.det.pageIndex, field: "quantity" }));
  }
  for (const a of refs) if (a.note) flags.push(flag("possible_duplicate", a.note + "; not counted again", { page_index: a.det.pageIndex, field: "quantity" }));

  // ---- tag ----
  let tagConf: number | null = null;
  const primary = instances.length ? instances[0] : refs.length ? refs[0] : null;
  if (primary && primary.det.tag) {
    tagConf = primary.det.tagScore;
    if (tagConf < 0.7) flags.push(flag("unclear_tag", `Tag ${tagText} association is uncertain`, { field: "tag" }));
  } else if (key === null) {
    flags.push(flag("unclear_tag", "No tag found for this opening", { field: "tag" }));
    tagConf = 0;
  } else if (sched) tagConf = sched.confidence;
  else if (orphans.length) tagConf = orphans[0][0].confidence;

  // ---- poor quality pages ----
  for (const a of [...instances, ...refs]) {
    if (a.page.poorQuality) {
      flags.push(flag("poor_page_quality", `${pageRef(a.page)} is a low-quality scan: ${a.page.qualityReasons.join(", ") || "unreliable"}`, { page_index: a.det.pageIndex }));
      break;
    }
  }

  // ---- evidence summary ----
  if (primary) {
    ev.push(evidence("source_page", `Source: ${pageRef(primary.page)} (${PAGE_TYPE_LABELS[primary.view ? primary.view.viewType : primary.page.pageType] ?? "Drawing"})`, true, { pageIndex: primary.det.pageIndex, bbox: primary.det.bbox }));
    ev.push(evidence("opening_detected", `Opening detected (${OPENING_TYPE_LABELS[primary.det.kind] ?? primary.det.kind})`, true, { score: primary.det.confidence, pageIndex: primary.det.pageIndex, bbox: primary.det.bbox, target: primary.det.id }));
    ev.push(...primary.det.evidence, ...primary.det.tagEvidence);
  }
  for (const a of refs) {
    const vt = a.view ? a.view.viewType : a.page.pageType;
    ev.push(
      evidence("reference", `Also shown on ${pageRef(a.page)} ${a.view && a.view.title ? pyTitle(a.view.title) : PAGE_TYPE_LABELS[vt] ?? ""} - same opening, not counted again`, null, {
        pageIndex: a.det.pageIndex,
        bbox: a.det.bbox,
        target: a.det.id,
      }),
    );
  }
  if (sched) ev.push(evidence("schedule", `Listed in ${pyTitle(sched.scheduleTitle)} on ${pageRef(pages.get(sched.pageIndex)!)}`, true, { pageIndex: sched.pageIndex, bbox: sched.rowBBox, target: sched.id }));

  // ---- confidence ----
  let detConf: number | null = instances.length ? Math.max(...instances.map((a) => a.det.confidence)) : refs.length ? Math.max(...refs.map((a) => a.det.confidence)) : null;
  if (detConf === null && orphans.length) detConf = 0.35;
  const assocScores: number[] = [];
  for (const which of ["width", "height"] as const) {
    const m = measurements[which];
    if (m && m.status === "explicit" && m.source !== "schedule") assocScores.push(m.confidence);
  }
  const mconf = (m: MeasurementRecord | null) => (m === null ? 0 : m.confidence);
  const conf: Record<string, number | null> = {
    detection: detConf !== null ? pyRound(detConf, 3) : null,
    tag: tagConf !== null ? pyRound(tagConf, 3) : null,
    width: mconf(measurements.width),
    height: mconf(measurements.height),
    association: assocScores.length ? pyRound(assocScores.reduce((a, b) => a + b, 0) / assocScores.length, 3) : null,
  };
  const requiredMissing = (["width", "height"] as const).some((w) => measurements[w] === null || measurements[w]!.status === "conflict");
  conf.overall = overall(conf, requiredMissing);
  if (conf.overall < thr.medium && !flags.some((f) => ["missing_width", "missing_height", "schedule_conflict", "dimension_conflict", "schedule_only"].includes(f.code))) {
    flags.push(flag("low_confidence", `Overall confidence ${pyPercent(conf.overall)} is below the review threshold`));
  }

  // dedupe flags by (code, message)
  const seen = new Set<string>();
  const uniqFlags: Flag[] = [];
  for (const f of flags) {
    const k = `${f.code}\u0000${f.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniqFlags.push(f);
    }
  }

  const floors = [...new Set(sortedBy(instances, (a) => a.page.index).map((a) => a.page.floor).filter((f): f is string => !!f))];
  const instOut: InstanceOut[] = [
    ...instances.map((a) => ({
      detection_id: a.det.id,
      page_index: a.det.pageIndex,
      sheet: pageRef(a.page),
      floor: a.page.floor,
      room: a.det.room,
      bbox: a.det.bbox.toDict(),
      kind: a.det.kind,
      confidence: pyRound(a.det.confidence, 3),
      tag_text: a.det.tag ? a.det.tag.text : null,
      tag_bbox: a.det.tag ? a.det.tag.bbox.toDict() : null,
      width_text: a.det.widthAssoc && dims.has(a.det.widthAssoc.dimensionId) ? dims.get(a.det.widthAssoc.dimensionId)!.text : null,
      counted: true,
    })),
    ...geoMissing.map((t) => ({
      detection_id: t.id,
      page_index: t.pageIndex,
      sheet: pageRef(pages.get(t.pageIndex)!),
      floor: pages.get(t.pageIndex)!.floor,
      room: null,
      bbox: t.bbox.toDict(),
      kind,
      confidence: 0.35,
      tag_text: t.text,
      tag_bbox: t.bbox.toDict(),
      width_text: null,
      counted: true,
      geometry_missing: true,
    })),
  ];
  const refOut: InstanceOut[] = refs.map((a) => ({
    detection_id: a.det.id,
    page_index: a.det.pageIndex,
    sheet: pageRef(a.page),
    view_type: a.view ? a.view.viewType : a.page.pageType,
    view_title: a.view ? a.view.title : null,
    bbox: a.det.bbox.toDict(),
    kind: a.det.kind,
    confidence: pyRound(a.det.confidence, 3),
    tag_text: a.det.tag ? a.det.tag.text : null,
    tag_bbox: a.det.tag ? a.det.tag.bbox.toDict() : null,
    counted: false,
    note: a.note,
  }));
  const ppage = primary ? primary.det.pageIndex : geoMissing.length ? geoMissing[0].pageIndex : sched ? sched.pageIndex : null;
  const pbbox = primary ? primary.det.bbox.toDict() : geoMissing.length ? geoMissing[0].bbox.toDict() : sched ? sched.rowBBox.toDict() : null;
  return {
    ref: "",
    type: kind,
    tag: tagText,
    tag_key: key,
    width: measurements.width,
    height: measurements.height,
    quantity: qty,
    quantity_basis: qtyBasis,
    page_index: ppage,
    drawing_reference: ppage !== null ? pageRef(pages.get(ppage)!) : null,
    bbox: pbbox,
    floor: floors.length ? floors.join(", ") : instances.length ? instances[0].page.floor : null,
    room: primary ? primary.det.room : null,
    status: needsReview(uniqFlags) ? "needs_review" : "extracted",
    flags: uniqFlags,
    evidence: ev,
    confidence: conf,
    instances: instOut,
    references: refOut,
    schedule: sched ? scheduleToDict(sched) : null,
    source_detections: [...instances, ...refs].map((a) => a.det.id),
    source: "ai",
  };
}

export { cmpTuple };
