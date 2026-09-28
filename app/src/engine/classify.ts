/**
 * Page classification: page type, sheet number/title, floor, unit convention.
 *
 * Signals are combined into per-type scores; the sheet title in the title
 * block weighs most, then view titles, then content features (door swings,
 * tables, text density). Every signal is recorded for transparency.
 */
import { BBox, type PageClassification, type PageData, type Signal, type TextLine } from "./types";
import { median, maxBy, pyRound, sortedBy } from "./py";

const RE_SHEET_NUMBER = /^(?:[A-Z]{1,3}[-.\s]?\d{1,4}(?:\.\d{1,3})?[A-Z]?)$/;
const TITLE_BLOCK_LABELS =
  /^(SHEET(\s+(NO|NUMBER|TITLE))?\.?|DRAWING\s+(NO|NUMBER|TITLE)\.?|DWG\.?\s*NO\.?|SCALE|DATE|REV(ISION)?\.?|PROJECT(\s+NO\.?)?|DRAWN(\s+BY)?|CHECKED(\s+BY)?|CLIENT|TITLE|JOB\s+NO\.?)[:.]?$/i;

/** (type, regex). Order matters for overlapping phrases. */
export const TYPE_PATTERNS: [string, RegExp][] = [
  ["site_plan", /\b(SITE\s+PLAN|LOCATION\s+PLAN|SITE\s+ANALYSIS|BLOCK\s+PLAN)\b/i],
  ["opening_schedule", /\b(OPENING\s+SCHEDULE|DOOR\s*(?:AND|&|\/)\s*WINDOW\s+SCHEDULES?|WINDOW\s*(?:AND|&|\/)\s*DOOR\s+SCHEDULES?)\b/i],
  ["door_schedule", /\bDOOR\s+SCHEDULE\b/i],
  ["window_schedule", /\bWINDOW\s+SCHEDULE\b/i],
  ["detail", /\b(DETAILS?|ENLARGED\s+\w+(\s+\w+)?\s+PLAN|ENLARGED\s+PLAN|PART\s+PLAN)\b/i],
  ["elevation", /\bELEVATIONS?\b/i],
  ["section", /\bSECTIONS?\b(?!\s+\d)/i],
  ["cover", /\b(COVER\s+(SHEET|PAGE)|TITLE\s+SHEET|DRAWING\s+(LIST|INDEX|REGISTER)|SHEET\s+INDEX)\b/i],
  ["notes", /\b(GENERAL\s+NOTES|NOTES|SPECIFICATIONS?|LEGEND|ABBREVIATIONS)\b/i],
  ["floor_plan", /\b((GROUND|FIRST|SECOND|THIRD|FOURTH|UPPER|LOWER|MAIN|BASEMENT|MEZZANINE|ATTIC)\s+(FLOOR|LEVEL)(\s+PLAN)?|FLOOR\s+PLAN|LEVEL\s+\d+\s+PLAN|L\d+\s+PLAN|\bPLAN\b)/i],
];

const SHEET_PREFIX_HINT: [RegExp, string, number][] = [
  [/^A[-.\s]?0/, "cover", 0.2],
  [/^A[-.\s]?1/, "floor_plan", 0.5],
  [/^A[-.\s]?2/, "elevation", 0.5],
  [/^A[-.\s]?3/, "section", 0.5],
  [/^A[-.\s]?5/, "detail", 0.4],
  [/^A[-.\s]?6/, "opening_schedule", 0.4],
];

const FLOOR_PATTERNS: [RegExp, string][] = [
  [/\bBASEMENT\b/i, "Basement"],
  [/\bGROUND\s+(FLOOR|LEVEL)\b/i, "Ground Floor"],
  [/\bFIRST\s+(FLOOR|LEVEL)\b/i, "First Floor"],
  [/\bSECOND\s+(FLOOR|LEVEL)\b/i, "Second Floor"],
  [/\bTHIRD\s+(FLOOR|LEVEL)\b/i, "Third Floor"],
  [/\bMEZZANINE\b/i, "Mezzanine"],
  [/\bROOF\s+PLAN\b/i, "Roof"],
  [/\bLEVEL\s+0?(\d{1,2})\b/i, "Level {0}"],
  [/\bL0?(\d{1,2})\s+PLAN\b/i, "Level {0}"],
  [/\bUPPER\s+FLOOR\b/i, "Upper Floor"],
  [/\bLOWER\s+FLOOR\b/i, "Lower Floor"],
];

const UNIT_NOTES: [RegExp, string][] = [
  [/\b(IN\s+)?MILLIMET(RE|ER)S?\b|\bDIMENSIONS\s+(ARE\s+)?IN\s+MM\b/i, "mm"],
  [/\bDIMENSIONS\s+(ARE\s+)?IN\s+METRES?\b|\bIN\s+METERS\b/i, "m"],
  [/\bFEET\s+AND\s+INCHES\b|\bIN\s+FEET\b|\bIMPERIAL\b/i, "in"],
];

const SCHEDULE_HEADERS = /^(MARK|TAG|NO\.?|REF\.?|ID|TYPE|WIDTH|HEIGHT|SIZE|QTY|QUANTITY|SILL|REMARKS|NOTES|FRAME|FINISH|HARDWARE|W|H)$/i;

/** Locate the title block from its field labels (SHEET, SCALE, DATE ...). */
export function detectTitleBlock(page: PageData): BBox | null {
  const labels = page.lines.filter((ln) => TITLE_BLOCK_LABELS.test(ln.text.trim()));
  if (labels.length < 2) return null;
  // the title block is the densest cluster of labels, usually near the right/bottom edge
  let best: TextLine[] | null = null;
  for (const anchor of labels) {
    const near = labels.filter((ln) => ln.bbox.distanceTo(anchor.bbox) < 0.25 * Math.max(page.width, page.height));
    if (best === null || near.length > best.length) best = near;
  }
  let bb = best![0].bbox;
  for (const ln of best!.slice(1)) bb = bb.union(ln.bbox);
  // prefer an enclosing ruled rectangle when there is one
  let rect: BBox | null = null;
  for (const r of page.geometry.rects) {
    if (r.contains(bb, 1) && r.area < 0.35 * page.width * page.height) {
      if (rect === null || r.area < rect.area) rect = r;
    }
  }
  if (rect === null) {
    // grow to include text immediately around the labels (values under labels, firm name, ...)
    const grow = bb.expand(0.06 * Math.max(page.width, page.height));
    for (const ln of page.lines) if (grow.contains(ln.bbox)) bb = bb.union(ln.bbox);
    for (const s of page.geometry.segments) if (s.length > 20 && grow.contains(s.bbox)) bb = bb.union(s.bbox);
    return bb;
  }
  // the box may be split into cells; take the union of cells that share its outer frame
  return growToFrame(page, rect);
}

function growToFrame(page: PageData, rect: BBox): BBox {
  let out = rect;
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of page.geometry.rects) {
      if (r === rect || r.area > 0.35 * page.width * page.height) continue;
      if (r.intersectionArea(out) > 0 || out.distanceTo(r) < 1) {
        const u = out.union(r);
        if (u.area < 0.35 * page.width * page.height && (u.x0 !== out.x0 || u.y0 !== out.y0 || u.x1 !== out.x1 || u.y1 !== out.y1)) {
          out = u;
          changed = true;
        }
      }
    }
  }
  return out;
}

function linesIn(page: PageData, box: BBox | null): TextLine[] {
  if (box === null) return [];
  return page.lines.filter((ln) => box.contains(ln.bbox, 1));
}

export function sheetNumberAndTitle(page: PageData, tb: BBox | null): [string | null, string | null, TextLine | null] {
  const lines = linesIn(page, tb);
  let number: string | null = null;
  let numberLine: TextLine | null = null;
  let cands = lines.filter((ln) => RE_SHEET_NUMBER.test(ln.text.trim()) && !/^\d/.test(ln.text.trim()));
  cands = cands.filter((ln) => !/^(REV|NO)\b/i.test(ln.text.trim()));
  if (cands.length) {
    // prefer the one right below/after a SHEET / DRAWING NO label, else the largest font
    const labelled: TextLine[] = [];
    for (const c of cands) {
      for (const lab of lines) {
        if (/^(SHEET|DRAWING\s+NO|DWG)/i.test(lab.text.trim()) && c.bbox.cy - lab.bbox.cy >= 0 && c.bbox.cy - lab.bbox.cy < 6 * Math.max(lab.size, 1) && Math.abs(c.bbox.x0 - lab.bbox.x0) < 40) labelled.push(c);
      }
    }
    const pool = labelled.length ? labelled : cands;
    numberLine = maxBy(pool, (ln) => ln.size);
    number = numberLine.text.trim().replace(/\s+/g, "");
  }
  let title: string | null = null;
  const titleCands: [number, TextLine][] = [];
  for (const ln of lines) {
    const t = ln.text.trim();
    if (ln === numberLine || TITLE_BLOCK_LABELS.test(t) || t.length < 4 || !/[A-Za-z]{3}/.test(t)) continue;
    let score = ln.size;
    if (TYPE_PATTERNS.some(([, p]) => p.test(t))) score += 20;
    // a label "DRAWING TITLE"/"TITLE" right above it
    for (const lab of lines) {
      if (/^(DRAWING\s+TITLE|SHEET\s+TITLE|TITLE)$/i.test(lab.text.trim()) && ln.bbox.cy - lab.bbox.cy > 0 && ln.bbox.cy - lab.bbox.cy < 5 * Math.max(lab.size, 1)) score += 30;
    }
    titleCands.push([score, ln]);
  }
  if (titleCands.length) title = maxBy(titleCands, (t) => t[0])[1].text.trim();
  return [number, title, numberLine];
}

export function detectFloor(texts: string[]): string | null {
  for (const t of texts) {
    for (const [rx, label] of FLOOR_PATTERNS) {
      const m = rx.exec(t);
      if (m) {
        if (label.includes("{0}")) return label.replace("{0}", String(parseInt(m[1], 10)));
        return label;
      }
    }
  }
  return null;
}

/** Headline text outside the title block that names a view (PLAN, ELEVATION, ...). */
export function findViewTitles(page: PageData, tb: BBox | null): TextLine[] {
  const sizes = page.lines.map((ln) => ln.size).filter((s) => s > 0);
  if (!sizes.length) return [];
  const med = median(sizes);
  const out: TextLine[] = [];
  for (const ln of page.lines) {
    if (tb !== null && tb.contains(ln.bbox, 2)) continue;
    const t = ln.text.trim();
    if (t.length < 4 || t.length > 60) continue;
    if (!TYPE_PATTERNS.some(([, p]) => p.test(t))) continue;
    const underlined = page.geometry.segments.some(
      (s) =>
        Math.abs(s.y0 - ln.bbox.y1) < 2 * Math.max(ln.size, 1) &&
        s.orientation() === "h" &&
        s.y0 - ln.bbox.y1 > 0 &&
        s.y0 - ln.bbox.y1 < 0.8 * Math.max(ln.size, 1) &&
        s.x0 <= ln.bbox.x0 + 2 &&
        s.x1 >= ln.bbox.x1 - 2,
    );
    if (ln.size >= 1.25 * med || underlined) out.push(ln);
  }
  return out;
}

export function classifyTypeFromText(t: string): string | null {
  for (const [typ, rx] of TYPE_PATTERNS) if (rx.test(t)) return typ;
  return null;
}

export function detectDefaultUnit(page: PageData, scaleTexts: string[]): [string, string] {
  for (const ln of page.lines) for (const [rx, unit] of UNIT_NOTES) if (rx.test(ln.text)) return [unit, "note"];
  for (const s of scaleTexts) {
    if (s && s.includes(":")) return ["mm", "scale"];
    if (s && s.includes("=")) return ["in", "scale"];
  }
  // imperial notation present in the text -> feet/inches drawing
  const imperial = page.lines.filter((ln) => /\d'\s*-?\s*\d+"/.test(ln.text)).length;
  if (imperial >= 3) return ["in", "notation"];
  return ["mm", "assumed"];
}

export function classifyPage(page: PageData, scaleTexts: string[] = []): PageClassification {
  const tb = detectTitleBlock(page);
  const [number, title] = sheetNumberAndTitle(page, tb);
  const scores = new Map<string, number>();
  const signals: Signal[] = [];
  const add = (typ: string, w: number, code: string, detail: string) => {
    scores.set(typ, (scores.get(typ) ?? 0) + w);
    signals.push({ type: typ, weight: pyRound(w, 2), code, detail });
  };

  if (title) {
    const typ = classifyTypeFromText(title);
    if (typ) add(typ, 3, "sheet_title", `Sheet title "${title}"`);
  }
  const viewTitles = findViewTitles(page, tb);
  let seenTitles = 0;
  const kindsInTitles = new Set<string>();
  for (const vt of viewTitles) {
    const typ = classifyTypeFromText(vt.text);
    if (typ) {
      kindsInTitles.add(typ);
      if (seenTitles < 4) {
        add(typ, 1.5, "view_title", `View title "${vt.text.trim()}"`);
        seenTitles++;
      }
    }
  }
  if (kindsInTitles.has("door_schedule") && kindsInTitles.has("window_schedule")) add("opening_schedule", 2, "view_title", "Both door and window schedules on sheet");

  // content features
  const g = page.geometry;
  const nArcs = g.arcs.filter((a) => a.sweepDeg >= 70 && a.sweepDeg <= 110).length;
  if (nArcs >= 2) add("floor_plan", Math.min(1.5, 0.3 * nArcs), "door_swings", `${nArcs} door swing arcs`);
  const headerRows = new Map<number, number>();
  for (const ln of page.lines) {
    if (!SCHEDULE_HEADERS.test(ln.text.trim())) continue;
    const k = pyRound(ln.bbox.cy / 4);
    headerRows.set(k, (headerRows.get(k) ?? 0) + 1);
  }
  if (headerRows.size && Math.max(...headerRows.values()) >= 3) add("opening_schedule", 1.5, "table_header", "Table header with MARK/WIDTH/HEIGHT columns");
  const body = page.lines.filter((ln) => !(tb && tb.contains(ln.bbox, 2)));
  const longText = body.filter((ln) => ln.text.length > 35);
  if (longText.length >= 5 && longText.length > 0.35 * Math.max(body.length, 1) && nArcs === 0) add("notes", 1.2, "text_density", `${longText.length} long text lines`);
  if (number) {
    for (const [rx, typ, w] of SHEET_PREFIX_HINT) {
      if (rx.test(number)) {
        add(typ, w, "sheet_number", `Sheet number ${number} (discipline numbering convention)`);
        break;
      }
    }
  }
  // body keyword mentions (weak: e.g. "REFER TO WINDOW SCHEDULE" on a plan)
  const mention = new Map<string, number>();
  for (const ln of body) {
    const typ = classifyTypeFromText(ln.text);
    if (typ) mention.set(typ, (mention.get(typ) ?? 0) + 1);
  }
  for (const [typ, c] of mention) add(typ, Math.min(0.6, 0.15 * c), "keyword", `${c} mention(s) in drawing text`);

  // schedule type refinement
  if ((scores.get("door_schedule") ?? 0) && (scores.get("window_schedule") ?? 0)) {
    scores.set("opening_schedule", (scores.get("opening_schedule") ?? 0) + 0.5 * Math.min(scores.get("door_schedule")!, scores.get("window_schedule")!));
  }

  let pageType: string;
  let conf: number;
  const ranked = sortedBy([...scores.entries()], (kv) => -kv[1]);
  if (!ranked.length) {
    pageType = "other";
    conf = 0.3;
  } else {
    const top = ranked[0][1];
    pageType = ranked[0][0];
    const second = ranked.length > 1 ? ranked[1][1] : 0;
    conf = Math.min(0.99, 0.45 + 0.12 * top + (0.15 * (top - second)) / Math.max(top, 1e-6));
    if (top < 1) conf = Math.min(conf, 0.5);
  }
  const secondary = ranked.filter(([t, s]) => t !== pageType && s >= 1).map(([t]) => t);
  const texts = [title ?? "", ...viewTitles.map((vt) => vt.text)];
  const floor = pageType === "floor_plan" || pageType === "detail" ? detectFloor(texts) : null;
  const [unit, basis] = detectDefaultUnit(page, scaleTexts);
  return { pageType, confidence: conf, signals, secondaryTypes: secondary, sheetNumber: number, sheetTitle: title, floor, titleBlock: tb, defaultUnit: unit, unitBasis: basis };
}
