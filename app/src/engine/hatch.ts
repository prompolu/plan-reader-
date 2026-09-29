/**
 * Fill patterns (hatches): brick, tiles, insulation, grass ... drawn as many
 * identical short lines repeated at a regular spacing. They are neither walls
 * nor openings; a stack of hatch lines along a wall otherwise looks like the
 * glazing lines of a window.
 */
import type { Segment } from "./types";

/** Lines repeated at least this many times in a regular run are a pattern. */
const MIN_RUN = 6;

interface Item {
  s: Segment;
  /** position across the lines (y for horizontal lines, x for vertical ones) */
  across: number;
}

export function hatchSegments(segments: Segment[]): Set<Segment> {
  const out = new Set<Segment>();
  const buckets = new Map<string, Item[]>();
  for (const s of segments) {
    const o = s.orientation(1);
    if (o === null || s.length < 0.5) continue;
    const len = s.length;
    // same length, same line weight, same start along the line
    const along = o === "h" ? Math.min(s.x0, s.x1) : Math.min(s.y0, s.y1);
    const key = `${o}|${Math.round(len * 4)}|${Math.round(s.width * 20)}|${Math.round(along * 2)}`;
    const it = { s, across: o === "h" ? s.y0 : s.x0 };
    const b = buckets.get(key);
    if (b) b.push(it);
    else buckets.set(key, [it]);
  }
  for (const items of buckets.values()) {
    if (items.length < MIN_RUN) continue;
    items.sort((a, b) => a.across - b.across);
    const len = items[0].s.length;
    // runs of lines at a constant spacing, close together compared to their length
    let start = 0;
    for (let i = 1; i <= items.length; i++) {
      const gap = i < items.length ? items[i].across - items[i - 1].across : Infinity;
      const first = start + 1 < items.length ? items[start + 1].across - items[start].across : Infinity;
      const regular = i < items.length && gap > 0.2 && gap < Math.max(4 * len, 12) && Math.abs(gap - first) <= 0.2 * first + 0.3;
      if (regular) continue;
      if (i - start >= MIN_RUN) for (let k = start; k < i; k++) out.add(items[k].s);
      start = i;
    }
  }
  return out;
}
