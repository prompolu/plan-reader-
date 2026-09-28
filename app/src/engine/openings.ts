/**
 * Opening detection.
 *
 * Floor plans: an opening is a gap in a wall bounded by two *jambs* (short
 * lines across the wall thickness) with the wall faces continuing outside the
 * gap. The contents of the gap determine the kind: glazing lines (window), a
 * swing arc (door), two arcs (double door), staggered panels (sliding), dashed
 * overhead lines (garage door), nothing (cased opening). Door swings that are
 * not bounded by two jambs are found from the arc itself.
 *
 * Elevations: openings are rectangular frames (often with an inner
 * glazing/panel rectangle). They are references to openings shown on plans.
 */
import { SegmentIndex, mergeCollinear, typicalWallWidth } from "./geometry";
import type { DetectionContext } from "./context";
import { parseTag } from "./tags";
import { Arc, BBox, evidence, newDetection, type Axis, type Evidence, type OpeningDetection, type PageData, type Pt, type Segment, type TagDetection, type View } from "./types";
import { findExpressions } from "./units";
import { DefaultMap, maxBy, pyFixed, pyRound, sortedBy } from "./py";

interface Jamb {
  pos: number; // coordinate along the wall axis
  v0: number;
  v1: number;
  wallAxis: Axis;
  seg: Segment;
}

function inView(b: BBox, view: View, margin = 0): boolean {
  return view.bbox.expand(margin).containsPoint(b.cx, b.cy);
}
const along = (axis: Axis, x: number, y: number) => (axis === "h" ? x : y);
const across = (axis: Axis, x: number, y: number) => (axis === "h" ? y : x);
function box(axis: Axis, a0: number, a1: number, c0: number, c1: number): BBox {
  return axis === "h" ? BBox.fromPoints(a0, c0, a1, c1) : BBox.fromPoints(c0, a0, c1, a1);
}

export class PlanOpeningDetector {
  readonly name = "plan-geometry";
  private ctx!: DetectionContext;
  private tol = 0;
  private idx!: SegmentIndex;
  private wallW = 0;

  /** `exclude`: segments that belong to dimension annotations (not building geometry). */
  constructor(private readonly exclude: Set<Segment> = new Set()) {}

  detect(page: PageData, view: View, _tags: TagDetection[], ctx: DetectionContext): OpeningDetection[] {
    const margin = ctx.units(300);
    const segs = page.geometry.segments.filter((s) => !this.exclude.has(s) && inView(s.bbox, view, margin));
    if (!segs.length) return [];
    this.ctx = ctx;
    this.tol = Math.max(0.6, ctx.units(25), ctx.minTol);
    this.idx = new SegmentIndex(segs, Math.max(ctx.units(600), 4));
    this.wallW = typicalWallWidth(segs);
    const arcs = page.geometry.arcs.filter((a) => inView(a.bbox, view, margin));
    const tMin = ctx.units(60);
    const tMax = ctx.units(700);
    const wMin = ctx.units(300);
    const wMax = ctx.units(7500);

    const jambs: Jamb[] = [];
    for (const s of segs) {
      const o = s.orientation(2);
      if (o === null || s.dashed || !(tMin <= s.length && s.length <= tMax)) continue;
      const wallAxis: Axis = o === "v" ? "h" : "v";
      const [lo, hi] = s.axisRange(o);
      jambs.push({ pos: s.crossCoord(o), v0: lo, v1: hi, wallAxis, seg: s });
    }

    const groups = new DefaultMap<string, Jamb[]>(() => []);
    const q = this.tol * 2;
    for (const j of jambs) groups.get(`${j.wallAxis}|${pyRound(j.v0 / q)}|${pyRound(j.v1 / q)}`).push(j);

    let found: OpeningDetection[] = [];
    const usedArcs = new Set<number>();
    for (const [key, raw] of groups) {
      const axis = key.split("|")[0] as Axis;
      const items = sortedBy(raw, (j) => j.pos);
      // collapse duplicates (overlapping jamb strokes)
      const uniq: Jamb[] = [];
      for (const j of items) {
        if (uniq.length && Math.abs(j.pos - uniq[uniq.length - 1].pos) < this.tol) continue;
        uniq.push(j);
      }
      for (let k = 0; k + 1 < uniq.length; k++) {
        const j1 = uniq[k];
        const j2 = uniq[k + 1];
        const g = j2.pos - j1.pos;
        if (!(wMin <= g && g <= wMax)) continue;
        const det = this.evaluateGap(page, view, axis, j1, j2, arcs, usedArcs);
        if (det !== null) found.push(det);
      }
    }
    found = found.concat(this.arcDoors(page, view, arcs, usedArcs, found));
    found = dedupeDetections(found, this.tol);
    found.forEach((d, i) => {
      d.id = `${view.id}-o${i}`;
      d.room = nearestRoom(page, view, d, ctx);
    });
    return found;
  }

  // -- helpers -----------------------------------------------------------------

  /** Segments parallel to `axis` at cross coordinate `cross` overlapping [a0, a1]. */
  private parallelAt(axis: Axis, cross: number, a0: number, a1: number): Segment[] {
    const t = this.tol;
    const b = box(axis, Math.min(a0, a1) - t, Math.max(a0, a1) + t, cross - t, cross + t);
    return this.idx.query(b).filter((s) => s.orientation(2) === axis && Math.abs(s.crossCoord(axis) - cross) <= t);
  }

  /** How many wall faces continue from jamb `j` away from the gap (0..2). */
  private faceContinues(axis: Axis, j: Jamb, direction: number): number {
    let n = 0;
    const minLen = this.ctx.units(40);
    for (const face of [j.v0, j.v1]) {
      for (const s of this.parallelAt(axis, face, j.pos - this.tol, j.pos + this.tol)) {
        const [lo, hi] = s.axisRange(axis);
        // the face reaches the jamb and runs on away from the gap
        if (direction < 0 && hi >= j.pos - this.tol && j.pos - lo >= minLen) {
          n++;
          break;
        }
        if (direction > 0 && lo <= j.pos + this.tol && hi - j.pos >= minLen) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  private evaluateGap(page: PageData, view: View, axis: Axis, j1: Jamb, j2: Jamb, arcs: Arc[], usedArcs: Set<number>): OpeningDetection | null {
    const t = this.tol;
    const p1 = j1.pos;
    const p2 = j2.pos;
    const v0 = Math.min(j1.v0, j2.v0);
    const v1 = Math.max(j1.v1, j2.v1);
    const g = p2 - p1;
    const c1 = this.faceContinues(axis, j1, -1);
    const c2 = this.faceContinues(axis, j2, +1);
    if (c1 === 0 && c2 === 0) return null;
    // face lines running straight through both jambs (typical of scans) count as face lines across the gap
    const through: Segment[] = [];
    for (const face of [v0, v1]) {
      for (const s of this.parallelAt(axis, face, p1, p2)) {
        const [lo, hi] = s.axisRange(axis);
        if (lo < p1 - 2 * t && hi > p2 + 2 * t) {
          through.push(s);
          break;
        }
      }
    }

    const b = box(axis, p1, p2, v0, v1);
    const fullFace = [...through];
    const fullInner: Segment[] = [];
    const partialInner: Segment[] = [];
    for (const s of this.idx.query(b.expand(t))) {
      if (s.orientation(2) !== axis || s === j1.seg || s === j2.seg) continue;
      const [lo, hi] = s.axisRange(axis);
      const c = s.crossCoord(axis);
      if (!(v0 - t <= c && c <= v1 + t) || lo < p1 - t || hi > p2 + t) continue;
      const full = Math.abs(lo - p1) < t && Math.abs(hi - p2) < t;
      const atFace = Math.abs(c - v0) < t || Math.abs(c - v1) < t;
      if (full && atFace) fullFace.push(s);
      else if (full) fullInner.push(s);
      else if (!atFace && hi - lo >= 0.3 * g) partialInner.push(s);
    }

    const ev: Evidence[] = [
      evidence("jambs", "Wall gap bounded by two jambs", true, {
        detail: `Gap of ${pyFixed(this.ctx.real(g), 0)} mm (at drawing scale) with wall faces continuing on ${c1 + c2} side(s)`,
        pageIndex: page.index,
        bbox: b,
      }),
    ];
    let conf = 0.6 + 0.05 * (c1 + c2);
    let kind: string | null = null;
    const features: Record<string, unknown> = { face_continuations: c1 + c2 };
    const arcItems: Arc[] = [];

    // doors: swing arcs hinged at a jamb that close onto the *other* jamb of this gap
    const singles: [number, Arc, number][] = [];
    const halves: [number, Arc, number][] = [];
    arcs.forEach((a, ai) => {
      if (fullFace.length || usedArcs.has(ai) || !(a.sweepDeg >= 70 && a.sweepDeg <= 110)) return;
      const ca = along(axis, a.cx, a.cy);
      const cc = across(axis, a.cx, a.cy);
      if (!(v0 - 3 * t <= cc && cc <= v1 + 3 * t)) return;
      const near1 = Math.abs(ca - p1) < 2 * t;
      const near2 = Math.abs(ca - p2) < 2 * t;
      if (!(near1 || near2)) return;
      const endsAlong = [along(axis, ...a.start), along(axis, ...a.end)];
      if (Math.abs(a.r - g) < 0.1 * g) {
        const target = near1 ? p2 : p1;
        if (Math.min(...endsAlong.map((e) => Math.abs(e - target))) < Math.max(2 * t, 0.1 * g)) singles.push([ai, a, near1 ? 1 : 2]);
      } else if (Math.abs(a.r - g / 2) < (0.1 * g) / 2) {
        const mid = (p1 + p2) / 2;
        if (Math.min(...endsAlong.map((e) => Math.abs(e - mid))) < Math.max(2 * t, 0.1 * g)) halves.push([ai, a, near1 ? 1 : 2]);
      }
    });
    const hinges = new Set(halves.map((h) => h[2]));
    if (singles.length) {
      const [ai, a, hinge] = singles[0];
      usedArcs.add(ai);
      arcItems.push(a);
      kind = "door";
      conf = 0.9 + 0.02 * (c1 + c2);
      const leaf = this.leaf(a);
      ev.push(evidence("swing_arc", "Door swing arc hinged at jamb", true, { detail: `Arc radius equals gap width; hinge at ${hinge === 1 ? "first" : "second"} jamb`, pageIndex: page.index, bbox: a.bbox }));
      if (leaf) {
        ev.push(evidence("door_leaf", "Door leaf line drawn from hinge", true, { pageIndex: page.index, bbox: leaf.bbox }));
        conf += 0.02;
      }
    } else if (hinges.size === 2 && hinges.has(1) && hinges.has(2)) {
      const picks = [halves.find((x) => x[2] === 1)!, halves.find((x) => x[2] === 2)!];
      for (const [ai, a] of picks) {
        usedArcs.add(ai);
        arcItems.push(a);
      }
      kind = "double_door";
      conf = 0.9 + 0.02 * (c1 + c2);
      ev.push(evidence("swing_arc", "Two swing arcs meeting at centre (pair of leaves)", true, { pageIndex: page.index, bbox: arcItems[0].bbox.union(arcItems[1].bbox) }));
    }

    if (kind === null && partialInner.length >= 2) {
      const touches1 = partialInner.filter((s) => Math.abs(s.axisRange(axis)[0] - p1) < t);
      const touches2 = partialInner.filter((s) => Math.abs(s.axisRange(axis)[1] - p2) < t);
      if (touches1.length && touches2.length) {
        const s1 = touches1[0];
        const s2 = touches2[0];
        const overlap = s1.axisRange(axis)[1] - s2.axisRange(axis)[0];
        if (overlap > 0 && Math.abs(s1.crossCoord(axis) - s2.crossCoord(axis)) > 0.5 * t) {
          kind = fullFace.length ? "sliding_window" : "sliding_door";
          conf = 0.85;
          ev.push(evidence("sliding_panels", "Two overlapping staggered panels (sliding)", true, { pageIndex: page.index, bbox: b }));
        }
      }
    }
    if (kind === null) {
      const dashed = this.dashedNear(axis, p1, p2, v0, v1);
      if (dashed.length) {
        kind = "garage_door";
        conf = 0.8;
        ev.push(evidence("overhead_door", "Dashed overhead-door lines across the gap", true, { pageIndex: page.index, bbox: dashed[0].bbox }));
      }
    }
    if (kind === null && fullInner.length) {
      kind = "window";
      conf = 0.86 + (fullFace.length ? 0.04 : 0) + 0.02 * Math.min(c1 + c2, 2);
      ev.push(evidence("glazing_lines", "Glazing lines span jamb to jamb", true, { detail: `${fullInner.length} inner + ${fullFace.length} face line(s)`, pageIndex: page.index, bbox: b }));
    }
    if (kind === null && fullFace.length >= 2) {
      const thin = fullFace.every((s) => !!s.width && !!this.wallW && s.width < 0.6 * this.wallW);
      if (!thin) return null; // solid wall between two openings (a pier)
      kind = "window";
      conf = 0.62;
      ev.push(evidence("thin_lines", "Thin lines across wall gap (window convention without glazing line)", null, { pageIndex: page.index, bbox: b }));
    }
    if (kind === null) {
      if (fullFace.length || partialInner.length) return null;
      // an empty gap only counts as an opening when both wall faces continue on both sides
      if (c1 + c2 < 4 || g > this.ctx.units(4500)) return null;
      kind = "opening";
      conf = 0.5 + 0.05 * (c1 + c2);
      ev.push(evidence("empty_gap", "Empty wall gap (cased opening or passage)", null, { pageIndex: page.index, bbox: b }));
    }

    let bbox = b;
    for (const a of arcItems) bbox = bbox.union(a.bbox);
    Object.assign(features, { inner_lines: fullInner.length, face_lines: fullFace.length, arcs: arcItems.length });
    return newDetection({
      id: "",
      pageIndex: page.index,
      viewId: view.id,
      viewType: view.viewType,
      kind,
      bbox,
      axis,
      edges: [p1, p2],
      cross: [v0, v1],
      detector: "jamb-pair",
      confidence: Math.min(conf, 0.99),
      evidence: ev,
      features,
    });
  }

  private leaf(a: Arc): Segment | null {
    const b = new BBox(a.cx - a.r - 2, a.cy - a.r - 2, 2 * a.r + 4, 2 * a.r + 4);
    for (const s of this.idx.query(b)) {
      for (const [[x, y], [ox, oy]] of [
        [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ],
        [
          [s.x1, s.y1],
          [s.x0, s.y0],
        ],
      ] as [Pt, Pt][]) {
        if (Math.hypot(x - a.cx, y - a.cy) < 2 * this.tol && Math.abs(Math.hypot(ox - a.cx, oy - a.cy) - a.r) < 0.06 * a.r + this.tol) return s;
      }
    }
    return null;
  }

  private dashedNear(axis: Axis, p1: number, p2: number, v0: number, v1: number): Segment[] {
    const reach = this.ctx.units(900);
    const b = box(axis, p1, p2, v0 - reach, v1 + reach);
    const g = p2 - p1;
    const out: Segment[] = [];
    for (const s of this.idx.query(b)) {
      if (!s.dashed || s.orientation(2) !== axis) continue;
      const [lo, hi] = s.axisRange(axis);
      if (hi - lo >= 0.7 * g && lo >= p1 - 2 * this.tol && hi <= p2 + 2 * this.tol) out.push(s);
    }
    return out;
  }

  /** Door swings not bounded by two jambs (e.g. a door beside a perpendicular wall). */
  private arcDoors(page: PageData, view: View, arcs: Arc[], used: Set<number>, existing: OpeningDetection[]): OpeningDetection[] {
    const out: OpeningDetection[] = [];
    const dMin = this.ctx.units(450);
    const dMax = this.ctx.units(1400);
    arcs.forEach((a, ai) => {
      if (used.has(ai) || !(a.sweepDeg >= 75 && a.sweepDeg <= 105) || !(dMin <= a.r && a.r <= dMax)) return;
      if ([...existing, ...out].some((e) => e.bbox.containsPoint(a.cx, a.cy, this.tol))) return;
      const leaf = this.leaf(a);
      if (leaf === null) return;
      const ends: Pt[] = [a.start, a.end];
      const leafFar = maxBy(
        [
          [leaf.x0, leaf.y0],
          [leaf.x1, leaf.y1],
        ] as Pt[],
        (p) => Math.hypot(p[0] - a.cx, p[1] - a.cy),
      );
      const closed = maxBy(ends, (p) => Math.hypot(p[0] - leafFar[0], p[1] - leafFar[1]));
      const dx = closed[0] - a.cx;
      const dy = closed[1] - a.cy;
      const axis: Axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
      const [a0, a1] = [along(axis, a.cx, a.cy), along(axis, ...closed)].sort((x, y) => x - y);
      const c = across(axis, a.cx, a.cy);
      const halfT = this.ctx.units(60);
      used.add(ai);
      const b = box(axis, a0, a1, c - halfT, c + halfT);
      out.push(
        newDetection({
          id: "",
          pageIndex: page.index,
          viewId: view.id,
          viewType: view.viewType,
          kind: "door",
          bbox: b.union(a.bbox),
          axis,
          edges: [a0, a1],
          cross: [c - halfT, c + halfT],
          detector: "swing-arc",
          confidence: 0.72,
          evidence: [
            evidence("swing_arc", "Door swing arc with leaf line", true, { pageIndex: page.index, bbox: a.bbox }),
            evidence("jambs", "Jambs not found on both sides of the opening", false, { pageIndex: page.index, bbox: b }),
          ],
          features: { arcs: 1 },
        }),
      );
    });
    return out;
  }
}

/** Drop detections describing the same wall gap twice (keep the most confident). */
export function dedupeDetections(dets: OpeningDetection[], tol: number): OpeningDetection[] {
  const out: OpeningDetection[] = [];
  for (const d of sortedBy(dets, (d) => -d.confidence)) {
    const dup = out.some((k) => k.axis === d.axis && Math.abs(k.edges[0] - d.edges[0]) < 2 * tol && Math.abs(k.edges[1] - d.edges[1]) < 2 * tol && Math.abs(k.cross[0] - d.cross[0]) < 4 * tol);
    if (!dup) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elevations
// ---------------------------------------------------------------------------

/** Axis-aligned rectangles formed by horizontal/vertical segments. */
export function findRectangles(segs: Segment[], tol: number, minSide: number, maxSide: number): BBox[] {
  const merged = mergeCollinear(
    segs.filter((s) => s.orientation(1.5)),
    tol / 2,
    tol,
  );
  const hs = merged.filter((s) => s.orientation(1.5) === "h" && s.length >= minSide * 0.9);
  const vs = merged.filter((s) => s.orientation(1.5) === "v" && s.length >= minSide * 0.9);
  const vidx = new SegmentIndex(vs, Math.max(maxSide / 4, 1));
  const byX = new DefaultMap<number, Segment[]>(() => []);
  const q = Math.max(tol, 0.5);
  for (const s of hs) byX.get(pyRound(s.axisRange("h")[0] / q)).push(s);
  const out: BBox[] = [];
  for (const [key, items] of [...byX.entries()]) {
    const cands = [...items, ...(byX.has(key - 1) ? byX.get(key - 1) : []), ...(byX.has(key + 1) ? byX.get(key + 1) : [])];
    for (const top of items) {
      const [tx0, tx1] = top.axisRange("h");
      for (const bot of cands) {
        if (bot === top) continue;
        const [bx0, bx1] = bot.axisRange("h");
        if (Math.abs(bx0 - tx0) > tol || Math.abs(bx1 - tx1) > tol) continue;
        const y0 = top.crossCoord("h");
        const y1 = bot.crossCoord("h");
        if (y1 <= y0 + minSide * 0.9 || y1 - y0 > maxSide) continue;
        const w = tx1 - tx0;
        if (!(minSide * 0.9 <= w && w <= maxSide)) continue;
        if (verticalCover(vidx, tx0, y0, y1, tol) && verticalCover(vidx, tx1, y0, y1, tol)) out.push(BBox.fromPoints(tx0, y0, tx1, y1));
      }
    }
  }
  return uniqRects(out, tol);
}

function uniqRects(rects: BBox[], tol: number): BBox[] {
  const uniq: BBox[] = [];
  for (const r of rects) {
    if (!uniq.some((u) => Math.abs(r.x0 - u.x0) < tol && Math.abs(r.x1 - u.x1) < tol && Math.abs(r.y0 - u.y0) < tol && Math.abs(r.y1 - u.y1) < tol)) uniq.push(r);
  }
  return uniq;
}

function verticalCover(vidx: SegmentIndex, x: number, y0: number, y1: number, tol: number): boolean {
  for (const s of vidx.query(new BBox(x - tol, y0, 2 * tol, y1 - y0))) {
    if (Math.abs(s.crossCoord("v") - x) > tol) continue;
    const [lo, hi] = s.axisRange("v");
    if (lo <= y0 + tol && hi >= y1 - tol) return true;
  }
  return false;
}

export class ElevationOpeningDetector {
  readonly name = "elevation-frames";

  constructor(private readonly exclude: Set<Segment> = new Set()) {}

  detect(page: PageData, view: View, _tags: TagDetection[], ctx: DetectionContext): OpeningDetection[] {
    const tol = Math.max(0.6, ctx.units(20));
    const minSide = ctx.units(250);
    const maxSide = ctx.units(7000);
    const segs = page.geometry.segments.filter((s) => !this.exclude.has(s) && view.bbox.contains(s.bbox, tol));
    let rects = page.geometry.rects.filter((r) => view.bbox.contains(r, tol) && minSide <= r.w && r.w <= maxSide && minSide <= r.h && r.h <= maxSide);
    rects = rects.concat(findRectangles(segs, tol, minSide, maxSide));
    rects = uniqRects(rects, tol);
    // ground line: the longest heavy horizontal line in the view
    const hs = segs.filter((s) => s.orientation() === "h");
    const ground = hs.length ? hs.reduce((best, s) => (s.width > best.width || (s.width === best.width && s.length > best.length) ? s : best), hs[0]).y0 : null;

    // nested frames: keep the outer rectangle, remember the inner one
    rects = sortedBy(rects, (r) => -r.area);
    const innerOf = new Map<number, number>();
    rects.forEach((outer, i) => {
      for (let j = i + 1; j < rects.length; j++) {
        const inner = rects[j];
        if (innerOf.has(j) || !outer.contains(inner, tol * 0.5)) continue;
        const inset = Math.min(inner.x0 - outer.x0, outer.x1 - inner.x1, inner.y0 - outer.y0, outer.y1 - inner.y1);
        if (-tol <= inset && inset <= 0.25 * Math.min(outer.w, outer.h)) innerOf.set(j, i);
      }
    });
    const outers = rects.map((_, i) => i).filter((i) => !innerOf.has(i));
    // a rectangle containing several candidate openings is a facade/panel, not an opening
    const big = new Set<number>();
    for (const i of outers) {
      const contained = outers.filter((k) => k !== i && rects[i].contains(rects[k], tol)).length;
      if (contained >= 2) big.add(i);
    }
    const nestedOuters = new Set(innerOf.values());
    const out: OpeningDetection[] = [];
    for (const i of outers) {
      if (big.has(i)) continue;
      const r = rects[i];
      const nested = nestedOuters.has(i);
      const touchesGround = ground !== null && Math.abs(r.y1 - ground) < 2 * tol;
      // garage door panels: full-width horizontal lines (inner glazing frames are inset)
      const panelLines = hs.filter((s) => r.contains(s.bbox, tol * 0.5) && s.length > r.w - 2 * tol && r.y0 + tol < s.y0 && s.y0 < r.y1 - tol).length;
      const kind = touchesGround && panelLines >= 2 ? "garage_door" : touchesGround ? "door" : "window";
      const conf = nested ? 0.8 : 0.6;
      const ev: Evidence[] = [evidence("frame", "Rectangular frame" + (nested ? " with inner glazing/panel line" : ""), true, { pageIndex: page.index, bbox: r })];
      if (touchesGround) ev.push(evidence("ground", "Frame starts at ground/floor line", null, { pageIndex: page.index, bbox: r }));
      out.push(
        newDetection({
          id: "",
          pageIndex: page.index,
          viewId: view.id,
          viewType: view.viewType,
          kind,
          bbox: r,
          axis: "h",
          edges: [r.x0, r.x1],
          cross: [r.y0, r.y1],
          detector: this.name,
          confidence: conf,
          evidence: ev,
          features: { nested, touches_ground: touchesGround, panel_lines: panelLines },
        }),
      );
    }
    out.forEach((d, k) => (d.id = `${view.id}-e${k}`));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Room names (location hint)
// ---------------------------------------------------------------------------

const ROOM_WORDS =
  /\b(BED(ROOM)?|MASTER|KITCHEN|LIVING|LOUNGE|DINING|FAMILY|BATH(ROOM)?|ENSUITE|WC|TOILET|POWDER|LAUNDRY|GARAGE|CARPORT|HALL(WAY)?|ENTRY|FOYER|LOBBY|OFFICE|STUDY|STORE|STORAGE|CLOSET|WIR|ROBE|PANTRY|CORRIDOR|STAIR|MEETING|RECEPTION|CONFERENCE|BREAKOUT|PLANT|UTILITY|RUMPUS|GUEST|NURSERY|DECK|PATIO|BALCONY|ROOM|SUITE|WORKSHOP|CLASSROOM|LAB)\b/i;

export function nearestRoom(page: PageData, view: View, d: OpeningDetection, ctx: DetectionContext): string | null {
  let best: [number, string] | null = null;
  const reach = ctx.units(5000);
  for (const ln of page.lines) {
    const t = ln.text.trim();
    if (!ROOM_WORDS.test(t) || parseTag(t) || t.length > 32) continue;
    if (findExpressions(t).some((e) => e.kind === "dim" || e.kind === "pair") && !/[A-Za-z]{3}/.test(t)) continue;
    if (!view.bbox.contains(ln.bbox, 2)) continue;
    const dist = d.bbox.distanceTo(ln.bbox);
    if (dist > reach) continue;
    if (best === null || dist < best[0]) best = [dist, t];
  }
  return best ? best[1] : null;
}
