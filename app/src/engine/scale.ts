/**
 * Drawing scale parsing, detection and calibration.
 *
 * Supported notations: `1:50`, `1:100`, `1/4" = 1'-0"`, `3/16" = 1'-0"`,
 * `NTS` / `NOT TO SCALE`. A scale `ratio` is real length / paper length
 * (1:100 -> 100, 1/4" = 1'-0" -> 48).
 */
import { BBox, ScaleInfo, type DimensionAnnotation, type ScaleCheck, type TextLine } from "./types";
import { RE_SCALE_IMPERIAL, RE_SCALE_METRIC, normalizeChars } from "./units";
import { mean, median, minBy, pyRound } from "./py";

export const STANDARD_METRIC = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000];
export const STANDARD_IMPERIAL: [string, number][] = [
  ['1/16" = 1\'-0"', 192],
  ['3/32" = 1\'-0"', 128],
  ['1/8" = 1\'-0"', 96],
  ['3/16" = 1\'-0"', 64],
  ['1/4" = 1\'-0"', 48],
  ['3/8" = 1\'-0"', 32],
  ['1/2" = 1\'-0"', 24],
  ['3/4" = 1\'-0"', 16],
  ['1" = 1\'-0"', 12],
  ['1 1/2" = 1\'-0"', 8],
  ['3" = 1\'-0"', 4],
];

const RE_NTS = /\b(N\.?T\.?S\.?|NOT\s+TO\s+SCALE)\b/i;
const RE_SCALE_LABEL = /\bSCALE\b/i;

function firstMatch(rx: RegExp, s: string): RegExpExecArray | null {
  rx.lastIndex = 0;
  const m = rx.exec(s);
  rx.lastIndex = 0;
  return m;
}

function parseFraction(p: string): number {
  if (p.includes("/")) {
    const [a, b] = p.split("/");
    const n = parseInt(a, 10);
    const d = parseInt(b, 10);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) throw new Error("bad fraction");
    return n / d;
  }
  const v = parseInt(p, 10);
  if (!Number.isFinite(v)) throw new Error("bad number");
  return v;
}

/** Parse a scale notation. Returns [normalised text, ratio]. */
export function parseScale(text: string): [string, number] | null {
  const t = normalizeChars(text);
  let m = firstMatch(RE_SCALE_IMPERIAL, t);
  if (m) {
    const paper = m.groups!.paper.replace(/-/g, " ").trim();
    let paperIn = 0;
    try {
      for (const p of paper.split(/\s+/)) paperIn += parseFraction(p);
    } catch {
      return null;
    }
    const realIn = parseInt(m.groups!.real, 10) * 12;
    if (paperIn <= 0) return null;
    return [text.slice(m.index, m.index + m[0].length).trim(), realIn / paperIn];
  }
  m = firstMatch(RE_SCALE_METRIC, t);
  if (m) {
    const den = parseInt(m.groups!.den, 10);
    if (den <= 0) return null;
    return [`1:${den}`, den];
  }
  return null;
}

export function formatRatio(ratio: number, imperial = false): string {
  if (imperial) {
    for (const [text, r] of STANDARD_IMPERIAL) if (Math.abs(r - ratio) < 0.01) return text;
  }
  if (Math.abs(ratio - Math.round(ratio)) < 1e-6) return `1:${Math.round(ratio)}`;
  return `1:${pyRound(ratio, 2).toFixed(2)}`;
}

export interface ScaleMention {
  text: string;
  ratio: number | null;
  nts: boolean;
  labelled: boolean;
  bbox: BBox;
  line: TextLine;
}

/** All scale notations on a page, with a hint whether they are labelled. */
export function findScaleMentions(lines: TextLine[]): ScaleMention[] {
  const out: ScaleMention[] = [];
  for (const ln of lines) {
    const parsed = parseScale(ln.text);
    const nts = RE_NTS.exec(ln.text);
    if (!parsed && !nts) continue;
    let labelled = RE_SCALE_LABEL.test(ln.text);
    if (!labelled) {
      // a "SCALE" label may be a separate text line just left of / above the value
      for (const other of lines) {
        if (other === ln || !RE_SCALE_LABEL.test(other.text)) continue;
        if (other.bbox.distanceTo(ln.bbox) < 3 * Math.max(ln.size, 1)) {
          labelled = true;
          break;
        }
      }
    }
    out.push({ text: parsed ? parsed[0] : nts![0], ratio: parsed ? parsed[1] : null, nts: parsed === null, labelled, bbox: ln.bbox, line: ln });
  }
  return out;
}

/**
 * Estimate the scale ratio from dimension lines whose drawn length is known.
 * Returns [ratio, n_supporting, agreement] or null.
 */
export function calibrateFromDimensions(dims: DimensionAnnotation[], mmPerUnit: number | null): [number, number, number] | null {
  if (!mmPerUnit) return null;
  const ratios: number[] = [];
  for (const d of dims) {
    if (d.span === null || d.kind !== "linear") continue;
    const paperMm = Math.abs(d.span[1] - d.span[0]) * mmPerUnit;
    if (paperMm < 2) continue;
    ratios.push(d.valueMm / paperMm);
  }
  if (ratios.length < 3) return null;
  const med = median(ratios);
  const support = ratios.filter((r) => Math.abs(r - med) / med < 0.02);
  const agreement = support.length / ratios.length;
  if (support.length < 3) return null;
  let est = mean(support);
  const candidates = [...STANDARD_METRIC, ...STANDARD_IMPERIAL.map(([, r]) => r)];
  const best = minBy(candidates, (c) => Math.abs(c - est) / c);
  if (Math.abs(best - est) / best < 0.01) est = best;
  return [est, support.length, agreement];
}

/** Compare a dimension's text value with its drawn length at the given scale. */
export function scaleCheck(d: DimensionAnnotation, ratio: number | null, mmPerUnit: number | null): ScaleCheck | null {
  if (ratio === null || mmPerUnit === null || d.span === null) return null;
  const drawnPaperMm = Math.abs(d.span[1] - d.span[0]) * mmPerUnit;
  const measuredReal = drawnPaperMm * ratio;
  if (d.valueMm <= 0) return null;
  const rel = Math.abs(measuredReal - d.valueMm) / d.valueMm;
  return { scale_ratio: ratio, drawn_length_mm: pyRound(measuredReal, 1), relative_error: pyRound(rel, 4), consistent: rel <= 0.03 };
}

export function noScale(): ScaleInfo {
  return new ScaleInfo(null, null, "none", 0);
}
