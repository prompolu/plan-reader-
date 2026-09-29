/**
 * The storage layer keeps everything in English. These helpers translate what
 * the local API hands to the screens: labels, review flags, evidence, history
 * and schedule text. Values quoted from the drawings (tags, sheet numbers,
 * dimension text, schedule and view titles) are left as written.
 */
import { num, tx } from "../i18n";
import type { toDict } from "./openings";

type Dict = Record<string, unknown>;
type OpeningOut = ReturnType<typeof toDict>;

function flag<T extends { label?: unknown; message?: unknown }>(f: T): T {
  return { ...f, label: tx(f.label as string), message: tx(f.message as string) };
}

function evidence<T extends { label?: unknown; detail?: unknown }>(e: T): T {
  return { ...e, label: tx(e.label as string), detail: e.detail ? tx(e.detail as string) : e.detail };
}

function measurement<T extends Dict | null>(m: T): T {
  if (!m) return m;
  return { ...m, evidence: ((m.evidence as Dict[] | undefined) ?? []).map(evidence) };
}

export function locOpening(o: OpeningOut): OpeningOut {
  return {
    ...o,
    type_label: tx(o.type_label),
    flags: o.flags.map(flag),
    evidence: o.evidence.map(evidence),
    width: measurement(o.width as unknown as Dict | null) as unknown as OpeningOut["width"],
    height: measurement(o.height as unknown as Dict | null) as unknown as OpeningOut["height"],
    references: o.references.map((r) => ({ ...r, note: r.note ? tx(r.note as string) : r.note })),
  };
}

export function locReviewItem<T extends Dict>(i: T): T {
  return flag(i as T & { label?: unknown; message?: unknown });
}

export function locAuditMessage(message: string): string {
  return tx(message);
}

interface JobLike {
  steps: Record<string, { label: string; status: string; detail: string | null }>;
  message: string | null;
  error: string | null;
}

export function locJob<T extends JobLike>(j: T): T {
  const steps: JobLike["steps"] = {};
  for (const [k, s] of Object.entries(j.steps ?? {})) steps[k] = { ...s, label: tx(s.label), detail: s.detail ? tx(s.detail) : s.detail };
  return { ...j, steps, message: j.message ? tx(j.message) : j.message, error: j.error ? tx(j.error) : j.error };
}

interface ScheduleLike {
  unit: string;
  groups: { title: string; rows: { type_label: string; width: string; height: string; width_status: string; height_status: string }[] }[];
}

export function locSchedule<T extends ScheduleLike>(s: T): T {
  const decimals = s.unit === "cm" || s.unit === "m";
  const text = (v: string, status: string) => (status === "conflict" || status === "missing" ? tx(v) : decimals ? num(v) : v);
  return {
    ...s,
    groups: s.groups.map((g) => ({
      ...g,
      title: tx(g.title),
      rows: g.rows.map((r) => ({ ...r, type_label: tx(r.type_label), width: text(r.width, r.width_status), height: text(r.height, r.height_status) })),
    })),
  };
}

/** Label maps (opening types, page types) in the current language. */
export function locLabels(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, tx(v)]));
}
