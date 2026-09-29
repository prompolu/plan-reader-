/** Geometry extraction (vector PDF paths) and spatial indexing. */
import { Arc, BBox, FilledShape, Segment, emptyGeometry, type Axis, type PageGeometry, type Pt } from "./types";
import { DefaultMap, degrees, pmod, pyRound, sortedBy } from "./py";

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

/** Uniform grid index over segments for fast neighbourhood queries. */
export class SegmentIndex {
  readonly cell: number;
  private grid = new Map<string, number[]>();

  constructor(
    readonly segments: Segment[],
    cell: number,
  ) {
    this.cell = Math.max(cell, 1e-3);
    segments.forEach((s, i) => {
      for (const key of this.cells(s.bbox)) {
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, (arr = []));
        arr.push(i);
      }
    });
  }

  private *cells(b: BBox): Generator<string> {
    const c = this.cell;
    const x0 = Math.floor(b.x0 / c);
    let x1 = Math.floor(b.x1 / c);
    const y0 = Math.floor(b.y0 / c);
    let y1 = Math.floor(b.y1 / c);
    // guard against pathological very long segments
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) {
      x1 = Math.min(x1, x0 + 140);
      y1 = Math.min(y1, y0 + 140);
    }
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) yield `${gx},${gy}`;
  }

  query(b: BBox): Segment[] {
    const seen = new Set<number>();
    const out: Segment[] = [];
    for (const key of this.cells(b)) {
      const arr = this.grid.get(key);
      if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = this.segments[i];
        const sb = s.bbox;
        if (sb.x1 >= b.x0 && sb.x0 <= b.x1 && sb.y1 >= b.y0 && sb.y0 <= b.y1) out.push(s);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Vector extraction
// ---------------------------------------------------------------------------

/** One item of a drawn path, in displayed page coordinates (as PyMuPDF get_drawings reports them). */
export type PathItem =
  | { op: "l"; p1: Pt; p2: Pt }
  | { op: "re"; corners: [Pt, Pt, Pt, Pt] } // tl, tr, br, bl
  | { op: "qu"; corners: [Pt, Pt, Pt, Pt] } // ul, ur, lr, ll
  | { op: "c"; p0: Pt; p1: Pt; p2: Pt; p3: Pt };

export interface DrawingPath {
  items: PathItem[];
  width: number;
  dashed: boolean;
  /** filled (fill or fill+stroke) */
  fill: boolean;
  closePath: boolean;
}

function circleFrom3(p1: Pt, p2: Pt, p3: Pt): [number, number, number] | null {
  const [ax, ay] = p1;
  const [bx, by] = p2;
  const [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return [ux, uy, Math.hypot(ax - ux, ay - uy)];
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t;
  return [
    mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
    mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1],
  ];
}

type Ctrl = [Pt, Pt, Pt, Pt];

/** Fit a circle to a cubic Bezier. Returns [cx, cy, r, sweepDeg] or null. */
function fitCurveCircle(ctrl: Ctrl): [number, number, number, number] | null {
  const [p0, p1, p2, p3] = ctrl;
  const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => bezier(p0, p1, p2, p3, t));
  const c = circleFrom3(pts[0], pts[2], pts[4]);
  if (!c) return null;
  const [cx, cy, r] = c;
  if (r <= 0) return null;
  const err = Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r)));
  if (err > Math.max(0.02 * r, 0.05)) return null;
  const a0 = Math.atan2(pts[0][1] - cy, pts[0][0] - cx);
  const am = Math.atan2(pts[2][1] - cy, pts[2][0] - cx);
  const a1 = Math.atan2(pts[4][1] - cy, pts[4][0] - cx);
  const d1 = pmod(am - a0 + Math.PI, 2 * Math.PI) - Math.PI;
  const d2 = pmod(a1 - am + Math.PI, 2 * Math.PI) - Math.PI;
  return [cx, cy, r, degrees(Math.abs(d1 + d2))];
}

const ptEq = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

/** Convert drawn paths into pipeline geometry. */
export function extractVectorGeometry(drawings: DrawingPath[]): PageGeometry {
  const g = emptyGeometry();
  drawings.forEach((path, pid) => {
    const width = path.width || 0;
    const dashed = path.dashed;
    const fill = path.fill;
    const curves: Ctrl[] = [];
    const chain: Pt[] = [];
    const pathSegs: Segment[] = [];
    for (const it of path.items) {
      if (it.op === "l") {
        const a = it.p1;
        const b = it.p2;
        if (!ptEq(a, b)) pathSegs.push(new Segment(a[0], a[1], b[0], b[1], width, dashed, pid));
        if (!chain.length || !ptEq(chain[chain.length - 1], a)) chain.push(a);
        chain.push(b);
      } else if (it.op === "re") {
        const corners = it.corners;
        const bb = BBox.around(corners);
        if (fill && bb.w * bb.h < 4) {
          g.fills.push(new FilledShape([...corners], "dot"));
          continue;
        }
        g.rects.push(bb);
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          g.segments.push(new Segment(a[0], a[1], b[0], b[1], width, dashed, pid));
        }
      } else if (it.op === "qu") {
        const corners = it.corners;
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          if (!ptEq(a, b)) g.segments.push(new Segment(a[0], a[1], b[0], b[1], width, dashed, pid));
        }
      } else {
        curves.push([it.p0, it.p1, it.p2, it.p3]);
      }
    }
    const closed = path.closePath;
    let isArrowhead = false;
    if (chain.length >= 3 && (closed || ptEq(chain[0], chain[chain.length - 1]))) {
      const poly = ptEq(chain[0], chain[chain.length - 1]) ? chain.slice(0, -1) : chain;
      if (closed && !ptEq(chain[0], chain[chain.length - 1])) {
        const a = chain[chain.length - 1];
        const b = chain[0];
        pathSegs.push(new Segment(a[0], a[1], b[0], b[1], width, dashed, pid));
      }
      if (fill && poly.length === 3) {
        // filled triangles are dimension arrowheads: terminators, not lines
        g.fills.push(new FilledShape([...poly], "triangle"));
        isArrowhead = BBox.around(poly).area < 400;
      } else if (poly.length >= 4 && poly.length <= 12 && !fill) {
        g.polygons.push([...poly]);
      }
    }
    if (!isArrowhead) g.segments.push(...pathSegs);
    if (curves.length) curvesToArcs(curves, g, pid, fill);
  });
  polylineArcs(g);
  return g;
}

/**
 * Arcs drawn as chains of short straight lines (some CAD exports, e.g. Revit,
 * write door swings that way): chains that turn steadily one way around a
 * common centre become arcs, like the curved ones.
 */
export function polylineArcs(g: PageGeometry): void {
  const short = g.segments.filter((s) => s.length > 0.05 && s.length < 25);
  if (short.length < 4) return;
  const key = (x: number, y: number) => `${Math.round(x * 20)}|${Math.round(y * 20)}`;
  const at = new Map<string, Segment[]>();
  for (const s of short) {
    for (const k of [key(s.x0, s.y0), key(s.x1, s.y1)]) {
      const l = at.get(k);
      if (l) l.push(s);
      else at.set(k, [s]);
    }
  }
  const seen = new Set<Segment>();
  const other = (s: Segment, k: string): Pt => (key(s.x0, s.y0) === k ? [s.x1, s.y1] : [s.x0, s.y0]);
  const next = (s: Segment, p: Pt): Segment | null => {
    const l = at.get(key(p[0], p[1])) ?? [];
    const cands = l.filter((x) => x !== s);
    return cands.length === 1 && l.length === 2 ? cands[0] : null;
  };
  for (const s0 of short) {
    if (seen.has(s0)) continue;
    // walk both ways from s0 through points shared by exactly two short segments
    const pts: Pt[] = [
      [s0.x0, s0.y0],
      [s0.x1, s0.y1],
    ];
    const segs = [s0];
    seen.add(s0);
    for (const dir of [1, -1]) {
      let cur = s0;
      let p: Pt = dir === 1 ? [s0.x1, s0.y1] : [s0.x0, s0.y0];
      for (let n = 0; n < 200; n++) {
        const nx = next(cur, p);
        if (!nx || seen.has(nx)) break;
        seen.add(nx);
        const q = other(nx, key(p[0], p[1]));
        if (dir === 1) pts.push(q);
        else pts.unshift(q);
        segs.push(nx);
        cur = nx;
        p = q;
      }
    }
    if (segs.length < 4) continue;
    // steady turning in one direction
    let total = 0;
    let sign = 0;
    let ok = true;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      const d = pmod(a2 - a1 + Math.PI, 2 * Math.PI) - Math.PI;
      const sg = Math.sign(d);
      if (Math.abs(d) < 1e-3 || Math.abs(d) > (35 * Math.PI) / 180 || (sign && sg !== sign)) {
        ok = false;
        break;
      }
      sign = sg;
      total += d;
    }
    const sweep = degrees(Math.abs(total)) + degrees(Math.abs(total)) / Math.max(pts.length - 2, 1);
    if (!ok || sweep < 40 || sweep > 200) continue;
    const c = circleFrom3(pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]);
    if (!c) continue;
    const [cx, cy, r] = c;
    if (r < 3 || Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r))) > 0.04 * r + 0.1) continue;
    const a0 = Math.atan2(pts[0][1] - cy, pts[0][0] - cx);
    const a1 = Math.atan2(pts[pts.length - 1][1] - cy, pts[pts.length - 1][0] - cx);
    let sw = Math.abs(degrees(pmod(a1 - a0 + Math.PI, 2 * Math.PI) - Math.PI));
    if (sweep > 180) sw = 360 - sw;
    g.arcs.push(new Arc(cx, cy, r, pts[0], pts[pts.length - 1], sw, segs[0].pathId));
  }
}

function curvesToArcs(curves: Ctrl[], g: PageGeometry, pid: number, filled: boolean): void {
  const fits = curves.map(fitCurveCircle);
  // group consecutive curves on the same circle
  const groups: number[][] = [];
  fits.forEach((f, i) => {
    if (f === null) {
      groups.push([]);
      return;
    }
    const last = groups[groups.length - 1];
    if (last && last.length) {
      const j = last[last.length - 1];
      const fj = fits[j];
      if (fj && Math.hypot(f[0] - fj[0], f[1] - fj[1]) < 0.03 * f[2] + 0.05 && Math.abs(f[2] - fj[2]) < 0.03 * f[2] + 0.05 && ptEq(curves[j][3], curves[i][0])) {
        last.push(i);
        return;
      }
    }
    groups.push([i]);
  });
  for (const grp of groups) {
    if (!grp.length) continue;
    const n = grp.length;
    const cx = grp.reduce((a, i) => a + fits[i]![0], 0) / n;
    const cy = grp.reduce((a, i) => a + fits[i]![1], 0) / n;
    const r = grp.reduce((a, i) => a + fits[i]![2], 0) / n;
    const sweep = grp.reduce((a, i) => a + fits[i]![3], 0);
    const start = curves[grp[0]][0];
    const end = curves[grp[n - 1]][3];
    if (sweep >= 350) {
      if (filled && r < 3) g.fills.push(new FilledShape([[cx - r, cy - r], [cx + r, cy + r]], "dot"));
      else g.circles.push([cx, cy, r]);
    } else {
      g.arcs.push(new Arc(cx, cy, r, start, end, sweep, pid));
    }
  }
}

// ---------------------------------------------------------------------------
// Segment utilities (shared by vector and raster paths)
// ---------------------------------------------------------------------------

/**
 * Split horizontal/vertical segments where perpendicular segments cross or meet them.
 * In scans, strokes that touch come out as one line; splitting at junctions
 * recovers the individual pieces (e.g. the jamb between two wall faces).
 */
export function splitAtIntersections(segs: Segment[], tol = 2): Segment[] {
  const hs = segs.filter((s) => s.orientation(1) === "h");
  const vs = segs.filter((s) => s.orientation(1) === "v");
  const others = segs.filter((s) => s.orientation(1) === null);
  if (!hs.length || !vs.length) return segs;
  const cell = 64;
  const vidx = new SegmentIndex(vs, cell);
  const hidx = new SegmentIndex(hs, cell);

  const cutsFor = (s: Segment, axis: Axis, idx: SegmentIndex): number[] => {
    const [lo, hi] = s.axisRange(axis);
    const c = s.crossCoord(axis);
    const box = axis === "h" ? BBox.fromPoints(lo, c - tol, hi, c + tol) : BBox.fromPoints(c - tol, lo, c + tol, hi);
    const out = new Set<number>();
    for (const p of idx.query(box)) {
      const po: Axis = axis === "h" ? "v" : "h";
      const [plo, phi] = p.axisRange(po);
      if (plo - tol <= c && c <= phi + tol) {
        const pos = p.crossCoord(po);
        if (lo + tol < pos && pos < hi - tol) out.add(pyRound(pos, 1));
      }
    }
    return [...out].sort((a, b) => a - b);
  };

  const out: Segment[] = [...others];
  for (const s of hs) {
    const cuts = cutsFor(s, "h", vidx);
    const xs = [s.axisRange("h")[0], ...cuts, s.axisRange("h")[1]];
    const y = s.crossCoord("h");
    for (let i = 0; i + 1 < xs.length; i++) if (xs[i + 1] - xs[i] > 0.5) out.push(new Segment(xs[i], y, xs[i + 1], y, s.width));
  }
  for (const s of vs) {
    const cuts = cutsFor(s, "v", hidx);
    const ys = [s.axisRange("v")[0], ...cuts, s.axisRange("v")[1]];
    const x = s.crossCoord("v");
    for (let i = 0; i + 1 < ys.length; i++) if (ys[i + 1] - ys[i] > 0.5) out.push(new Segment(x, ys[i], x, ys[i + 1], s.width));
  }
  return out;
}

function mk(o: Axis, lo: number, hi: number, c: number, width: number): Segment {
  return o === "h" ? new Segment(lo, c, hi, c, width) : new Segment(c, lo, c, hi, width);
}

/** Merge overlapping/adjacent collinear horizontal and vertical segments. */
export function mergeCollinear(segs: Segment[], tol = 0.5, gap = 0.5): Segment[] {
  const out: Segment[] = [];
  const buckets = new DefaultMap<string, Segment[]>(() => []);
  const bucketAxis = new Map<string, Axis>();
  for (const s of segs) {
    const o = s.orientation(1);
    if (o === null) {
      out.push(s);
      continue;
    }
    const key = `${o}|${pyRound(s.crossCoord(o) / tol)}`;
    buckets.get(key).push(s);
    bucketAxis.set(key, o);
  }
  for (const [key, raw] of buckets) {
    const o = bucketAxis.get(key)!;
    const items = sortedBy(raw, (s) => s.axisRange(o)[0]);
    let [curLo, curHi] = items[0].axisRange(o);
    let cc = [items[0].crossCoord(o)];
    let width = items[0].width;
    for (const s of items.slice(1)) {
      const [lo, hi] = s.axisRange(o);
      if (lo <= curHi + gap) {
        curHi = Math.max(curHi, hi);
        cc.push(s.crossCoord(o));
        width = Math.max(width, s.width);
      } else {
        out.push(mk(o, curLo, curHi, cc.reduce((a, b) => a + b, 0) / cc.length, width));
        curLo = lo;
        curHi = hi;
        cc = [s.crossCoord(o)];
        width = s.width;
      }
    }
    out.push(mk(o, curLo, curHi, cc.reduce((a, b) => a + b, 0) / cc.length, width));
  }
  return out;
}

/** Most common stroke width among long segments (wall lines are usually the heaviest). */
export function typicalWallWidth(segs: Segment[]): number {
  const counts = new Map<number, number>();
  let total = 0;
  for (const s of segs) {
    if (s.length > 20 && s.width > 0) {
      const w = pyRound(s.width, 2);
      counts.set(w, (counts.get(w) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return 0;
  const vals = [...counts.keys()].sort((a, b) => b - a); // heaviest first
  for (const v of vals) if (counts.get(v)! >= Math.max(4, 0.03 * total)) return v;
  return vals[0];
}
