/**
 * Accuracy benchmark scoring: compares extraction records with the ground
 * truth written by the synthetic drawing generator (tools/drawing-generator).
 *
 * The numbers describe that synthetic dataset only - not accuracy on
 * arbitrary real-world drawings.
 */
import type { OpeningRecord } from "./crossref";
import { parseTag } from "./tags";
import { BBox } from "./types";
import { approxEqualMm, parseDimension } from "./units";
import { pyRound } from "./py";

export class Counter {
  correct = 0;
  total = 0;
  add(ok: boolean): void {
    this.total++;
    this.correct += ok ? 1 : 0;
  }
  get rate(): number | null {
    return this.total ? this.correct / this.total : null;
  }
  toDict() {
    return { correct: this.correct, total: this.total, rate: this.rate !== null ? pyRound(this.rate, 4) : null };
  }
}

const COUNTERS = ["tag", "width", "height", "association", "quantity", "typeKind", "flags", "duplicates"] as const;

export class Metrics {
  detTp = 0;
  detFn = 0;
  detFp = 0;
  tag = new Counter();
  width = new Counter();
  height = new Counter();
  association = new Counter();
  quantity = new Counter();
  typeKind = new Counter();
  flags = new Counter();
  duplicates = new Counter();
  fabricated = 0;
  errors: string[] = [];

  merge(o: Metrics): void {
    this.detTp += o.detTp;
    this.detFn += o.detFn;
    this.detFp += o.detFp;
    for (const k of COUNTERS) {
      this[k].correct += o[k].correct;
      this[k].total += o[k].total;
    }
    this.fabricated += o.fabricated;
    this.errors.push(...o.errors);
  }

  toDict() {
    const p = this.detTp + this.detFp ? this.detTp / (this.detTp + this.detFp) : null;
    const r = this.detTp + this.detFn ? this.detTp / (this.detTp + this.detFn) : null;
    return {
      opening_detection: { true_positives: this.detTp, false_negatives: this.detFn, false_positives: this.detFp, precision: p !== null ? pyRound(p, 4) : null, recall: r !== null ? pyRound(r, 4) : null },
      tag_detection: this.tag.toDict(),
      width_extraction: this.width.toDict(),
      height_extraction: this.height.toDict(),
      dimension_association: this.association.toDict(),
      quantity_and_duplicates: this.quantity.toDict(),
      duplicate_flagging: this.duplicates.toDict(),
      opening_type: this.typeKind.toDict(),
      expected_review_flags: this.flags.toDict(),
      fabricated_measurements: this.fabricated,
      errors: this.errors.slice(0, 50),
    };
  }
}

export interface TruthInstance {
  page_index: number;
  tag: string | null;
  kind: string;
  counted: boolean;
  gap_bbox: [number, number, number, number];
  width_dim_text: string | null;
}

export interface TruthType {
  tag: string | null;
  kind: string;
  quantity: number;
  in_schedule: boolean;
  width_status: string;
  width_expected: number | null;
  height_status: string;
  height_expected: number | null;
  expected_flags: string[];
}

export interface GroundTruth {
  instances: TruthInstance[];
  types: TruthType[];
  [k: string]: unknown;
}

function key(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const p = parseTag(tag);
  return p ? p[1] : tag;
}

function num(t: string): number {
  const p = parseDimension(t);
  return p ? p.valueMm : -1;
}

type Meas = OpeningRecord["width"];

/** Returns [correct, fabricated]. */
function matchMeasure(status: string, value: number | null, m: Meas): [boolean, boolean] {
  if (status === "missing") return [m === null, !!(m && m.status === "explicit")];
  if (status === "conflict") return [!!(m && m.status === "conflict"), false];
  if (status === "inferred") {
    const ok = !!(m && m.status === "inferred" && m.value !== null && Math.abs(m.value - value!) <= Math.max(15, 0.03 * value!));
    return [ok, !!(m && m.status === "explicit")];
  }
  return [!!(m && m.status === "explicit" && m.value !== null && approxEqualMm(m.value, value!)), false];
}

function fmt(m: Meas): string {
  return m === null ? "missing" : `${m.status} ${m.value}`;
}

export function evaluate(g: GroundTruth, records: OpeningRecord[]): Metrics {
  const m = new Metrics();
  // ---- instance detection on floor plans ----
  const sysInst: [OpeningRecord, OpeningRecord["instances"][number]][] = [];
  for (const r of records) for (const inst of r.instances) sysInst.push([r, inst]);
  const used = new Set<number>();
  for (const gi of g.instances) {
    if (!gi.counted) continue;
    const gb = BBox.fromPoints(...gi.gap_bbox);
    let best: [number, number] | null = null;
    sysInst.forEach(([, inst], k) => {
      if (used.has(k) || inst.page_index !== gi.page_index) return;
      const b = BBox.fromDict(inst.bbox);
      const ov = b.intersectionArea(gb.expand(1));
      if (ov <= 0 && !b.expand(2).containsPoint(gb.cx, gb.cy)) return;
      const score = ov / Math.max(gb.area, 1e-6);
      if (best === null || score > best[0]) best = [score, k];
    });
    if (best === null) {
      m.detFn++;
      m.errors.push(`missed ${gi.tag} (${gi.kind}) on page ${gi.page_index + 1}`);
      continue;
    }
    const bk = (best as [number, number])[1];
    used.add(bk);
    m.detTp++;
    const inst = sysInst[bk][1];
    m.tag.add(key(inst.tag_text) === key(gi.tag));
    if (key(inst.tag_text) !== key(gi.tag)) m.errors.push(`tag ${inst.tag_text} != ${gi.tag} on page ${gi.page_index + 1}`);
    let okAssoc = (inst.width_text || null) === (gi.width_dim_text || null);
    if (!okAssoc && inst.width_text && gi.width_dim_text) okAssoc = approxEqualMm(num(inst.width_text), num(gi.width_dim_text));
    m.association.add(okAssoc);
    if (!okAssoc) m.errors.push(`association ${gi.tag} p${gi.page_index + 1}: got ${inst.width_text ?? null} expected ${gi.width_dim_text}`);
  }
  sysInst.forEach(([r, inst], k) => {
    if (!used.has(k) && !inst.geometry_missing) {
      m.detFp++;
      m.errors.push(`false positive ${r.type} ${inst.tag_text} on page ${inst.page_index + 1}`);
    }
  });

  // ---- type-level ----
  const byKey = new Map<string, OpeningRecord>();
  for (const r of records) if (r.tag_key) byKey.set(r.tag_key, r);
  for (const t of g.types) {
    if (!t.tag) continue;
    if (t.quantity === 0 && !t.in_schedule) continue;
    const r = byKey.get(key(t.tag)!);
    if (!r) {
      m.errors.push(`type ${t.tag} not reported`);
      for (const c of [m.width, m.height, m.quantity, m.typeKind]) c.add(false);
      continue;
    }
    const [okW, fabW] = matchMeasure(t.width_status, t.width_expected, r.width);
    const [okH, fabH] = matchMeasure(t.height_status, t.height_expected, r.height);
    m.width.add(okW);
    m.height.add(okH);
    m.fabricated += Number(fabW) + Number(fabH);
    if (!okW) m.errors.push(`${t.tag} width: expected ${t.width_status} ${t.width_expected}, got ${fmt(r.width)}`);
    if (!okH) m.errors.push(`${t.tag} height: expected ${t.height_status} ${t.height_expected}, got ${fmt(r.height)}`);
    m.quantity.add(r.quantity === t.quantity);
    if (r.quantity !== t.quantity) m.errors.push(`${t.tag} quantity ${r.quantity} expected ${t.quantity}`);
    m.typeKind.add(r.type === t.kind);
    if (r.type !== t.kind) m.errors.push(`${t.tag} type ${r.type} expected ${t.kind}`);
    const got = new Set(r.flags.map((f) => f.code));
    for (const ef of t.expected_flags) {
      const equiv = ef === "dimension_conflict" ? ["dimension_conflict", "schedule_conflict"] : [ef];
      const ok = equiv.some((e) => got.has(e));
      if (ef === "possible_duplicate") m.duplicates.add(ok);
      m.flags.add(ok);
      if (!ok) m.errors.push(`${t.tag} missing flag ${ef}`);
    }
  }
  return m;
}

export function markdownReport(rep: { disclaimer: string; vector: ReturnType<Metrics["toDict"]> | null; raster: ReturnType<Metrics["toDict"]> | null }): string {
  const row = (label: string, d: { correct: number; total: number; rate: number | null }) =>
    d.rate !== null ? `| ${label} | ${d.correct}/${d.total} | ${(d.rate * 100).toFixed(1)}% |\n` : `| ${label} | 0/0 | – |\n`;
  let out = "# PlanMeasure AI – extraction benchmark\n\n";
  out += `> ${rep.disclaimer}\n\n`;
  for (const kind of ["vector", "raster"] as const) {
    const m = rep[kind];
    if (!m) continue;
    const od = m.opening_detection;
    out += `## ${kind === "vector" ? "Vector PDF sets" : "Rasterised floor plans (OCR path)"}\n\n`;
    out += "| Metric | Correct / total | Rate |\n|---|---|---|\n";
    if (od.recall !== null) out += `| Opening detection – recall | ${od.true_positives}/${od.true_positives + od.false_negatives} | ${(od.recall * 100).toFixed(1)}% |\n`;
    if (od.precision !== null) out += `| Opening detection – precision | ${od.true_positives}/${od.true_positives + od.false_positives} | ${(od.precision * 100).toFixed(1)}% |\n`;
    out += row("Tag detection", m.tag_detection);
    out += row("Width extraction (value + status)", m.width_extraction);
    out += row("Height extraction (value + status)", m.height_extraction);
    out += row("Dimension association", m.dimension_association);
    out += row("Quantity (duplicate-safe counting)", m.quantity_and_duplicates);
    out += row("Duplicate flagging", m.duplicate_flagging);
    out += row("Opening type", m.opening_type);
    out += row("Expected review flags raised", m.expected_review_flags);
    out += `| Fabricated measurements | ${m.fabricated_measurements} | must be 0 |\n\n`;
    if (m.errors.length) out += "<details><summary>First errors</summary>\n\n" + m.errors.slice(0, 30).map((e) => `- ${e}`).join("\n") + "\n\n</details>\n\n";
  }
  return out;
}
