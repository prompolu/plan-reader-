/**
 * Parsing and formatting of architectural dimension notation.
 *
 * The parser never invents a value: it only converts text that is actually
 * present on the drawing. The original text is always preserved alongside the
 * normalised millimetre value.
 *
 *     900   2100   1200mm   90 cm   2.1m   1200 x 1500   900x2100
 *     3'-0"   6'-8"   3'-6 1/2"   36"   35 1/2"   4'-0" x 5'-0"
 */
import type { ParsedMeasurement } from "./types";
import { pyFixed, pyRound } from "./py";

export const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, ft_in: 25.4 };

const CHAR_MAP: Record<string, string> = {
  "′": "'",
  "″": '"',
  "’": "'",
  "‘": "'",
  "”": '"',
  "“": '"',
  "×": "x",
  "–": "-",
  "—": "-",
  "−": "-",
  " ": " ",
};

/** Character-for-character normalisation (keeps string length and offsets). */
export function normalizeChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    out += CHAR_MAP[c] ?? c;
  }
  return out;
}

const FT_IN = String.raw`(?<ft>\d{1,3})\s*'\s*(?:-\s*)?(?:(?<inch>\d{1,2}(?:\.\d+)?)(?:\s*[-\s]\s*(?<num>\d{1,2})\s*\/\s*(?<den>\d{1,2}))?|(?<fnum>\d{1,2})\s*\/\s*(?<fden>\d{1,2}))?\s*(?:"|'')?`;
const INCH = String.raw`(?:(?<iin>\d{1,3}(?:\.\d+)?)(?:\s*[-\s]\s*(?<inum>\d{1,2})\s*\/\s*(?<iden>\d{1,2}))?|(?<ifnum>\d{1,2})\s*\/\s*(?<ifden>\d{1,2}))\s*(?:"|'')`;
const METRIC_UNIT = String.raw`(?<mval>\d{1,6}(?:[.,]\d{1,3})?)\s*(?<munit>mm|cm|m)(?![a-zA-Z0-9²³])`;

export const RE_FT_IN = new RegExp(String.raw`(?<![\w.'"/])` + FT_IN, "g");
export const RE_INCH = new RegExp(String.raw`(?<![\w.'"/-])` + INCH, "g");
export const RE_METRIC_UNIT = new RegExp(String.raw`(?<![\w.,])` + METRIC_UNIT, "gi");
// a trailing/leading "x" is allowed so that "900x2100" parses as a pair
// decimals: "3.45" / "3,45" (metres) or "340.0" (centimetres); only read when the drawing uses m or cm
export const RE_PLAIN = new RegExp(String.raw`(?<![0-9A-WYZa-wyz_.,/:'"+\-#])(?:(?<pdec>\d{1,5}[.,]\d{1,3})|(?<pint>\d{2,5}))(?![0-9A-WYZa-wyz_.,/:'"%])`, "g");
export const RE_SCALE_METRIC = new RegExp(String.raw`(?<![\d.])1\s*:\s*(?<den>\d{1,5})(?!\d)`, "g");
export const RE_SCALE_IMPERIAL = new RegExp(String.raw`(?<paper>\d{1,2}(?:\s*[- ]\s*\d{1,2}\/\d{1,2})?|\d{1,2}\/\d{1,3})\s*(?:"|'')\s*=\s*(?<real>\d{1,3})\s*'\s*-?\s*0?\s*(?:"|'')?`, "g");
export const RE_LEVEL = new RegExp(String.raw`(?:(?:FFL|FL|RL|EL|LEVEL|TOS|SSL|SFL|T\.O\.)\.?\s*)?[+±-]\s*\d{1,3}[.,]\d{2,3}`, "gi");
const RE_PAIR_SEP = /^\s*[xX]\s*$/;

export class ParsedDimension {
  constructor(
    public valueMm: number,
    public unit: string,
    public unitExplicit: boolean,
    public system: "metric" | "imperial",
    public text: string,
  ) {}
  toDict(): ParsedMeasurement {
    return { value_mm: pyRound(this.valueMm, 2), unit: this.unit, unit_explicit: this.unitExplicit, system: this.system, original_text: this.text };
  }
}

export interface Expression {
  kind: "dim" | "pair" | "level" | "scale";
  start: number;
  end: number;
  text: string;
  dim?: ParsedDimension;
  pair?: [ParsedDimension, ParsedDimension];
  pairSpans?: [[number, number], [number, number]];
}

function frac(num?: string, den?: string): number {
  if (!num || !den) return 0;
  const d = parseInt(den, 10);
  if (d === 0) return 0;
  return parseInt(num, 10) / d;
}

function fromFtIn(g: Record<string, string | undefined>): number | null {
  const ft = parseInt(g.ft!, 10);
  let inches = 0;
  if (g.inch !== undefined) inches = parseFloat(g.inch) + frac(g.num, g.den);
  else if (g.fnum !== undefined) inches = frac(g.fnum, g.fden);
  if (inches >= 12) return null; // 3'-14" is not valid notation
  return (ft * 12 + inches) * 25.4;
}

function fromInch(g: Record<string, string | undefined>): number | null {
  let inches: number;
  if (g.iin !== undefined) inches = parseFloat(g.iin) + frac(g.inum, g.iden);
  else inches = frac(g.ifnum, g.ifden);
  return inches > 0 ? inches * 25.4 : null;
}

function* matches(rx: RegExp, s: string): Generator<RegExpExecArray> {
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    yield m;
  }
}

/**
 * Find dimension-like expressions in one text line.
 *
 * Scale notations ("1:100", '1/4" = 1'-0"') and level markers ("+2.700") are
 * recognised first so that they are never mistaken for opening sizes.
 */
export function findExpressions(text: string, defaultUnit = "mm"): Expression[] {
  const norm = normalizeChars(text);
  const taken = new Array<boolean>(norm.length).fill(false);
  const found: Expression[] = [];
  const free = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (taken[i]) return false;
    return true;
  };
  const take = (a: number, b: number) => {
    for (let i = a; i < b; i++) taken[i] = true;
  };

  for (const [rx, kind] of [
    [RE_SCALE_IMPERIAL, "scale"],
    [RE_SCALE_METRIC, "scale"],
    [RE_LEVEL, "level"],
  ] as const) {
    for (const m of matches(rx, norm)) {
      const a = m.index;
      const b = a + m[0].length;
      if (free(a, b)) {
        take(a, b);
        found.push({ kind, start: a, end: b, text: text.slice(a, b) });
      }
    }
  }

  const singles: Expression[] = [];

  for (const m of matches(RE_FT_IN, norm)) {
    const a = m.index;
    let b = a + m[0].length;
    while (b > a && norm[b - 1] === " ") b--;
    if (!free(a, b)) continue;
    const v = fromFtIn(m.groups!);
    if (v === null) continue;
    take(a, b);
    singles.push({ kind: "dim", start: a, end: b, text: text.slice(a, b), dim: new ParsedDimension(v, "ft_in", true, "imperial", text.slice(a, b)) });
  }

  for (const m of matches(RE_INCH, norm)) {
    const a = m.index;
    const b = a + m[0].length;
    if (!free(a, b)) continue;
    const v = fromInch(m.groups!);
    if (v === null) continue;
    take(a, b);
    singles.push({ kind: "dim", start: a, end: b, text: text.slice(a, b), dim: new ParsedDimension(v, "in", true, "imperial", text.slice(a, b)) });
  }

  for (const m of matches(RE_METRIC_UNIT, norm)) {
    const a = m.index;
    const b = a + m[0].length;
    if (!free(a, b)) continue;
    const unit = m.groups!.munit.toLowerCase();
    const val = parseFloat(m.groups!.mval.replace(",", "."));
    take(a, b);
    singles.push({ kind: "dim", start: a, end: b, text: text.slice(a, b), dim: new ParsedDimension(val * MM_PER_UNIT[unit], unit, true, "metric", text.slice(a, b)) });
  }

  for (const m of matches(RE_PLAIN, norm)) {
    const a = m.index;
    const b = a + m[0].length;
    if (!free(a, b)) continue;
    let val: number;
    let unit: string;
    if (m.groups!.pint !== undefined) {
      val = parseFloat(m.groups!.pint);
      unit = ["mm", "cm", "in"].includes(defaultUnit) ? defaultUnit : "mm";
    } else {
      const raw = m.groups!.pdec!;
      // a plain decimal is only a length on drawings dimensioned in metres ("3.45")
      // or centimetres ("340.0"); a millimetre or imperial drawing has none
      if (defaultUnit !== "m" && defaultUnit !== "cm") continue;
      const intDigits = raw.search(/[.,]/);
      // "3,450" on a metric drawing is a thousands separator, not metres
      if (raw.includes(",") && raw.length - intDigits - 1 === 3) continue;
      if (defaultUnit === "m" && intDigits > 2) continue; // 340.0 m is not a building dimension
      val = parseFloat(raw.replace(",", "."));
      unit = defaultUnit;
    }
    take(a, b);
    const system = unit === "in" ? "imperial" : "metric";
    singles.push({ kind: "dim", start: a, end: b, text: text.slice(a, b), dim: new ParsedDimension(val * MM_PER_UNIT[unit], unit, false, system, text.slice(a, b)) });
  }

  singles.sort((p, q) => p.start - q.start);
  // combine "A x B" into pairs
  let i = 0;
  while (i < singles.length) {
    const cur = singles[i];
    if (i + 1 < singles.length) {
      const nxt = singles[i + 1];
      const between = norm.slice(cur.end, nxt.start);
      if (RE_PAIR_SEP.test(between) && cur.dim && nxt.dim) {
        let first = cur.dim;
        if (!first.unitExplicit && nxt.dim.unitExplicit && nxt.dim.system === "metric") {
          // "120 x 150 cm": the unit written after the pair applies to both values
          const raw = first.valueMm / MM_PER_UNIT[first.unit];
          first = new ParsedDimension(raw * MM_PER_UNIT[nxt.dim.unit], nxt.dim.unit, true, "metric", first.text);
        }
        found.push({
          kind: "pair",
          start: cur.start,
          end: nxt.end,
          text: text.slice(cur.start, nxt.end),
          pair: [first, nxt.dim],
          pairSpans: [
            [cur.start, cur.end],
            [nxt.start, nxt.end],
          ],
        });
        i += 2;
        continue;
      }
    }
    found.push(cur);
    i += 1;
  }
  found.sort((p, q) => p.start - q.start);
  return found;
}

/** Parse text that should contain exactly one dimension. */
export function parseDimension(text: string, defaultUnit = "mm"): ParsedDimension | null {
  const exprs = findExpressions(text.trim(), defaultUnit).filter((e) => e.kind === "dim");
  if (exprs.length !== 1) return null;
  return exprs[0].dim ?? null;
}

/** Parse a size like '1200 x 1500' or 4'-0" x 5'-0" (width x height). */
export function parseSize(text: string, defaultUnit = "mm"): [ParsedDimension, ParsedDimension] | null {
  const exprs = findExpressions(text.trim(), defaultUnit).filter((e) => e.kind === "pair");
  if (exprs.length !== 1) return null;
  return exprs[0].pair ?? null;
}

// --- formatting -------------------------------------------------------------

export const DISPLAY_UNITS = ["original", "mm", "cm", "m", "ft_in"] as const;

function trim(x: number, nd: number): string {
  let s = pyFixed(x, nd);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export function formatFtIn(valueMm: number, denominator = 16): string {
  const totalIn = valueMm / 25.4;
  const n = pyRound(totalIn * denominator);
  const perFt = 12 * denominator;
  const ft = Math.floor(n / perFt);
  const rem = n - ft * perFt;
  const wholeIn = Math.floor(rem / denominator);
  const fracN = rem - wholeIn * denominator;
  let frac = "";
  if (fracN) {
    const g = gcd(fracN, denominator);
    frac = ` ${fracN / g}/${denominator / g}`;
  }
  return `${ft}'-${wholeIn}${frac}"`;
}

/** Format a normalised millimetre value for display (presentation only). */
export function formatLength(valueMm: number | null | undefined, unit: string, originalText?: string | null, withUnit = true): string {
  if (valueMm === null || valueMm === undefined || Number.isNaN(valueMm)) return "—";
  if (unit === "original" && originalText) return originalText;
  if (unit === "original" || unit === "mm") return `${pyRound(valueMm)}` + (withUnit ? " mm" : "");
  if (unit === "cm") return trim(valueMm / 10, 1) + (withUnit ? " cm" : "");
  if (unit === "m") return trim(valueMm / 1000, 3) + (withUnit ? " m" : "");
  if (unit === "ft_in" || unit === "in") return formatFtIn(valueMm);
  return `${pyRound(valueMm)} mm`;
}

/** Tolerance for comparing two sources of the same measurement. */
export function approxEqualMm(a: number, b: number, rel = 0.005, absMm = 3): boolean {
  return Math.abs(a - b) <= Math.max(absMm, rel * Math.max(Math.abs(a), Math.abs(b)));
}
