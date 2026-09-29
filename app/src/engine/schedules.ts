/**
 * Door / window / opening schedule extraction.
 *
 * Schedules are used as a cross-reference. A schedule row is *type* data
 * (size and quantity per tag); it is never counted as a physical opening.
 */
import { parseTag } from "./tags";
import type { BBox, PageClassification, PageData, ParsedMeasurement, ScheduleEntry, TextLine, View } from "./types";
import { normalizeChars, parseDimension, parseSize } from "./units";
import { mean, median, sortedBy } from "./py";

const HEADER_ALIASES: [string, RegExp][] = [
  ["tag", /^(MARK|TAG|NO\.?|NUMBER|REF\.?|ID|DOOR\s*(NO|MARK)\.?|WINDOW\s*(NO|MARK)\.?|CODE|REP[EÈ]RE|R[EÉ]F[EÉ]RENCE|R[EÉ]F\.?|N[°º]|MARCA|C[OÓ]DIGO)$/i],
  ["type", /^(TYPE|DESCRIPTION|DESC\.?|STYLE|OPERATION|D[EÉ]SIGNATION|TIPO|DESCRIPCI[OÓ]N|OUVRANT)$/i],
  ["width", /^(WIDTH|W|WIDTH\s*\(MM\)|W\s*\(MM\)|LARGEUR|L|LARG\.?|ANCHO|ANCHURA|A)(\s*\((MM|CM|M)\))?$/i],
  ["height", /^(HEIGHT|H|HEIGHT\s*\(MM\)|H\s*\(MM\)|HAUTEUR|HAUT\.?|ALTO|ALTURA)(\s*\((MM|CM|M)\))?$/i],
  ["size", /^(SIZE|SIZE\s*\(W\s*[xX]\s*H\)|OPENING\s+SIZE|W\s*[xX]\s*H|NOMINAL\s+SIZE|SIZE\s*\(MM\)|DIMENSIONS?|DIM\.?|L\s*[xX]\s*H|MEDIDAS|DIMENSIONES)(\s*\((MM|CM|M)\))?$/i],
  ["qty", /^(QTY\.?|QUANTITY|NO\.?\s*OFF|COUNT|NUMBER\s+OFF|NOMBRE|NBRE\.?|NB\.?|QT[EÉ]\.?|QUANTIT[EÉ]|CANTIDAD|UDS?\.?|UNIDADES)$/i],
  ["sill", /^(SILL|SILL\s+HEIGHT|SILL\s+HT\.?|ALL[EÈ]GE|ANTEPECHO)$/i],
  ["remarks", /^(REMARKS|NOTES|COMMENTS|HARDWARE|FINISH|FRAME|GLAZING|LOCATION|ROOM|OBSERVATIONS?|OBS\.?|MAT[EÉ]RIAU|VITRAGE|LOCAL|OBSERVACIONES|ACABADO)$/i],
];

const RE_SCHEDULE_TITLE =
  /(?<![\p{L}])((DOOR|WINDOW|OPENING|DOOR\s*(?:AND|&)\s*WINDOW)S?\s+SCHEDULES?|(TABLEAU|NOMENCLATURE|CARNET|LISTE)\s+DES\s+(MENUISERIES|PORTES|FEN[EÊ]TRES|OUVERTURES)|(CUADRO|MEMORIA|RESUMEN)\s+DE\s+(CARPINTER[IÍ]AS?|PUERTAS|VENTANAS))(?![\p{L}])/iu;

function headerKind(text: string): string | null {
  const t = normalizeChars(text).trim();
  for (const [k, rx] of HEADER_ALIASES) if (rx.test(t)) return k;
  return null;
}

export function extractSchedules(page: PageData, _views: View[], cls: PageClassification): ScheduleEntry[] {
  const tb = cls.titleBlock;
  const lines = page.lines.filter((ln) => !(tb && tb.contains(ln.bbox, 2)));
  const titles = lines.filter((ln) => RE_SCHEDULE_TITLE.test(ln.text) && ln.text.length < 60);
  const entries: ScheduleEntry[] = [];
  let n = 0;
  for (const title of titles) {
    let kind: ScheduleEntry["scheduleKind"] = "opening";
    const t = title.text.toUpperCase();
    const door = /DOOR|PORTES|PUERTAS/.test(t);
    const win = /WINDOW|FEN[EÊ]TRES|VENTANAS/.test(t);
    if (door && !win) kind = "door";
    else if (win && !door) kind = "window";
    const header = findHeader(lines, title);
    if (!header) continue;
    const cols = sortedBy(header, (h) => h[1].bbox.x0);
    const kinds = new Set(cols.map(([k]) => k));
    if (!kinds.has("tag") || !((kinds.has("width") && kinds.has("height")) || kinds.has("size"))) continue;
    const hy = mean(cols.map(([, h]) => h.bbox.cy));
    const rowH = median(cols.map(([, h]) => h.bbox.h));
    const xLeft = cols[0][1].bbox.x0 - 3 * rowH;
    // column boundaries: from each header's left edge to the next header's left edge
    const bounds: [string, number, number][] = cols.map(([k, h], i) => [k, h.bbox.x0 - 0.6 * rowH, i + 1 < cols.length ? cols[i + 1][1].bbox.x0 - 0.6 * rowH : h.bbox.x1 + 40 * rowH]);
    const xRight = bounds[bounds.length - 1][2];
    const body = sortedBy(
      lines.filter((ln) => ln.bbox.cy > hy + 0.6 * rowH && xLeft <= ln.bbox.cx && ln.bbox.cx <= xRight && ln !== title && ln.axis === "h"),
      (ln) => ln.bbox.cy,
    );
    const rows = groupRows(body, rowH);
    // stop at the first large vertical gap or at another schedule title / header
    const pitch = rowPitch(rows);
    let prevY = hy;
    for (const row of rows) {
      const ry = mean(row.map((ln) => ln.bbox.cy));
      if (ry - prevY > Math.max(3.5 * pitch, 6 * rowH)) break;
      if (row.some((ln) => RE_SCHEDULE_TITLE.test(ln.text)) || row.filter((ln) => headerKind(ln.text)).length >= 3) break;
      prevY = ry;
      const cells: Record<string, string> = {};
      for (const ln of row) {
        for (const [k, x0, x1] of bounds) {
          if (x0 <= ln.bbox.x0 + 0.5 && ln.bbox.x0 + 0.5 < x1) {
            cells[k] = ((cells[k] ?? "") + " " + ln.text.trim()).trim();
            break;
          }
        }
      }
      const parsed = parseTag(cells.tag ?? "");
      if (!parsed) continue;
      const [, key, tagText] = parsed;
      let width: ParsedMeasurement | null = null;
      let height: ParsedMeasurement | null = null;
      const unit = cls.defaultUnit;
      if ("size" in cells) {
        const pair = parseSize(cells.size, unit);
        if (pair) {
          width = pair[0].toDict();
          height = pair[1].toDict();
        }
      }
      if (width === null && "width" in cells) width = parseDimension(cells.width, unit)?.toDict() ?? null;
      if (height === null && "height" in cells) height = parseDimension(cells.height, unit)?.toDict() ?? null;
      if (width === null && height === null && "size" in cells) {
        const pair = parseLegendSize(cells.size, unit);
        if (pair) [width, height] = pair;
      }
      let qty: number | null = null;
      const qtxt = cells.qty ?? null;
      const qm = qtxt ? /^(\d{1,4})\s*(u|u\.|pcs?|unit[eé]s?|uds?\.?)?$/i.exec(qtxt.trim()) : null;
      if (qm) qty = parseInt(qm[1], 10);
      let rb: BBox = row[0].bbox;
      for (const ln of row.slice(1)) rb = rb.union(ln.bbox);
      // (as in the original: the source of the last cell line decides the base confidence)
      const lastLine = row[row.length - 1];
      let conf = lastLine.source === "pdf" ? 0.95 : 0.85 * mean(row.map((x) => x.confidence));
      if (width === null || height === null) conf *= 0.85;
      entries.push({
        id: `p${page.index}-s${n}`,
        pageIndex: page.index,
        scheduleKind: kind,
        scheduleTitle: title.text.trim(),
        tag: tagText,
        tagKey: key,
        typeText: cells.type ?? null,
        width,
        height,
        quantity: qty,
        quantityText: qtxt,
        remarks: cells.remarks ?? null,
        rowBBox: rb,
        cells,
        confidence: conf,
      });
      n++;
    }
  }
  // the same row reached from two titles is kept once
  const seen = new Set<string>();
  const uniq: ScheduleEntry[] = [];
  for (const e of entries) {
    const k = `${e.tagKey}|${Math.trunc(e.rowBBox.cy)}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(e);
    }
  }
  return uniq;
}

const RE_QTY_LINE = /^(NOMBRE|NBRE\.?|NB\.?|QT[EÉ]\.?|QUANTIT[EÉ]|QTY\.?|QUANTITY|NO\.?\s*OFF|CANTIDAD|UDS?\.?|UNIDADES)\s*[:=]?\s*(\d{1,4})\s*(u|u\.|pcs?|unit[eé]s?|uds?\.?)?$/i;

/**
 * A size written as "260 x 130 cm", "90/210", "L=90 H=210" or "L 0,90 x H 2,10".
 * Width first, as architects write it.
 */
export function parseLegendSize(text: string, unit: string): [ParsedMeasurement, ParsedMeasurement] | null {
  const t = normalizeChars(text).trim();
  const pair = parseSize(t.replace(/^(DIM(ENSIONS?)?\.?|SIZE|MEDIDAS)\s*[:=]?\s*/i, ""), unit);
  if (pair) return [pair[0].toDict(), pair[1].toDict()];
  const m =
    /^(?:L\s*[:=]?\s*)?(\d{1,5}(?:[.,]\d{1,3})?)\s*(mm|cm|m)?\s*[/xX]\s*(?:H\s*[:=]?\s*)?(\d{1,5}(?:[.,]\d{1,3})?)\s*(mm|cm|m)?$/i.exec(t) ??
    /^(?:L|LARG(?:EUR)?|W|ANCHO)\s*[:=]\s*(\d{1,5}(?:[.,]\d{1,3})?)\s*(mm|cm|m)?[\s,;-]+(?:H|HAUT(?:EUR)?|ALTO)\s*[:=]\s*(\d{1,5}(?:[.,]\d{1,3})?)\s*(mm|cm|m)?$/i.exec(t);
  if (!m) return null;
  const u = (m[2] ?? m[4] ?? "").toLowerCase();
  const withUnit = (v: string) => (u ? `${v} ${u}` : v);
  const w = parseDimension(withUnit(m[1]), unit);
  const h = parseDimension(withUnit(m[3]), unit);
  if (!w || !h) return null;
  // keep what was written on the drawing
  return [{ ...w.toDict(), original_text: m[1] + (m[2] ?? "") }, { ...h.toDict(), original_text: m[3] + (m[4] ?? "") }];
}

/**
 * Type legends: each opening type drawn once with its tag, its size and its
 * count underneath ("WT 16 / 260 x 130 cm / Nombre : 1") instead of a table.
 * Returns the entries and the tag lines they use (those are not plan tags).
 */
export function extractLegendEntries(page: PageData, cls: PageClassification): [ScheduleEntry[], TextLine[]] {
  const tb = cls.titleBlock;
  const lines = page.lines.filter((ln) => !(tb && tb.contains(ln.bbox, 2)) && ln.axis === "h");
  const entries: ScheduleEntry[] = [];
  const used: TextLine[] = [];
  let n = 0;
  for (const tagLine of lines) {
    const parsed = parseTag(tagLine.text);
    if (!parsed) continue;
    const size = Math.max(tagLine.size, tagLine.bbox.h, 1);
    // the lines stacked right under the tag, roughly centred or left-aligned on it
    const below = sortedBy(
      lines.filter(
        (ln) =>
          ln !== tagLine &&
          ln.bbox.cy > tagLine.bbox.cy &&
          ln.bbox.y0 - tagLine.bbox.y1 < 3.2 * size &&
          (Math.abs(ln.bbox.cx - tagLine.bbox.cx) < Math.max(2.5 * tagLine.bbox.w, 4 * size) || Math.abs(ln.bbox.x0 - tagLine.bbox.x0) < 2 * size),
      ),
      (ln) => ln.bbox.cy,
    ).slice(0, 3);
    let dims: [ParsedMeasurement, ParsedMeasurement] | null = null;
    let qty: number | null = null;
    let qtyText: string | null = null;
    const block: TextLine[] = [tagLine];
    for (const ln of below) {
      if (parseTag(ln.text)) break; // the next type's tag
      const q = RE_QTY_LINE.exec(normalizeChars(ln.text).trim());
      if (q && qty === null) {
        qty = parseInt(q[2], 10);
        qtyText = ln.text.trim();
        block.push(ln);
        continue;
      }
      const d: [ParsedMeasurement, ParsedMeasurement] | null = dims === null ? parseLegendSize(ln.text, cls.defaultUnit) : null;
      if (d) {
        dims = d;
        block.push(ln);
      }
    }
    // a tag with a count under it is a legend entry; a tag with only a size next to
    // it may be a size callout on the plan itself, so it needs to stand apart (large text)
    if (qty === null && (dims === null || tagLine.size < 1.6 * medianTagSize(lines))) continue;
    const [, key, tagText] = parsed;
    let rb: BBox = tagLine.bbox;
    for (const ln of block.slice(1)) rb = rb.union(ln.bbox);
    let conf = tagLine.source === "pdf" ? 0.93 : 0.8 * mean(block.map((x) => x.confidence));
    if (dims === null) conf *= 0.85;
    entries.push({
      id: `p${page.index}-l${n}`,
      pageIndex: page.index,
      scheduleKind: "opening",
      // the legend has no title on the drawing: name it in the drawing's language
      scheduleTitle: ({ fr: "Légende des types", es: "Leyenda de tipos" } as Record<string, string>)[cls.language ?? "en"] ?? "Type legend",
      tag: tagText,
      tagKey: key,
      typeText: null,
      width: dims ? dims[0] : null,
      height: dims ? dims[1] : null,
      quantity: qty,
      quantityText: qtyText,
      remarks: null,
      rowBBox: rb,
      cells: Object.fromEntries(block.map((ln, i) => [i === 0 ? "tag" : RE_QTY_LINE.test(ln.text.trim()) ? "qty" : "size", ln.text.trim()])),
      confidence: conf,
    });
    used.push(tagLine);
    n++;
  }
  return [entries, used];
}

function medianTagSize(lines: TextLine[]): number {
  const sizes = lines.filter((ln) => parseTag(ln.text)).map((ln) => ln.size);
  return sizes.length ? median(sizes) : 1;
}

/** Header cells in the band just below the schedule title. */
function findHeader(lines: TextLine[], title: TextLine): [string, TextLine][] | null {
  const size = Math.max(title.size, 1);
  const cands = lines.filter((ln) => title.bbox.y1 - 2 < ln.bbox.cy && ln.bbox.cy < title.bbox.y1 + 12 * size && headerKind(ln.text) && ln.bbox.x1 > title.bbox.x0 - 20 * size);
  if (!cands.length) return null;
  // the header row is the first y-band below the title holding >= 3 header cells
  for (const c of sortedBy(cands, (ln) => ln.bbox.cy)) {
    const row = cands.filter((x) => Math.abs(x.bbox.cy - c.bbox.cy) < 0.6 * Math.max(c.bbox.h, 1));
    if (row.length >= 3) return row.map((ln) => [headerKind(ln.text)!, ln]);
  }
  return null;
}

function groupRows(body: TextLine[], rowH: number): TextLine[][] {
  const rows: TextLine[][] = [];
  for (const ln of body) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(ln.bbox.cy - mean(last.map((x) => x.bbox.cy))) < 0.55 * rowH) last.push(ln);
    else rows.push([ln]);
  }
  return rows;
}

function rowPitch(rows: TextLine[][]): number {
  const ys = rows.map((r) => mean(r.map((ln) => ln.bbox.cy)));
  if (ys.length < 2) return 20;
  const diffs: number[] = [];
  for (let i = 0; i + 1 < ys.length; i++) diffs.push(ys[i + 1] - ys[i]);
  return median(diffs);
}

/** Refine the opening kind from the schedule's TYPE column. */
export function scheduleTypeKind(typeText: string | null, scheduleKind: string, tagPrefix: string): string | null {
  const t = (typeText ?? "").toUpperCase();
  const doorLike = scheduleKind === "door" || ["D", "SD", "GD", "DD", "FD", "ED", "RD"].includes(tagPrefix);
  if (/\bGARAGE|\bROLLER|\bSECTIONAL|\bOVERHEAD|\bTILT/.test(t)) return "garage_door";
  if (/\bCURTAIN\s*WALL/.test(t)) return "curtain_wall";
  if (/\bSLID(ING|ER)|\bSTACKER|\bPOCKET/.test(t)) return doorLike ? "sliding_door" : "sliding_window";
  if (/\bDOUBLE|\bFRENCH|\bPAIR|\bBI-?PARTING/.test(t) && doorLike) return "double_door";
  return null;
}
