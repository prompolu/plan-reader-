/**
 * Dimension detection.
 *
 * A linear dimension is recognised from its *geometry*, not just its text:
 * dimension text -> dimension line parallel to the text, just beside it ->
 * terminators on that line (ticks / arrows / dots / extension-line crossings)
 * on both sides of the text -> the span between the nearest terminators ->
 * extension lines at the span ends.
 *
 * Numbers that are not attached to a dimension line (room numbers, notes,
 * areas) are not treated as dimensions. Size callouts ("1200 x 1500") are kept
 * as callouts and only used when they sit next to an opening tag.
 */
import { SegmentIndex } from "./geometry";
import type { DetectionContext } from "./context";
import { scaleCheck } from "./scale";
import { TAG_PREFIXES, tagMatches } from "./tags";
import { BBox, Segment, newDimension, type Axis, type DimensionAnnotation, type FilledShape, type PageClassification, type PageData, type TextLine, type View } from "./types";
import { findExpressions, normalizeChars } from "./units";
import { viewOf } from "./views";
import { DefaultMap, maxBy, pyFixed, pyRound, sortedBy } from "./py";

const DIMENSIONED_VIEWS = new Set(["floor_plan", "elevation", "section", "detail", "site_plan"]);

function unitBasis(explicit: boolean, cls: PageClassification): string {
  if (explicit) return "explicit";
  return ({ note: "note", scale: "scale", notation: "notation" } as Record<string, string>)[cls.unitBasis] ?? "assumed";
}

type Term = [number, string, Segment | null];
type Resolved = [number, number, Term[], Segment[], number, boolean];

export class LinearDimensionDetector {
  readonly name = "linear-dimensions";
  private fills: FilledShape[] = [];

  /** `exclude`: segments that are not dimension graphics (e.g. tag symbols). */
  constructor(private readonly exclude: Set<Segment> = new Set()) {}

  /** Returns [dimensions, segments that belong to dimension annotations]. */
  detect(page: PageData, views: View[], cls: PageClassification, ctxFor: (v: View) => DetectionContext): [DimensionAnnotation[], Set<Segment>] {
    const tb = cls.titleBlock;
    const segs = page.geometry.segments.filter((s) => !this.exclude.has(s));
    this.fills = page.geometry.fills;
    const cell = Math.max(page.width, page.height) / 120;
    const idx = new SegmentIndex(segs, cell);
    const dims: DimensionAnnotation[] = [];
    const used = new Set<Segment>();
    let n = 0;
    for (const ln of page.lines) {
      if (tb !== null && tb.contains(ln.bbox, 2)) continue;
      const view = viewOf(views, ln.bbox);
      if (view === null || !DIMENSIONED_VIEWS.has(view.viewType)) continue;
      const exprs = findExpressions(ln.text, cls.defaultUnit);
      if (!exprs.length) continue;
      const hasTag = [...tagMatches(normalizeChars(ln.text))].some((m) => m.groups!.prefix in TAG_PREFIXES);
      ctxFor(view);
      for (const e of exprs) {
        if (e.kind === "dim" && e.dim) {
          const tbBox = ln.subBBox(e.start, e.end);
          const d = newDimension({
            id: `p${page.index}-d${n}`,
            pageIndex: page.index,
            text: e.text,
            valueMm: e.dim.valueMm,
            unit: e.dim.unit,
            unitExplicit: e.dim.unitExplicit,
            unitBasis: unitBasis(e.dim.unitExplicit, cls),
            textBBox: tbBox,
            textAngle: ln.angle,
            kind: "linear",
            confidence: ln.source === "pdf" ? 0.92 : 0.9 * ln.confidence,
            source: ln.source,
            viewId: view.id,
          });
          const ok = this.attachLine(d, ln, idx, used, view.scale.ratio, page.mmPerUnit);
          if (ok) {
            const chk = scaleCheck(d, view.scale.ratio, page.mmPerUnit);
            d.scaleCheck = chk;
            if (chk !== null) {
              if (chk.consistent) d.confidence = Math.min(0.99, d.confidence + 0.04);
              else {
                d.confidence *= 0.85;
                d.notes.push(`Drawn length measures ${pyFixed(chk.drawn_length_mm, 0)} mm at ${view.scale.text || "the drawing scale"}; text says ${pyFixed(d.valueMm, 0)} mm`);
              }
            }
            dims.push(d);
            n++;
          } else if (hasTag) {
            // a single size written on the same line as a tag, e.g. "D-01 900"
            d.kind = "callout";
            d.confidence *= 0.8;
            d.notes.push("Number written beside a tag (no dimension line)");
            dims.push(d);
            n++;
          }
        } else if (e.kind === "pair" && e.pair) {
          const pid = `p${page.index}-c${n}`;
          const spans = e.pairSpans ?? [
            [e.start, e.end],
            [e.start, e.end],
          ];
          (["width", "height"] as const).forEach((role, k) => {
            const pd = e.pair![k];
            const [a, b] = spans[k];
            dims.push(
              newDimension({
                id: `p${page.index}-d${n}`,
                pageIndex: page.index,
                text: e.text,
                valueMm: pd.valueMm,
                unit: pd.unit,
                unitExplicit: pd.unitExplicit,
                unitBasis: unitBasis(pd.unitExplicit, cls),
                textBBox: ln.subBBox(a, b),
                textAngle: ln.angle,
                kind: "callout",
                confidence: ln.source === "pdf" ? 0.9 : 0.88 * ln.confidence,
                source: ln.source,
                viewId: view.id,
                pairRole: role,
                pairId: pid,
              }),
            );
            n++;
          });
        }
      }
    }
    chains(dims);
    return [dims, used];
  }

  // -------------------------------------------------------------------------

  private attachLine(d: DimensionAnnotation, ln: TextLine, idx: SegmentIndex, used: Set<Segment>, ratio: number | null = null, mpu: number | null = null): boolean {
    const axis = ln.axis;
    if (axis === null) return false;
    const tb = d.textBBox;
    const size = Math.max(ln.size, 1);
    const cAlong = axis === "h" ? tb.cx : tb.cy;
    const cAcross = axis === "h" ? tb.cy : tb.cx;
    const halfLen = (axis === "h" ? tb.w : tb.h) / 2;
    const reach = 2.4 * size;
    const tol = Math.max(0.4, 0.12 * size);
    const q = BBox.fromPoints(tb.x0 - reach, tb.y0 - reach, tb.x1 + reach, tb.y1 + reach);
    // candidate dimension-line pieces: parallel, close to the text, overlapping it along the axis
    const pieces: Segment[] = [];
    for (const s of idx.query(q.expand(3 * size))) {
      if (s.orientation(1.5) !== axis || s.dashed) continue;
      const off = s.crossCoord(axis) - cAcross;
      if (Math.abs(off) > reach) continue;
      if (Math.abs(off) < 0.3 * size) {
        // a line through the text is only a dimension line if it is broken around the text
        const [lo, hi] = s.axisRange(axis);
        if (lo < cAlong + 0.8 * halfLen && hi > cAlong - 0.8 * halfLen) continue;
      }
      pieces.push(s);
    }
    if (!pieces.length) return false;
    // evaluate every candidate line position: terminator quality, distance and
    // (when the scale is known) agreement between drawn length and written value
    const byPos = new DefaultMap<number, Segment[]>(() => []);
    for (const s of pieces) byPos.get(pyRound(s.crossCoord(axis) / tol)).push(s);
    const options: [number, number, Resolved][] = [];
    for (const items of byPos.values()) {
      const pos = items.reduce((a, s) => a + s.crossCoord(axis), 0) / items.length;
      const lo = Math.min(...items.map((s) => s.axisRange(axis)[0]));
      const hi = Math.max(...items.map((s) => s.axisRange(axis)[1]));
      if (!(lo <= cAlong - 0.3 * halfLen && hi >= cAlong + 0.3 * halfLen)) continue;
      const res = this.resolve(axis, pos, cAlong, halfLen, size, tol, idx);
      if (res === null) continue;
      const [p0, p1] = res;
      let score = res[4] - (0.15 * Math.abs(pos - cAcross)) / size;
      if (ratio && mpu && d.valueMm > 0) {
        const rel = Math.abs((p1 - p0) * mpu * ratio - d.valueMm) / d.valueMm;
        score += rel <= 0.03 ? 0.6 : -0.4;
      }
      options.push([score, pos, res]);
    }
    if (!options.length) return false;
    const [, linePos, [p0, p1, terms, run, quality, fallback]] = maxBy(options, (o) => o[0]);
    if (fallback) {
      d.notes.push("No terminators found; span taken from dimension line ends");
      d.confidence *= 0.8;
    }
    const near = (t: Term) => Math.abs(t[0] - p0) < 2 * tol || Math.abs(t[0] - p1) < 2 * tol;
    const kinds = new Set(terms.filter(near).map((t) => t[1]));
    const ext = terms.filter((t) => (t[1] === "extension" || t[1] === "corner") && t[2] !== null && near(t)).map((t) => t[2]!);
    d.axis = axis;
    d.span = [p0, p1];
    d.linePos = linePos;
    d.line = axisSeg(axis, p0, p1, linePos);
    d.terminators = terms.filter(near).map((t) => ({ pos: pyRound(t[0], 2), kind: t[1] }));
    d.extensionLines = ext;
    if (quality < 0.5) {
      d.confidence *= 0.8;
      d.notes.push("Weak terminators (no ticks, arrows or extension lines)");
    } else if (!["tick", "arrow", "dot", "extension"].some((k) => kinds.has(k))) {
      d.confidence *= 0.85;
    }
    // remember pure dimension graphics so they are not mistaken for building geometry;
    // heavier lines doubling as extension lines (ground lines, wall faces) stay
    const hostW = run.length ? Math.max(...run.map((s) => s.width)) : 0;
    for (const s of run) used.add(s);
    for (const t of terms) if (t[2] !== null && t[2].width <= 1.5 * hostW + 0.01) used.add(t[2]);
    return true;
  }

  /** Span of the dimension on the line at `linePos`: [p0, p1, terms, run, quality, fallback]. */
  private resolve(axis: Axis, linePos: number, cAlong: number, halfLen: number, size: number, tol: number, idx: SegmentIndex): Resolved | null {
    const host = sortedBy(
      idx.query(axisBox(axis, cAlong - 400 * size, cAlong + 400 * size, linePos - tol, linePos + tol)).filter((s) => s.orientation(1.5) === axis && Math.abs(s.crossCoord(axis) - linePos) <= tol && !s.dashed),
      (s) => s.axisRange(axis)[0],
    );
    // connected run containing the text
    let run: Segment[] = [];
    for (const s of host) {
      const [lo] = s.axisRange(axis);
      if (!run.length) {
        run = [s];
        continue;
      }
      const rhi = Math.max(...run.map((r) => r.axisRange(axis)[1]));
      if (lo <= rhi + 2 * halfLen + 2 * size) run.push(s);
      else {
        if (Math.min(...run.map((r) => r.axisRange(axis)[0])) <= cAlong && cAlong <= rhi) break;
        run = [s];
      }
    }
    if (!run.length) return null;
    const runLo = Math.min(...run.map((r) => r.axisRange(axis)[0]));
    const runHi = Math.max(...run.map((r) => r.axisRange(axis)[1]));
    if (!(runLo - size <= cAlong && cAlong <= runHi + size)) return null;

    const inRun = (s: Segment) => run.some((r) => r === s || r.equals(s));
    const terms: Term[] = [];
    const band = axisBox(axis, runLo - size, runHi + size, linePos - 3 * size, linePos + 3 * size);
    for (const s of idx.query(band)) {
      if (inRun(s)) continue;
      const o = s.orientation(3);
      if (o !== null && o !== axis) {
        const [lo, hi] = s.axisRange(o);
        // extension lines stop just past the dimension line; a line running
        // through it on both sides (e.g. a crossing dimension) is not a terminator
        if (Math.min(linePos - lo, hi - linePos) > 1.6 * size) continue;
        if (lo - tol <= linePos && linePos <= hi + tol) {
          const p = s.crossCoord(o);
          if (runLo - tol <= p && p <= runHi + tol) {
            const overshoot = Math.min(linePos - lo, hi - linePos);
            let kind: string;
            if (s.length < 1.2 * size) kind = "tick";
            else if (overshoot > 0.2 * size) kind = "extension";
            else kind = "corner"; // a line merely meeting the dimension line (e.g. a frame corner)
            terms.push([p, kind, s]);
          }
        }
      } else if (o === null && s.length <= 4.5 * size) {
        const ang = s.angle % 90;
        if (ang >= 25 && ang <= 65) {
          const [mx, my] = s.mid;
          if (Math.abs((axis === "h" ? my : mx) - linePos) <= 1.2 * size) {
            const p = axis === "h" ? mx : my;
            if (runLo - size <= p && p <= runHi + size) terms.push([p, "tick", s]);
          }
        }
      }
    }
    for (const f of this.fills.filter((f) => band.containsPoint(...f.center))) {
      const pts = f.points;
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      if (Math.abs((axis === "h" ? cy : cx) - linePos) > 1.5 * size) continue;
      if (f.kind === "triangle" && pts.length === 3) {
        const apex = maxBy(pts, (p) => Math.hypot(p[0] - cx, p[1] - cy));
        terms.push([axis === "h" ? apex[0] : apex[1], "arrow", null]);
      } else {
        terms.push([axis === "h" ? cx : cy, "dot", null]);
      }
    }
    if (run.length > 1) {
      for (const s of run) {
        const [lo, hi] = s.axisRange(axis);
        terms.push([lo, "line_end", null]);
        terms.push([hi, "line_end", null]);
      }
    }
    const left = terms.filter((t) => t[0] < cAlong - 0.2 * halfLen);
    const right = terms.filter((t) => t[0] > cAlong + 0.2 * halfLen);
    let fallback = false;
    let p0: number;
    let p1: number;
    if (!left.length || !right.length) {
      if (run.length === 1 && !terms.length) {
        p0 = runLo;
        p1 = runHi;
        fallback = true;
      } else return null;
    } else {
      p0 = maxBy(left, (t) => t[0])[0];
      p1 = right.reduce((best, t) => (t[0] < best[0] ? t : best), right[0])[0];
    }
    if (p1 - p0 < 0.4 * halfLen) return null;
    const strength: Record<string, number> = { tick: 1, arrow: 1, dot: 1, extension: 0.8, line_end: 0.6, corner: 0.2 };
    const endStrength = (p: number) => {
      const ks = terms.filter((t) => Math.abs(t[0] - p) < 2 * tol).map((t) => strength[t[1]]);
      return ks.length ? Math.max(...ks) : 0.3;
    };
    const quality = fallback ? 0.35 : (endStrength(p0) + endStrength(p1)) / 2;
    return [p0, p1, terms, run, quality, fallback];
  }
}

function axisBox(axis: Axis, a0: number, a1: number, c0: number, c1: number): BBox {
  return axis === "h" ? BBox.fromPoints(a0, c0, a1, c1) : BBox.fromPoints(c0, a0, c1, a1);
}

function axisSeg(axis: Axis, a0: number, a1: number, c: number): Segment {
  return axis === "h" ? new Segment(a0, c, a1, c) : new Segment(c, a0, c, a1);
}

/** Group dimensions that share one dimension line into chains. */
function chains(dims: DimensionAnnotation[]): void {
  const groups = new DefaultMap<string, DimensionAnnotation[]>(() => []);
  for (const d of dims) {
    if (d.kind !== "linear" || d.span === null || d.linePos === null) continue;
    groups.get(`${d.viewId}|${d.axis}|${pyRound(d.linePos, 0)}`).push(d);
  }
  let k = 0;
  for (const raw of groups.values()) {
    const items = sortedBy(raw, (d) => d.span![0]);
    // consecutive spans that touch form a chain
    let chain = [items[0]];
    const all: DimensionAnnotation[][] = [];
    for (const d of items.slice(1)) {
      if (Math.abs(d.span![0] - chain[chain.length - 1].span![1]) < 1) chain.push(d);
      else {
        all.push(chain);
        chain = [d];
      }
    }
    all.push(chain);
    for (const ch of all) {
      if (ch.length < 2) continue;
      const cid = `${ch[0].viewId}-ch${k}`;
      k++;
      for (const d of ch) {
        d.chainId = cid;
        d.chainSize = ch.length;
      }
    }
  }
}
