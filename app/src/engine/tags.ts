/** Opening tag detection (D-01, W03, SD-1, GD-01, ...). */
import { BBox, type PageData, type Segment, type TagDetection, type TextLine, type View } from "./types";
import { normalizeChars } from "./units";
import { viewOf } from "./views";

/** prefix -> opening class hint */
export const TAG_PREFIXES: Record<string, string> = {
  D: "door",
  DR: "door",
  DD: "double_door",
  ED: "door",
  FD: "door",
  SD: "sliding_door",
  GD: "garage_door",
  RD: "garage_door", // roller door
  W: "window",
  WN: "window",
  WD: "window",
  WIN: "window",
  SW: "sliding_window",
  CW: "curtain_wall",
  OP: "opening",
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

export function tagClass(prefix: string): string {
  return TAG_PREFIXES[prefix.toUpperCase()] ?? "other";
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
