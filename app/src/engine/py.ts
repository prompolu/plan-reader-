/**
 * Small helpers that reproduce Python semantics the extraction rules were
 * written and tuned with (rounding, str.title, stable min/max, statistics).
 */

/** Python's round(): half-to-even on exact ties, correct decimal rounding otherwise. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  if (nd === 0) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  const m = 10 ** nd;
  const y = x * m;
  const f = Math.floor(y);
  // an exact tie only happens when x is exactly representable with nd+1 decimals ending in 5
  if (y - f === 0.5 && Number((f + 0.5) / m) === x) return (f % 2 === 0 ? f : f + 1) / m;
  return Number(x.toFixed(nd));
}

/** Python's f"{x:.{nd}f}". */
export function pyFixed(x: number, nd = 0): string {
  const r = pyRound(x, nd);
  const s = r.toFixed(nd);
  return s === "-0" || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/** Python's f"{x:.0%}". */
export function pyPercent(x: number, nd = 0): string {
  return `${pyFixed(x * 100, nd)}%`;
}

/** Python's str.title(). */
export function pyTitle(s: string): string {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const cased = lower !== upper;
    if (cased) out += prevCased ? lower : upper;
    else out += ch;
    prevCased = cased;
  }
  return out;
}

export function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

export function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  if (!xs.length) throw new Error("mean of empty list");
  return sum(xs) / xs.length;
}

export function median(xs: number[]): number {
  if (!xs.length) throw new Error("median of empty list");
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** First element with the smallest key (Python min(key=...)). */
export function minBy<T>(xs: readonly T[], key: (x: T) => number): T {
  if (!xs.length) throw new Error("minBy of empty list");
  let best = xs[0];
  let bk = key(best);
  for (let i = 1; i < xs.length; i++) {
    const k = key(xs[i]);
    if (k < bk) {
      best = xs[i];
      bk = k;
    }
  }
  return best;
}

/** First element with the largest key (Python max(key=...)). */
export function maxBy<T>(xs: readonly T[], key: (x: T) => number): T {
  if (!xs.length) throw new Error("maxBy of empty list");
  let best = xs[0];
  let bk = key(best);
  for (let i = 1; i < xs.length; i++) {
    const k = key(xs[i]);
    if (k > bk) {
      best = xs[i];
      bk = k;
    }
  }
  return best;
}

export type Tuple = (number | string)[];

/** Lexicographic comparison of key tuples (Python tuple ordering). */
export function cmpTuple(a: Tuple, b: Tuple): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

/** Stable sort by a key tuple (Python sorted(key=...)). */
export function sortedBy<T>(xs: readonly T[], key: (x: T) => Tuple | number): T[] {
  const keyed = xs.map((x, i) => ({ x, i, k: key(x) }));
  keyed.sort((p, q) => {
    const c = typeof p.k === "number" && typeof q.k === "number" ? p.k - q.k : cmpTuple(Array.isArray(p.k) ? p.k : [p.k], Array.isArray(q.k) ? q.k : [q.k]);
    return c !== 0 ? c : p.i - q.i;
  });
  return keyed.map((k) => k.x);
}

/** Python's sorted() of strings (code-point order). */
export function sortedStrings(xs: Iterable<string>): string[] {
  return [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class DefaultMap<K, V> extends Map<K, V> {
  constructor(private readonly factory: () => V) {
    super();
  }
  get(k: K): V {
    let v = super.get(k);
    if (v === undefined) {
      v = this.factory();
      this.set(k, v);
    }
    return v;
  }
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export function zipPairs<T>(xs: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i + 1 < xs.length; i++) out.push([xs[i], xs[i + 1]]);
  return out;
}

export function degrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Python's modulo (result has the sign of the divisor). */
export function pmod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
