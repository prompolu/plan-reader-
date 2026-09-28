/**
 * Split a sheet into drawing views (a sheet often holds several elevations,
 * or a plan plus a schedule) and determine each view's type and scale.
 */
import { classifyTypeFromText, findViewTitles } from "./classify";
import { findScaleMentions, noScale, type ScaleMention } from "./scale";
import { BBox, SCHEDULE_TYPES, ScaleInfo, View, type PageClassification, type PageData, type TextLine } from "./types";
import { Grid } from "./grid";
import { minBy } from "./py";

const RE_ENLARGED = /\bENLARGED|\bPART\s+PLAN|\bDETAIL/i;
const RE_AS_SHOWN = /\bAS\s+(SHOWN|NOTED|INDICATED)\b/i;

function frameSegments(page: PageData): Set<number> {
  const out = new Set<number>();
  page.geometry.segments.forEach((s, i) => {
    const o = s.orientation();
    if (o === "h" && s.length > 0.7 * page.width) out.add(i);
    else if (o === "v" && s.length > 0.7 * page.height) out.add(i);
  });
  return out;
}

export function sheetScale(page: PageData, cls: PageClassification): [ScaleInfo, ScaleMention[]] {
  const mentions = findScaleMentions(page.lines);
  const tb = cls.titleBlock;
  const inTb = mentions.filter((m) => tb !== null && tb.contains(m.bbox, 2));
  let info = noScale();
  for (const m of inTb) {
    if (m.ratio) {
      info = new ScaleInfo(m.text, m.ratio, "detected", m.labelled ? 0.9 : 0.75, m.bbox);
      break;
    }
    if (m.nts) info = new ScaleInfo(m.text, null, "detected", 0.9, m.bbox, true);
  }
  if (tb !== null && info.ratio === null && !info.notToScale) {
    for (const ln of page.lines) {
      if (tb.contains(ln.bbox, 2) && RE_AS_SHOWN.test(ln.text)) info.notes.push("Title block scale: AS SHOWN (per view)");
    }
  }
  return [info, mentions];
}

const trunc = Math.trunc;

export function segmentViews(page: PageData, cls: PageClassification): View[] {
  const tb = cls.titleBlock;
  const [sheetInfo, mentions] = sheetScale(page, cls);
  const cell = Math.max(page.width, page.height) / 200;
  const gw = trunc(page.width / cell) + 2;
  const gh = trunc(page.height / cell) + 2;
  const grid = new Grid(gw, gh);
  const frame = frameSegments(page);
  const excluded = (b: BBox) => tb !== null && tb.expand(2).contains(b);

  page.geometry.segments.forEach((s, i) => {
    if (frame.has(i) || excluded(s.bbox)) return;
    grid.line(trunc(s.x0 / cell), trunc(s.y0 / cell), trunc(s.x1 / cell), trunc(s.y1 / cell));
  });
  for (const a of page.geometry.arcs) {
    const b = a.bbox;
    if (!excluded(b)) grid.fillRect(trunc(b.x0 / cell), trunc(b.y0 / cell), trunc(b.x1 / cell), trunc(b.y1 / cell));
  }
  for (const [cx, cy, r] of page.geometry.circles) {
    if (!excluded(new BBox(cx - r, cy - r, 2 * r, 2 * r))) grid.circle(trunc(cx / cell), trunc(cy / cell), Math.max(trunc(r / cell), 1));
  }
  for (const ln of page.lines) {
    if (excluded(ln.bbox)) continue;
    const b = ln.bbox;
    grid.fillRect(trunc(b.x0 / cell), trunc(b.y0 / cell), trunc(b.x1 / cell), trunc(b.y1 / cell));
  }
  grid.dilate3(2);
  const regions: BBox[] = grid.components().map(({ x, y, w, h }) => new BBox((x + 2) * cell, (y + 2) * cell, Math.max(w - 4, 1) * cell, Math.max(h - 4, 1) * cell));

  const titles = findViewTitles(page, tb);
  // region membership
  const titleRegion = new Map<number, number>();
  titles.forEach((t, ti) => {
    const typ = classifyTypeFromText(t.text) ?? "other";
    let best: number | null = null;
    let bestD: number | null = null;
    regions.forEach((r, ri) => {
      let d: number;
      if (r.contains(t.bbox, cell) && r.area > 4 * t.bbox.area * 4) {
        // a real drawing region containing the title (e.g. table with title inside)
        d = 0;
      } else if (SCHEDULE_TYPES.has(typ)) {
        // schedule titles sit above their table
        if (r.y0 < t.bbox.y1 - cell || r.y0 - t.bbox.y1 > 0.08 * page.height) return;
        if (Math.min(r.x1, t.bbox.x1 + page.width * 0.3) < Math.max(r.x0, t.bbox.x0 - cell)) return;
        d = r.y0 - t.bbox.y1;
      } else {
        // drawing views sit above their title
        if (r.y1 > t.bbox.y0 + cell || t.bbox.y0 - r.y1 > 0.12 * page.height) return;
        if (Math.min(r.x1, t.bbox.x1) < Math.max(r.x0, t.bbox.x0) - 0.1 * page.width) return;
        d = t.bbox.y0 - r.y1;
      }
      if (r.area < 2 * t.bbox.area * 4) return; // the title's own little component
      if (bestD === null || d < bestD) {
        best = ri;
        bestD = d;
      }
    });
    if (best !== null) titleRegion.set(ti, best);
  });

  const views: View[] = [];
  const usedRegions = new Set<number>();
  for (const [ti, ri] of titleRegion) {
    if (usedRegions.has(ri)) continue; // two titles for one region: keep the first
    usedRegions.add(ri);
    const t = titles[ti];
    let typ = classifyTypeFromText(t.text) ?? cls.pageType;
    if (typ === "floor_plan" && cls.pageType === "detail") typ = "detail";
    const vb = regions[ri].union(t.bbox);
    const scale = viewScale(t, mentions, sheetInfo, page);
    views.push(new View(`p${page.index}-v${views.length}`, vb, typ, t.text.trim(), t.bbox, scale, RE_ENLARGED.test(t.text)));
  }
  // untitled regions: attach to the page type if they carry drawing geometry
  const titleBoxes = titles.map((t) => t.bbox);
  regions.forEach((r, ri) => {
    if (usedRegions.has(ri)) return;
    if (titleBoxes.some((b) => r.contains(b, cell)) && r.area < 6 * Math.max(...titleBoxes.map((b) => b.area))) return; // just a title / scale caption
    if (r.w < 3 * cell && r.h < 3 * cell) return;
    const segs = page.geometry.segments.filter((s) => r.contains(s.bbox, cell)).length;
    const texts = page.lines.filter((ln) => r.contains(ln.bbox, cell));
    const vtype = segs < 6 && texts.length ? "notes" : cls.pageType;
    // fold into an existing titled view it overlaps
    for (const v of views) {
      if (v.bbox.intersectionArea(r) > 0.5 * r.area) {
        v.bbox = v.bbox.union(r);
        return;
      }
    }
    views.push(new View(`p${page.index}-v${views.length}`, r, vtype, null, null, vtype !== "notes" ? sheetInfo : noScale(), cls.pageType === "detail"));
  });
  if (!views.length) views.push(new View(`p${page.index}-v0`, new BBox(0, 0, page.width, page.height), cls.pageType, cls.sheetTitle, null, sheetInfo, cls.pageType === "detail"));
  return views;
}

/** Scale written in / right under the view title, else the sheet scale. */
function viewScale(title: TextLine, mentions: ScaleMention[], sheetInfo: ScaleInfo, page: PageData): ScaleInfo {
  let best: [number, ScaleMention] | null = null;
  for (const m of mentions) {
    const b = m.bbox;
    if (
      m.line === title ||
      (b.cy - title.bbox.cy >= 0 && b.cy - title.bbox.cy < 4 * Math.max(title.size, 1) && Math.abs(b.x0 - title.bbox.x0) < 0.25 * page.width) ||
      (Math.abs(b.cy - title.bbox.cy) < title.size && b.x0 - title.bbox.x1 >= 0 && b.x0 - title.bbox.x1 < 0.2 * page.width)
    ) {
      const d = Math.abs(b.cy - title.bbox.cy) + Math.abs(b.x0 - title.bbox.x0) * 0.1;
      if (best === null || d < best[0]) best = [d, m];
    }
  }
  if (best !== null) {
    const m = best[1];
    return new ScaleInfo(m.text, m.ratio, "detected", m.ratio ? 0.92 : 0.8, m.bbox, m.nts);
  }
  return sheetInfo;
}

export function viewFor(views: View[], b: BBox): View {
  const inside = views.filter((v) => v.bbox.containsPoint(b.cx, b.cy));
  if (inside.length) return minBy(inside, (v) => v.bbox.area);
  return minBy(views, (v) => v.bbox.distanceTo(b));
}

/** The view a box belongs to (inside, else within 20 units), or null. */
export function viewOf(views: View[], b: BBox): View | null {
  const inside = views.filter((v) => v.bbox.containsPoint(b.cx, b.cy));
  if (inside.length) return minBy(inside, (v) => v.bbox.area);
  const near = views.filter((v) => v.bbox.distanceTo(b) < 20);
  return near.length ? minBy(near, (v) => v.bbox.distanceTo(b)) : null;
}
