/**
 * Opening records: serialisation, user edits, verification and re-extraction merges.
 *
 * - the original AI result is kept in `ai_snapshot` and never modified by edits
 * - user edits are stored as `source: user` measurements and listed in `edited_fields`
 * - re-extraction never overwrites edited or verified openings silently: the new
 *   AI result is parked in `pending_ai` until the user accepts or rejects it
 * - every change is written to the audit trail
 */
import { FLAG_INFO, Thresholds, flag, needsReview, overall } from "../engine/confidence";
import type { OpeningRecord } from "../engine/crossref";
import { parseTag } from "../engine/tags";
import { BBox, OPENING_TYPES, OPENING_TYPE_LABELS, type BBoxDict } from "../engine/types";
import { MM_PER_UNIT, approxEqualMm, formatLength, parseDimension } from "../engine/units";
import { pyPercent, pyRound, sortedBy } from "../engine/py";
import { nowIso, uuid, type AuditRow, type MeasurementRow, type OpeningRow, type PageRow, type ProjectRow } from "./db";

export const EDITABLE = new Set(["type", "tag", "width", "height", "quantity", "page_index", "drawing_reference", "floor", "room", "notes"]);
const SNAPSHOT_FIELDS = ["type", "tag", "width", "height", "quantity", "quantity_basis", "page_index", "drawing_reference", "floor", "room", "confidence", "flags"] as const;

export class EditError extends Error {}

/** Collected audit events of one operation (written by the caller in the same transaction). */
export type AuditSink = (e: Omit<AuditRow, "id" | "project_id" | "created_at">) => void;

export function thresholdsFor(p: ProjectRow): Thresholds {
  return Thresholds.fromDict(p.settings?.thresholds);
}

function clone<T>(x: T): T {
  return x === undefined ? x : JSON.parse(JSON.stringify(x));
}

export function measSummary(m: MeasurementRow | Record<string, unknown> | null | undefined) {
  if (!m) return null;
  return { value: m.value ?? null, unit: m.unit ?? null, original_text: m.original_text ?? null, source: m.source ?? null, status: m.status ?? null, confidence: m.confidence ?? null };
}

function openingLabel(o: OpeningRow): string {
  return `${o.ref}` + (o.tag ? ` ${o.tag}` : "");
}

export function auditFor(o: OpeningRow | null, actor: AuditRow["actor"], action: string, message: string, extra: { user?: string | null; field?: string | null; old?: unknown; new?: unknown } = {}): Omit<AuditRow, "id" | "project_id" | "created_at"> {
  return {
    opening_id: o ? o.id : null,
    opening_ref: o ? openingLabel(o) : null,
    actor,
    user: extra.user ?? null,
    action,
    field: extra.field ?? null,
    old_value: extra.old ?? null,
    new_value: extra.new ?? null,
    message,
  };
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

export function toDict(o: OpeningRow) {
  const snap = o.ai_snapshot as Record<string, unknown> | null;
  const pending = o.pending_ai as Record<string, unknown> | null;
  return {
    id: o.id,
    ref: o.ref,
    type: o.type,
    type_label: OPENING_TYPE_LABELS[o.type] ?? o.type,
    tag: o.tag,
    tag_key: o.tag_key,
    width: o.width,
    height: o.height,
    quantity: o.quantity,
    quantity_basis: o.quantity_basis,
    page_id: o.page_id,
    page_index: o.page_index,
    page: o.page_index !== null ? o.page_index + 1 : null,
    drawing_reference: o.drawing_reference,
    bbox: o.bbox,
    floor: o.floor,
    room: o.room,
    status: o.status,
    source: o.source,
    confidence: o.confidence ?? {},
    flags: o.flags ?? [],
    evidence: o.evidence ?? [],
    instances: o.instances ?? [],
    references: o.references ?? [],
    schedule: o.schedule,
    source_detections: o.source_detections ?? [],
    notes: o.notes ?? "",
    edited_fields: o.edited_fields ?? [],
    ai_original: snap
      ? { type: snap.type, tag: snap.tag, width: measSummary(snap.width as MeasurementRow), height: measSummary(snap.height as MeasurementRow), quantity: snap.quantity }
      : null,
    pending_ai: pending
      ? { type: pending.type, tag: pending.tag, width: measSummary(pending.width as MeasurementRow), height: measSummary(pending.height as MeasurementRow), quantity: pending.quantity, run_id: pending.run_id }
      : null,
    verification: { verified: o.verified, verified_by_user: !!(o.verified && o.verified_by), verified_by: o.verified_by, verified_at: o.verified_at },
    version: o.version,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

// ---------------------------------------------------------------------------
// status / flags
// ---------------------------------------------------------------------------

export function refreshStatus(o: OpeningRow, thr: Thresholds): void {
  const conf: Record<string, number | null> = { ...(o.confidence ?? {}) };
  for (const f of ["width", "height"] as const) conf[f] = o[f] === null ? 0 : (o[f]!.confidence ?? 0);
  const requiredMissing = (["width", "height"] as const).some((f) => o[f] === null || o[f]!.status === "conflict");
  const rest = { ...conf };
  delete rest.overall;
  conf.overall = overall(rest, requiredMissing);
  o.confidence = conf;
  const flags = (o.flags ?? []).filter((f) => f.code !== "low_confidence");
  if (conf.overall! < thr.medium && !flags.some((f) => ["missing_width", "missing_height", "schedule_conflict", "dimension_conflict", "schedule_only"].includes(f.code))) {
    flags.push(flag("low_confidence", `Overall confidence ${pyPercent(conf.overall!)} is below the review threshold`));
  }
  o.flags = flags;
  o.status = o.verified ? "verified" : needsReview(flags) ? "needs_review" : "extracted";
}

function dropFieldFlags(o: OpeningRow, field: string): void {
  o.flags = (o.flags ?? []).filter((f) => f.field !== field);
}

export function fmtMeas(m: MeasurementRow | Record<string, unknown> | null | undefined): string {
  if (!m) return "—";
  if (m.status === "conflict") return "conflicting values (" + ((m.candidates as Record<string, unknown>[]) ?? []).map((c) => `${c.label} ${c.original_text}`).join(" vs ") + ")";
  return formatLength(m.value as number | null, "mm");
}

function pg(i: number | null): string {
  return i !== null && i !== undefined ? `page ${i + 1}` : "—";
}

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

/** Accepts {value: 1600, unit: "mm"} or {text: "5'-3\""} or null. */
export function parseUserMeasurement(val: unknown, defaultUnit = "mm"): { value: number; unit: string; original_text: string } | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") val = { value: val, unit: defaultUnit };
  if (typeof val !== "object") throw new EditError("measurement must be an object");
  const v = val as { text?: string; value?: unknown; unit?: string };
  let valueMm: number;
  let unit: string;
  let text: string;
  if (v.text) {
    const p = parseDimension(String(v.text), ["mm", "cm", "m", "in"].includes(defaultUnit) ? defaultUnit : "mm");
    if (!p) throw new EditError(`Could not read a dimension from '${v.text}'`);
    valueMm = p.valueMm;
    unit = p.unit;
    text = String(v.text).trim();
  } else {
    const n = Number(v.value);
    if (v.value === undefined || v.value === null || !Number.isFinite(n)) throw new EditError("measurement value is required");
    unit = String(v.unit || defaultUnit);
    const factor = MM_PER_UNIT[unit === "ft_in" ? "in" : unit];
    if (factor === undefined) throw new EditError(`unknown unit '${unit}'`);
    valueMm = n * factor;
    text = unit !== "mm" ? formatLength(valueMm, unit !== "in" ? unit : "ft_in") : String(n);
  }
  if (!(valueMm >= 10 && valueMm <= 50000)) throw new EditError("measurement out of range (10 mm - 50 m)");
  return { value: pyRound(valueMm, 2), unit, original_text: text };
}

export function applyEdits(project: ProjectRow, o: OpeningRow, changes: Record<string, unknown>, user: string, pages: PageRow[], audit: AuditSink): string[] {
  const unknown = Object.keys(changes).filter((k) => !EDITABLE.has(k));
  if (unknown.length) throw new EditError(`fields not editable: ${unknown.sort().join(", ")}`);
  const thr = thresholdsFor(project);
  const changed: string[] = [];
  const defaultUnit = project.settings?.default_unit ?? "mm";
  for (const [field, raw] of Object.entries(changes)) {
    if (field === "width" || field === "height") {
      const parsed = parseUserMeasurement(raw, defaultUnit);
      const old = o[field];
      if (parsed === null && old === null) continue;
      if (parsed !== null && old && old.value !== null && approxEqualMm(old.value, parsed.value, 0, 0.01) && old.source === "user") continue;
      let nv: MeasurementRow | null = null;
      if (parsed !== null) {
        nv = {
          ...parsed,
          source: "user",
          status: "user",
          confidence: 1,
          page_index: old?.page_index ?? null,
          bbox: old?.bbox ?? null,
          line: old?.line ?? null,
          evidence: [{ code: "user_edit", label: `Entered by ${user}`, passed: true, detail: `Previous value: ${fmtMeas(old)}`, score: null, page_index: old?.page_index ?? null, bbox: old?.bbox ?? null, target: null }],
          previous: measSummary(old),
          candidates: old?.candidates ?? [],
        };
      }
      o[field] = nv;
      dropFieldFlags(o, field);
      audit(auditFor(o, "user", "edit", `User changed ${field} from ${fmtMeas(old)} to ${fmtMeas(nv)}`, { user, field, old: measSummary(old), new: measSummary(nv) }));
      changed.push(field);
    } else if (field === "type") {
      const val = String(raw);
      if (!(OPENING_TYPES as readonly string[]).includes(val)) throw new EditError(`unknown opening type '${val}'`);
      if (val !== o.type) {
        audit(auditFor(o, "user", "edit", `User changed type from ${OPENING_TYPE_LABELS[o.type] ?? o.type} to ${OPENING_TYPE_LABELS[val]}`, { user, field, old: o.type, new: val }));
        o.type = val;
        dropFieldFlags(o, "type");
        changed.push(field);
      }
    } else if (field === "tag") {
      const val = raw !== null && raw !== undefined ? String(raw).trim() || null : null;
      if (val && val.length > 60) throw new EditError("tag too long");
      if (val !== o.tag) {
        audit(auditFor(o, "user", "edit", `User changed tag from ${o.tag || "—"} to ${val || "—"}`, { user, field, old: o.tag, new: val }));
        o.tag = val;
        const p = val ? parseTag(val) : null;
        o.tag_key = p ? p[1] : val ? val.toUpperCase() : null;
        dropFieldFlags(o, "tag");
        changed.push(field);
      }
    } else if (field === "quantity") {
      let val: number | null = null;
      if (raw !== null && raw !== undefined) {
        val = Number(raw);
        if (!Number.isInteger(val)) throw new EditError("quantity must be an integer");
        if (!(val >= 0 && val <= 100000)) throw new EditError("quantity out of range");
      }
      if (val !== o.quantity) {
        audit(auditFor(o, "user", "edit", `User changed quantity from ${o.quantity} to ${val}`, { user, field, old: o.quantity, new: val }));
        o.quantity = val;
        o.quantity_basis = "user";
        dropFieldFlags(o, "quantity");
        changed.push(field);
      }
    } else if (field === "page_index") {
      let page: PageRow | null = null;
      if (raw !== null && raw !== undefined) {
        page = pages.find((p) => p.page_index === Number(raw)) ?? null;
        if (!page) throw new EditError("page not found in this project");
      }
      const ni = page ? page.page_index : null;
      if (ni !== o.page_index) {
        audit(auditFor(o, "user", "edit", `User changed source page from ${pg(o.page_index)} to ${pg(ni)}`, { user, field, old: o.page_index, new: ni }));
        o.page_index = ni;
        o.page_id = page ? page.id : null;
        if (page && !o.drawing_reference) o.drawing_reference = page.sheet_number;
        changed.push(field);
      }
    } else {
      // drawing_reference, floor, room, notes
      let val = raw !== null && raw !== undefined ? String(raw) : null;
      if (val !== null && val.length > (field === "notes" ? 5000 : 120)) throw new EditError(`${field} too long`);
      if (field === "notes") val = val || "";
      const f = field as "drawing_reference" | "floor" | "room" | "notes";
      const cur = o[f];
      if (val !== cur) {
        audit(auditFor(o, "user", "edit", field !== "notes" ? `User changed ${field.replace(/_/g, " ")} from ${cur || "—"} to ${val || "—"}` : "User updated notes", { user, field, old: cur, new: val }));
        (o as unknown as Record<string, unknown>)[f] = val;
        changed.push(field);
      }
    }
  }
  if (changed.length) {
    const meaningful = changed.filter((c) => c !== "notes");
    o.edited_fields = [...new Set([...(o.edited_fields ?? []), ...meaningful])].sort();
    if (o.verified && meaningful.length) {
      o.verified = false;
      o.verified_at = null;
      o.verified_by = null;
      audit(auditFor(o, "system", "unverify", "Verification cleared because the opening was edited", { user }));
    }
    o.version += 1;
    o.updated_at = nowIso();
    refreshStatus(o, thr);
  }
  return changed;
}

export function resolveConflict(project: ProjectRow, o: OpeningRow, field: "width" | "height", candidateIndex: number, user: string, audit: AuditSink): void {
  const m = o[field];
  if (!m || m.status !== "conflict") throw new EditError(`${field} is not in conflict`);
  const cands = (m.candidates ?? []) as Record<string, unknown>[];
  if (!(candidateIndex >= 0 && candidateIndex < cands.length)) throw new EditError("invalid candidate");
  const c = cands[candidateIndex];
  const nv: MeasurementRow = {
    value: c.value as number,
    unit: c.unit as string,
    original_text: c.original_text as string,
    source: "user",
    status: "user",
    confidence: 1,
    page_index: (c.page_index as number) ?? null,
    bbox: (c.bbox as BBoxDict) ?? null,
    dimension_id: c.dimension_id ?? null,
    evidence: [
      {
        code: "conflict_resolved",
        label: `Conflict resolved by ${user}: chose ${c.label} (${c.original_text})`,
        passed: true,
        detail: "Other sources: " + cands.filter((_, i) => i !== candidateIndex).map((x) => `${x.label} ${x.original_text}`).join(", "),
        score: null,
        page_index: (c.page_index as number) ?? null,
        bbox: (c.bbox as BBoxDict) ?? null,
        target: (c.dimension_id as string) ?? null,
      },
    ],
    candidates: cands,
    previous: measSummary(m),
  };
  o[field] = nv;
  dropFieldFlags(o, field);
  o.edited_fields = [...new Set([...(o.edited_fields ?? []), field])].sort();
  audit(
    auditFor(o, "user", "resolve_conflict", `User resolved ${field} conflict: chose ${c.label} ${c.original_text}`, {
      user,
      field,
      old: { candidates: cands.map((x) => ({ label: x.label, text: x.original_text })) },
      new: measSummary(nv),
    }),
  );
  o.verified = false;
  o.version += 1;
  o.updated_at = nowIso();
  refreshStatus(o, thresholdsFor(project));
}

export function verify(project: ProjectRow, o: OpeningRow, user: string, verified: boolean, audit: AuditSink): void {
  if (verified === o.verified) return;
  o.verified = verified;
  o.verified_by = verified ? user : null;
  o.verified_at = verified ? nowIso() : null;
  o.version += 1;
  o.updated_at = nowIso();
  audit(auditFor(o, "user", verified ? "verify" : "unverify", verified ? "User verified opening" : "User removed verification", { user }));
  refreshStatus(o, thresholdsFor(project));
}

export function nextRef(existing: OpeningRow[]): string {
  let n = 0;
  for (const o of existing) {
    const v = parseInt(o.ref.split("-").pop() ?? "", 10);
    if (Number.isFinite(v)) n = Math.max(n, v);
  }
  return `OPEN-${String(n + 1).padStart(3, "0")}`;
}

export function newOpening(projectId: string, p: Partial<OpeningRow>): OpeningRow {
  const t = nowIso();
  return {
    id: uuid(),
    project_id: projectId,
    run_id: null,
    ref: "",
    type: "window",
    tag: null,
    tag_key: null,
    width: null,
    height: null,
    quantity: null,
    quantity_basis: null,
    page_id: null,
    page_index: null,
    drawing_reference: null,
    bbox: null,
    floor: null,
    room: null,
    status: "extracted",
    source: "ai",
    confidence: {},
    flags: [],
    evidence: [],
    instances: [],
    references: [],
    schedule: null,
    source_detections: [],
    notes: "",
    edited_fields: [],
    ai_snapshot: null,
    pending_ai: null,
    verified: false,
    verified_by: null,
    verified_at: null,
    sort_index: 0,
    version: 1,
    deleted_at: null,
    created_at: t,
    updated_at: t,
    ...p,
  };
}

export function createManual(project: ProjectRow, existing: OpeningRow[], data: Record<string, unknown>, user: string, pages: PageRow[], audit: AuditSink): OpeningRow {
  const typ = (data.type as string) || "window";
  if (!(OPENING_TYPES as readonly string[]).includes(typ)) throw new EditError(`unknown opening type '${typ}'`);
  const o = newOpening(project.id, {
    ref: nextRef(existing),
    type: typ,
    source: "user",
    confidence: { detection: 1, tag: 1, width: null, height: null, association: null, overall: 1 },
    evidence: [{ code: "manual", label: `Added manually by ${user}`, passed: true, detail: null, score: null, page_index: null, bbox: null, target: null }],
    quantity: 1,
    quantity_basis: "user",
    sort_index: existing.length,
  });
  audit(auditFor(o, "user", "create", `User added ${o.ref} manually`, { user }));
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (EDITABLE.has(k) && k !== "type" && v !== undefined && v !== null) changes[k] = v;
  const b = data.bbox as BBoxDict | undefined;
  if (b) o.bbox = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
  if (Object.keys(changes).length) applyEdits(project, o, changes, user, pages, audit);
  else refreshStatus(o, thresholdsFor(project));
  // manual measurements come from the user
  for (const f of ["width", "height"] as const) {
    const m = o[f];
    if (m) o[f] = { ...m, evidence: [{ code: "manual", label: `Entered manually by ${user}`, passed: true, detail: null, score: null, page_index: null, bbox: null, target: null }] };
  }
  if (o.page_index !== null && o.bbox) {
    o.instances = [{ detection_id: null, page_index: o.page_index, sheet: o.drawing_reference, floor: o.floor, room: o.room, bbox: o.bbox, kind: o.type, confidence: 1, tag_text: o.tag, counted: true, manual: true }];
  }
  o.version = 1;
  refreshStatus(o, thresholdsFor(project));
  return o;
}

// ---------------------------------------------------------------------------
// merging a new extraction run
// ---------------------------------------------------------------------------

function recordSnapshot(rec: OpeningRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_FIELDS) out[k] = clone((rec as unknown as Record<string, unknown>)[k] ?? null);
  return out;
}

function sameAi(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (!a || !b) return false;
  const mv = (m: unknown) => {
    const x = m as MeasurementRow | null;
    if (!x) return null;
    return `${x.status}|${x.value !== null && x.value !== undefined ? pyRound(x.value) : null}`;
  };
  return a.type === b.type && a.tag === b.tag && mv(a.width) === mv(b.width) && mv(a.height) === mv(b.height) && a.quantity === b.quantity;
}

const RECORD_FIELDS = ["type", "tag", "tag_key", "width", "height", "quantity", "quantity_basis", "page_index", "drawing_reference", "bbox", "floor", "room", "confidence", "flags", "evidence", "instances", "references", "schedule", "source_detections"] as const;

function applyRecord(o: OpeningRow, rec: Record<string, unknown>, pages: Map<number, PageRow>): void {
  const target = o as unknown as Record<string, unknown>;
  for (const k of RECORD_FIELDS) target[k] = clone(rec[k] ?? null);
  if (!o.flags) o.flags = [];
  if (!o.evidence) o.evidence = [];
  if (!o.instances) o.instances = [];
  if (!o.references) o.references = [];
  if (!o.source_detections) o.source_detections = [];
  if (!o.confidence) o.confidence = {};
  const p = rec.page_index !== null && rec.page_index !== undefined ? pages.get(rec.page_index as number) : undefined;
  o.page_id = p ? p.id : null;
}

function match(existing: OpeningRow[], rec: OpeningRecord): OpeningRow | null {
  if (rec.tag_key) return existing.find((o) => o.tag_key === rec.tag_key && o.source === "ai") ?? null;
  if (rec.bbox && rec.page_index !== null) {
    const rb = BBox.fromDict(rec.bbox);
    let best: [number, OpeningRow] | null = null;
    for (const o of existing) {
      if (o.tag_key || o.source !== "ai" || o.page_index !== rec.page_index || !o.bbox) continue;
      const iou = BBox.fromDict(o.bbox).iou(rb);
      if (iou > 0.3 && (best === null || iou > best[0])) best = [iou, o];
    }
    return best ? best[1] : null;
  }
  return null;
}

export interface MergeStats {
  created: number;
  updated: number;
  unchanged: number;
  pending_confirmation: number;
  removed: number;
}

/** Merge a new run's records into the project's openings. Returns [openings to write, stats]. */
export function mergeRun(project: ProjectRow, allOpenings: OpeningRow[], runId: string, records: OpeningRecord[], pages: Map<number, PageRow>, audit: AuditSink): [OpeningRow[], MergeStats] {
  const thr = thresholdsFor(project);
  const existing = allOpenings.filter((o) => o.deleted_at === null);
  const matched = new Set<string>();
  const stats: MergeStats = { created: 0, updated: 0, unchanged: 0, pending_confirmation: 0, removed: 0 };
  const firstRun = existing.length === 0;
  const touched = new Map<string, OpeningRow>();
  const all = [...allOpenings];
  records.forEach((rec, idx) => {
    const r = rec as unknown as Record<string, unknown>;
    let o = match(
      existing.filter((e) => !matched.has(e.id)),
      rec,
    );
    const snap = recordSnapshot(rec);
    if (o === null) {
      o = newOpening(project.id, { ref: firstRun ? rec.ref : nextRef(all), source: "ai", run_id: runId, sort_index: idx });
      applyRecord(o, r, pages);
      o.ai_snapshot = snap;
      refreshStatus(o, thr);
      all.push(o);
      touched.set(o.id, o);
      audit(auditFor(o, "ai", "extract", `AI extracted ${(OPENING_TYPE_LABELS[o.type] ?? o.type).toLowerCase()} ${o.tag || "(untagged)"}`, { new: { type: o.type, tag: o.tag, quantity: o.quantity } }));
      for (const f of ["width", "height"] as const) {
        const m = o[f];
        audit(
          auditFor(o, "ai", "extract", m ? `AI extracted ${f}: ${fmtMeas(m)}` + (m.status === "inferred" ? " (inferred from drawing scale)" : "") : `AI could not determine ${f} - needs review`, {
            field: f,
            new: measSummary(m),
          }),
        );
      }
      stats.created++;
      return;
    }
    matched.add(o.id);
    touched.set(o.id, o);
    o.sort_index = idx;
    if (sameAi(o.ai_snapshot, snap)) {
      // same answer as before: refresh evidence/geometry but keep user fields
      if (!o.edited_fields.length && !o.verified) applyRecord(o, r, pages);
      o.run_id = runId;
      o.ai_snapshot = snap;
      refreshStatus(o, thr);
      stats.unchanged++;
      return;
    }
    if (o.edited_fields.length || o.verified) {
      // never overwrite the user's work: park the new AI result for confirmation
      o.pending_ai = { ...clone(r), run_id: runId };
      o.flags = [...o.flags.filter((f) => f.code !== "ai_update_available"), flag("ai_update_available", "The latest extraction produced different values; your edits were kept. Review and accept or dismiss.")];
      audit(auditFor(o, "system", "reprocess_pending", "Re-extraction differs from the edited/verified values; awaiting confirmation", { new: { width: measSummary(rec.width as MeasurementRow), height: measSummary(rec.height as MeasurementRow) } }));
      stats.pending_confirmation++;
    } else {
      const oldW = o.width;
      const oldH = o.height;
      applyRecord(o, r, pages);
      o.ai_snapshot = snap;
      o.run_id = runId;
      for (const [f, old] of [
        ["width", oldW],
        ["height", oldH],
      ] as const) {
        const nv = o[f];
        if (fmtMeas(old) !== fmtMeas(nv)) audit(auditFor(o, "ai", "reextract", `Re-extraction changed ${f} from ${fmtMeas(old)} to ${fmtMeas(nv)}`, { field: f, old: measSummary(old), new: measSummary(nv) }));
      }
      stats.updated++;
    }
    o.version += 1;
    o.updated_at = nowIso();
    refreshStatus(o, thr);
  });
  for (const o of existing) {
    if (matched.has(o.id) || o.source !== "ai") continue;
    if (o.edited_fields.length || o.verified) {
      o.flags = [...o.flags.filter((f) => f.code !== "ai_update_available"), flag("ai_update_available", "Not found by the latest extraction; kept because you edited or verified it.")];
      refreshStatus(o, thr);
    } else {
      o.deleted_at = nowIso();
      audit(auditFor(o, "ai", "reextract_removed", `Removed by re-extraction (${o.ref} ${o.tag || ""})`.trim()));
      stats.removed++;
    }
    touched.set(o.id, o);
  }
  return [[...touched.values()], stats];
}

export function acceptPending(project: ProjectRow, o: OpeningRow, user: string, accept: boolean, pages: Map<number, PageRow>, audit: AuditSink): void {
  if (!o.pending_ai) throw new EditError("no pending AI update");
  const rec = o.pending_ai;
  if (accept) {
    const old = { width: measSummary(o.width), height: measSummary(o.height), type: o.type, tag: o.tag, quantity: o.quantity };
    applyRecord(o, rec, pages);
    o.ai_snapshot = recordSnapshot(rec as unknown as OpeningRecord);
    o.edited_fields = [];
    o.verified = false;
    o.verified_at = null;
    o.verified_by = null;
    audit(auditFor(o, "user", "accept_ai_update", "User accepted the re-extracted AI values (replacing previous edits)", { user, old, new: { width: measSummary(o.width), height: measSummary(o.height) } }));
  } else {
    audit(auditFor(o, "user", "reject_ai_update", "User kept their values and dismissed the re-extracted AI values", { user }));
  }
  o.pending_ai = null;
  o.flags = o.flags.filter((f) => f.code !== "ai_update_available");
  o.version += 1;
  o.updated_at = nowIso();
  refreshStatus(o, thresholdsFor(project));
}

export function reviewItems(openings: OpeningRow[]) {
  const items: Record<string, unknown>[] = [];
  for (const o of openings) {
    if (o.verified) continue;
    for (const f of o.flags ?? []) {
      if (["warning", "error"].includes((FLAG_INFO[f.code] ?? ["warning"])[0])) items.push({ opening_id: o.id, ref: o.ref, tag: o.tag, type: o.type, ...f });
    }
  }
  const sev: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return sortedBy(items, (i) => [sev[i.severity as string] ?? 3, i.ref as string]);
}
