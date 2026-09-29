/** Opening tag detection (D-01, W03, SD-1, GD-01, ...). */
import { BBox, type PageData, type Pt, type Segment, type TagDetection, type TextLine, type View } from "./types";
import { normalizeChars } from "./units";
import { viewOf } from "./views";

/** prefix -> opening class hint */
export const TAG_PREFIXES: Record<string, string> = {
  D: "door",
  DR: "door",
  DT: "door", // door type
  DD: "double_door",
  ED: "door",
  FD: "door",
  SD: "sliding_door",
  GD: "garage_door",
  RD: "garage_door", // roller door
  W: "window",
  WN: "window",
  WD: "window",
  WT: "window", // window type
  WIN: "window",
  SW: "sliding_window",
  CW: "curtain_wall",
  OP: "opening",
  // French: porte, fenêtre, porte-fenêtre, châssis, baie vitrée, porte de garage, porte / fenêtre coulissante, mur-rideau
  P: "door",
  F: "window",
  PF: "door",
  CH: "window",
  BV: "sliding_window",
  PG: "garage_door",
  PC: "sliding_door",
  FC: "sliding_window",
  MR: "curtain_wall",
  GC: "railing", // garde-corps
  // Spanish: ventana, puerta-ventana
  V: "window",
  PV: "door",
};

/** What a prefix means on drawings in another language, where it differs. */
const PREFIX_BY_LANGUAGE: Record<string, Record<string, string>> = {
  fr: { GD: "railing" }, // garde-corps (a GD on a French drawing is never a garage door)
};

export const PREFIX_ALIASES: Record<string, string> = { DR: "D", WN: "W", WD: "W", WIN: "W" };

export const RE_TAG = /(?<![A-Za-z0-9])(?<prefix>[A-Z]{1,3})[-.\s]?(?<num>\d{1,3})(?<suffix>[A-Z]?)(?![A-Za-z0-9])/g;
const RE_TAG_FULL = /^(?<prefix>[A-Z]{1,3})[-.\s]?(?<num>\d{1,3})(?<suffix>[A-Z]?)$/;

export function tagKey(prefix: string, num: string, suffix = ""): string {
  const p = PREFIX_ALIASES[prefix.toUpperCase()] ?? prefix.toUpperCase();
  return `${p}${parseInt(num, 10)}${suffix.toUpperCase()}`;
}

/** Return [prefix, key, text] if `text` is exactly one tag. */
export function parseTag(text: string): [string, string, string] | null {
  const t = normalizeChars(text).trim();
  const m = RE_TAG_FULL.exec(t);
  if (!m || !(m.groups!.prefix in TAG_PREFIXES)) return null;
  // the full-match must also respect the token boundaries of RE_TAG
  return [m.groups!.prefix, tagKey(m.groups!.prefix, m.groups!.num, m.groups!.suffix), t];
}

export function tagClass(prefix: string, language?: string): string {
  const p = prefix.toUpperCase();
  return (language && PREFIX_BY_LANGUAGE[language]?.[p]) ?? TAG_PREFIXES[p] ?? "other";
}

export function* tagMatches(s: string): Generator<RegExpExecArray> {
  RE_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TAG.exec(s)) !== null) yield m;
  RE_TAG.lastIndex = 0;
}

/** The tag symbol (circle / hexagon / diamond / box) drawn around tag text. */
function enclosure(page: PageData, b: BBox): ["circle" | "polygon" | "rect", BBox] | null {
  const cx = b.cx;
  const cy = b.cy;
  const half = Math.max(b.w, b.h) / 2;
  for (const [ex, ey, r] of page.geometry.circles) {
    if (Math.hypot(ex - cx, ey - cy) < 0.35 * r + 1 && half * 0.8 <= r && r <= half * 3.5 + 2) return ["circle", new BBox(ex - r, ey - r, 2 * r, 2 * r)];
  }
  for (const poly of page.geometry.polygons) {
    const pb = BBox.around(poly);
    if (pb.contains(b, 1) && pb.area < 12 * Math.max(b.area, 1)) return ["polygon", pb];
  }
  for (const r of page.geometry.rects) {
    if (r.contains(b, 1) && r.area < 8 * Math.max(b.area, 1)) return ["rect", r];
  }
  return null;
}

/** Find tag tokens in drawing views (not in title blocks, notes or schedules). */
export function detectTags(page: PageData, views: View[], titleBlock: BBox | null, drawingViews: Set<string>): TagDetection[] {
  const out: TagDetection[] = [];
  let n = 0;
  for (const ln of page.lines) {
    if (titleBlock !== null && titleBlock.contains(ln.bbox, 2)) continue;
    const view = viewOf(views, ln.bbox);
    if (view === null || !drawingViews.has(view.viewType)) continue;
    const norm = normalizeChars(ln.text);
    for (const m of tagMatches(norm)) {
      const prefix = m.groups!.prefix;
      if (!(prefix in TAG_PREFIXES)) continue;
      // a tag token is short; long sentences mentioning "W1" are notes
      if (norm.trim().length > 14 && !standsAlone(norm, m)) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      const bb = ln.subBBox(start, end);
      const found = enclosure(page, bb);
      let conf = found ? 0.97 : 0.82;
      if (ln.source === "ocr") conf *= Math.max(0.5, ln.confidence);
      out.push({
        id: `p${page.index}-t${n}`,
        pageIndex: page.index,
        text: ln.text.slice(start, end),
        key: tagKey(prefix, m.groups!.num, m.groups!.suffix),
        prefix: PREFIX_ALIASES[prefix] ?? prefix,
        bbox: bb,
        confidence: conf,
        enclosure: found ? found[0] : null,
        lineId: ln.id,
        viewId: view.id,
        enclosureBBox: found ? found[1] : null,
      });
      n++;
    }
  }
  return out;
}

function standsAlone(s: string, m: RegExpExecArray): boolean {
  const before = s.slice(0, m.index).trim();
  const after = s.slice(m.index + m[0].length).trim();
  return before.length <= 2 && after.length <= 12;
}

export function isTagText(ln: TextLine): boolean {
  return parseTag(ln.text) !== null;
}

/**
 * Leader lines: a thin line (sometimes with a bend) drawn from a tag to the
 * element it names, when the tag cannot sit right next to it. Records where
 * each tag's leader ends.
 */
export function findLeaders(page: PageData, tags: TagDetection[], exclude: Set<Segment>): void {
  if (!tags.length) return;
  const segs = page.geometry.segments.filter((s) => !exclude.has(s) && s.length > 1);
  const widths = segs.filter((s) => s.length > 20 && s.width > 0).map((s) => s.width);
  const heavy = widths.length ? Math.max(...widths) : Infinity;
  const near = (p: Pt, b: BBox, tol: number) => b.expand(tol).containsPoint(p[0], p[1]);
  for (const t of tags) {
    // a tag drawn in a symbol (circle, hexagon, box) sits at its opening; leaders go with bare text tags
    if (t.enclosure) {
      t.leaderTo = null;
      continue;
    }
    const box = t.bbox;
    const h = Math.max(t.bbox.h, 1);
    const tol = Math.max(2, 0.8 * h);
    let best: [number, Pt] | null = null;
    for (const s of segs) {
      if (s.length < 1.2 * h || s.length > 30 * h || (s.width > 0 && s.width >= heavy && heavy > 0)) continue;
      const a: Pt = [s.x0, s.y0];
      const b: Pt = [s.x1, s.y1];
      let from: Pt | null = null;
      let to: Pt | null = null;
      if (near(a, box, tol) && !near(b, box, tol)) [from, to] = [a, b];
      else if (near(b, box, tol) && !near(a, box, tol)) [from, to] = [b, a];
      if (!from || !to) continue;
      // a line crossing the tag (hatch, grid) is not its leader
      if (box.containsPoint((from[0] + to[0]) / 2, (from[1] + to[1]) / 2)) continue;
      const o = s.orientation(1);
      if (o !== null) {
        // grid and hatch lines are interrupted around text: the same straight line
        // carrying on at the other side of the tag is not a leader
        const cc = s.crossCoord(o);
        const continues = segs.some(
          (x) =>
            x !== s &&
            x.orientation(1) === o &&
            Math.abs(x.crossCoord(o) - cc) < 0.5 &&
            (near([x.x0, x.y0], box, tol + h) || near([x.x1, x.y1], box, tol + h)) &&
            sideOf(x, box, o) !== sideOf(s, box, o),
        );
        if (continues) continue;
      }
      // follow a bend: another thin line starting where this one ends
      let end = to;
      let reach = s.length;
      for (let k = 0; k < 2; k++) {
        const cont = segs.find((x) => x !== s && x.length > 1 && x.length < 30 * h && (Math.hypot(x.x0 - end[0], x.y0 - end[1]) < 0.5 || Math.hypot(x.x1 - end[0], x.y1 - end[1]) < 0.5));
        if (!cont) break;
        const nxt: Pt = Math.hypot(cont.x0 - end[0], cont.y0 - end[1]) < 0.5 ? [cont.x1, cont.y1] : [cont.x0, cont.y0];
        if (near(nxt, box, tol)) break;
        end = nxt;
        reach += cont.length;
      }
      // leaders are usually drawn at an angle; a straight horizontal/vertical one ranks lower
      const rank = reach * (o === null ? 2 : 1);
      if (best === null || rank > best[0]) best = [rank, end];
    }
    t.leaderTo = best ? best[1] : null;
  }
}

/** Which side of the box a horizontal (-1 left / +1 right) or vertical (-1 above / +1 below) line lies on. */
function sideOf(s: Segment, box: BBox, o: "h" | "v"): number {
  const mid = o === "h" ? (s.x0 + s.x1) / 2 : (s.y0 + s.y1) / 2;
  const c = o === "h" ? box.cx : box.cy;
  return Math.sign(mid - c);
}

/** Segments that form tag symbols - annotation, not building geometry. */
export function symbolSegments(page: PageData, tags: TagDetection[]): Set<Segment> {
  const boxes = tags.filter((t) => t.enclosureBBox !== null).map((t) => t.enclosureBBox!.expand(0.5));
  const out = new Set<Segment>();
  if (!boxes.length) return out;
  for (const s of page.geometry.segments) {
    const sb = s.bbox;
    if (boxes.some((b) => b.contains(sb))) out.add(s);
  }
  return out;
}
