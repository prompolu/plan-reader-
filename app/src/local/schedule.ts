/**
 * Measurement schedule generation (used by the UI, print view and PDF export).
 * Always built from the current stored state, i.e. the final user-edited and
 * verified values - never from a stale AI snapshot.
 */
import { OPENING_TYPE_LABELS } from "../engine/types";
import { formatLength } from "../engine/units";
import { sortedBy, type Tuple } from "../engine/py";
import type { MeasurementRow, OpeningRow } from "./db";

const FAMILIES: [string, string, Set<string>][] = [
  ["windows", "WINDOW SCHEDULE", new Set(["window", "sliding_window", "curtain_wall"])],
  ["doors", "DOOR SCHEDULE", new Set(["door", "double_door", "sliding_door", "garage_door"])],
  ["other", "OTHER OPENINGS", new Set(["opening", "other"])],
];
export const GROUP_BY = ["type", "tag", "size", "page", "floor"] as const;

export function measurementText(m: MeasurementRow | null, unit: string): [string, string] {
  if (m === null) return ["Needs review", "missing"];
  const st = m.status;
  if (st === "conflict") {
    const vals = ((m.candidates as Record<string, unknown>[]) ?? []).map((c) => `${c.original_text} (${c.label})`).join(" / ");
    return [`Conflict: ${vals}`, "conflict"];
  }
  const txt = formatLength(m.value, unit, m.original_text);
  if (st === "inferred") return [`${txt}*`, "inferred"];
  return [txt, st || "explicit"];
}

function natural(tag: string | null): Tuple {
  if (!tag) return ["~", 10 ** 9, ""];
  const m = /^([A-Za-z]+)\D*(\d+)(.*)/.exec(tag);
  return m ? [m[1].toUpperCase(), parseInt(m[2], 10), m[3]] : [tag, 0, ""];
}

export interface ScheduleRow {
  id: string;
  ref: string;
  tag: string;
  type: string;
  type_label: string;
  width: string;
  height: string;
  width_mm: number | null;
  height_mm: number | null;
  width_status: string;
  height_status: string;
  quantity: number;
  sheets: string[];
  drawing_reference: string;
  floor: string;
  room: string;
  status: string;
  verified: boolean;
  notes: string;
  open_flags: string[];
}

export function rowFor(o: OpeningRow, unit: string): ScheduleRow {
  const [wt, ws] = measurementText(o.width, unit);
  const [ht, hs] = measurementText(o.height, unit);
  let sheets: string[] = [];
  for (const inst of o.instances ?? []) {
    const s = inst.sheet as string | undefined;
    if (s && !sheets.includes(s)) sheets.push(s);
  }
  if (!sheets.length && o.drawing_reference) sheets = [o.drawing_reference];
  return {
    id: o.id,
    ref: o.ref,
    tag: o.tag || "—",
    type: o.type,
    type_label: OPENING_TYPE_LABELS[o.type] ?? o.type,
    width: wt,
    height: ht,
    width_mm: o.width?.value ?? null,
    height_mm: o.height?.value ?? null,
    width_status: ws,
    height_status: hs,
    quantity: o.quantity ?? 0,
    sheets,
    drawing_reference: sheets.length ? sheets.join(", ") : "—",
    floor: o.floor || "",
    room: o.room || "",
    status: o.status,
    verified: o.verified,
    notes: o.notes || "",
    open_flags: !o.verified ? (o.flags ?? []).filter((f) => f.severity === "warning" || f.severity === "error").map((f) => f.label) : [],
  };
}

export interface ScheduleGroup {
  key: string;
  title: string;
  rows: ScheduleRow[];
  total_quantity: number;
}

export function buildSchedule(openings: OpeningRow[], groupBy = "type", unit = "mm", includeUnverified = true) {
  if (!(GROUP_BY as readonly string[]).includes(groupBy)) groupBy = "type";
  const ops = sortedBy(
    openings.filter((o) => o.deleted_at === null && (includeUnverified || o.verified)),
    (o) => [...natural(o.tag), o.ref],
  );
  const groups: Omit<ScheduleGroup, "total_quantity">[] = [];

  if (groupBy === "type") {
    for (const [key, title, kinds] of FAMILIES) {
      const rows = ops.filter((o) => kinds.has(o.type)).map((o) => rowFor(o, unit));
      if (rows.length) groups.push({ key, title, rows });
    }
  } else if (groupBy === "tag") {
    const rows = ops.map((o) => rowFor(o, unit));
    if (rows.length) groups.push({ key: "all", title: "OPENING SCHEDULE", rows });
  } else if (groupBy === "size") {
    for (const [key, title, kinds] of FAMILIES) {
      const merged = new Map<string, ScheduleRow>();
      for (const o of ops) {
        if (!kinds.has(o.type)) continue;
        const r = rowFor(o, unit);
        const k = `${r.width}\u0000${r.height}\u0000${r.type}`;
        const m = merged.get(k);
        if (m) {
          m.tag = `${m.tag}, ${r.tag}`;
          m.quantity += r.quantity;
          m.sheets = [...new Set([...m.sheets, ...r.sheets])];
          m.drawing_reference = m.sheets.join(", ") || "—";
          m.verified = m.verified && r.verified;
          m.open_flags = [...m.open_flags, ...r.open_flags];
        } else merged.set(k, { ...r, sheets: [...r.sheets], open_flags: [...r.open_flags] });
      }
      const rows = sortedBy([...merged.values()], (r) => [r.width_mm ?? 0, r.height_mm ?? 0]);
      if (rows.length) groups.push({ key, title: `${title} — BY SIZE`, rows });
    }
  } else {
    // page / floor: quantities split by where the instances are
    const attr = groupBy === "page" ? "sheet" : "floor";
    const unknownLabel = attr === "sheet" ? "Unknown sheet" : "Floor not identified";
    const buckets = new Map<string, ScheduleRow[]>();
    for (const o of ops) {
      const counts = new Map<string, number>();
      for (const inst of o.instances ?? []) {
        if (inst.counted ?? true) {
          const label = (inst[attr] as string) || unknownLabel;
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
      }
      if (!counts.size) counts.set((attr === "sheet" ? o.drawing_reference : o.floor) || unknownLabel, o.quantity ?? 0);
      for (const [label, n] of counts) {
        const r = rowFor(o, unit);
        r.quantity = n;
        if (!buckets.has(label)) buckets.set(label, []);
        buckets.get(label)!.push(r);
      }
    }
    for (const label of sortedBy([...buckets.keys()], (s) => [s.startsWith("Unknown") || s.startsWith("Floor not") ? 1 : 0, s])) {
      groups.push({ key: label, title: label.toUpperCase(), rows: buckets.get(label)! });
    }
  }
  const out: ScheduleGroup[] = groups.map((g) => ({ ...g, total_quantity: g.rows.reduce((a, r) => a + r.quantity, 0) }));
  return {
    group_by: groupBy,
    unit,
    groups: out,
    total_openings: groupBy !== "page" && groupBy !== "floor" ? out.reduce((a, g) => a + g.total_quantity, 0) : ops.reduce((a, o) => a + (o.quantity ?? 0), 0),
    unverified_count: ops.filter((o) => !o.verified).length,
    needs_review_count: ops.filter((o) => o.status === "needs_review").length,
    has_inferred: out.some((g) => g.rows.some((r) => r.width_status === "inferred" || r.height_status === "inferred")),
  };
}

export type Schedule = ReturnType<typeof buildSchedule>;
