/**
 * Tag-to-opening and dimension-to-opening association.
 *
 * For every candidate (dimension, opening) pair the engine evaluates
 * independent signals and records each as evidence: proximity, dimension span
 * = opening edges, extension lines at the opening edges, orientation, tag
 * nearby, drawing type, conventions (plausible size, chains) and - only for
 * ambiguous cases - a vision model. A dimension is only associated when its
 * geometry ties it to the opening; the closest number is never assumed.
 */
import type { DetectionContext } from "./context";
import type { VisionProvider } from "./platform";
import { tagClass } from "./tags";
import { BBox, evidence, tagToDict, type Association, type DimensionAnnotation, type Evidence, type OpeningDetection, type Pt, type TagDetection, type View } from "./types";
import { formatLength } from "./units";
import { maxBy, minBy, pyFixed, pyRound, sortedBy } from "./py";

const WEIGHTS = { edges: 0.42, extension: 0.18, proximity: 0.12, tag: 0.08, scale: 0.12, plausible: 0.08 };
const ACCEPT = 0.5;
const AMBIGUITY_MARGIN = 0.08;

const WINDOWISH = new Set(["window", "sliding_window", "curtain_wall"]);
const DOORISH = new Set(["door", "double_door", "sliding_door", "garage_door"]);

function kindCompat(tagPrefix: string, kind: string): number {
  const cls = tagClass(tagPrefix);
  if (WINDOWISH.has(cls)) return WINDOWISH.has(kind) ? 1 : kind === "opening" ? 0.7 : 0.45;
  if (DOORISH.has(cls)) return DOORISH.has(kind) ? 1 : kind === "opening" ? 0.7 : 0.45;
  if (cls === "opening") return kind === "opening" ? 1 : 0.6;
  return 0.6;
}

function dupTag(o: OpeningDetection, t: TagDetection): void {
  const arr = (o.features.duplicate_tags as unknown[] | undefined) ?? [];
  arr.push(tagToDict(t));
  o.features.duplicate_tags = arr;
  o.evidence.push(evidence("duplicate_tag", `Tag ${t.text} appears twice at this opening`, null, { detail: "Possible duplicate annotation - counted once, please confirm", pageIndex: t.pageIndex, bbox: t.bbox, target: t.id }));
}

/** Attach each tag to the opening it labels. Returns tags left unassigned. */
export function assignTags(openings: OpeningDetection[], tags: TagDetection[], ctx: DetectionContext): TagDetection[] {
  const reach = ctx.units(2000);
  const scaleD = ctx.units(900);
  type P = [number, TagDetection, OpeningDetection, number, boolean, boolean];
  let pairs: P[] = [];
  for (const t of tags) {
    for (const o of openings) {
      const d = o.bbox.distanceTo(t.bbox);
      if (d > reach) continue;
      const al = o.axis === "h" ? t.bbox.cx : t.bbox.cy;
      const [lo, hi] = o.edges;
      const w = Math.max(hi - lo, 1e-6);
      const aligned = lo - 0.15 * w <= al && al <= hi + 0.15 * w;
      const off = Math.abs(al - (lo + hi) / 2);
      const centred = off <= 0.25 * w + ctx.units(150);
      // tags sit on the line through the opening centre, perpendicular to the wall
      const centring = Math.max(0.3, 1 - off / (0.6 * w + ctx.units(100)));
      let s = Math.exp(-d / scaleD) * centring * kindCompat(t.prefix, o.kind);
      let onLeader = false;
      if (t.leaderTo) {
        // the tag's leader line points at this opening
        const dl = o.bbox.distanceTo(new BBox(t.leaderTo[0], t.leaderTo[1], 0, 0));
        const sl = Math.exp(-dl / ctx.units(300)) * Math.max(0.6, kindCompat(t.prefix, o.kind));
        if (sl > s) {
          s = sl;
          onLeader = dl < ctx.units(300);
        }
      }
      pairs.push([s, t, o, d, aligned || onLeader, centred || onLeader]);
    }
  }
  pairs = sortedBy(pairs, (p) => -p[0]);
  const usedT = new Set<string>();
  for (const [s, t, o, d, aligned, centred] of pairs) {
    if (s < 0.2 || usedT.has(t.id)) continue;
    if (o.tag === null) {
      o.tag = t;
      o.tagScore = Math.min(0.99, t.confidence * (0.55 + 0.45 * Math.min(1, s / 0.8)));
      o.tagEvidence = [
        evidence("tag_detected", `Tag ${t.text} detected` + (t.enclosure ? " (enclosed tag symbol)" : ""), true, { score: t.confidence, pageIndex: t.pageIndex, bbox: t.bbox, target: t.id }),
        evidence("tag_position", centred ? "Tag placed on the opening's centre line" : aligned ? "Tag within the opening's extent" : "Tag offset from the opening", centred || aligned, {
          detail: `${pyFixed(ctx.real(d), 0)} mm from the opening`,
          score: s,
          pageIndex: t.pageIndex,
          bbox: t.bbox,
        }),
      ];
      if (kindCompat(t.prefix, o.kind) < 0.8) {
        o.tagEvidence.push(evidence("tag_kind", `Tag prefix '${t.prefix}' does not match the drawn symbol (${o.kind.replace(/_/g, " ")})`, false, { pageIndex: t.pageIndex, bbox: t.bbox }));
      }
      usedT.add(t.id);
    } else if (o.tag.key === t.key && (aligned || d < ctx.units(1200))) {
      // the same tag written twice next to one opening
      dupTag(o, t);
      usedT.add(t.id);
    }
  }
  // a second copy of a tag near an opening that already carries it is a duplicate annotation
  for (const t of tags) {
    if (usedT.has(t.id)) continue;
    const near = openings.filter((o) => o.tag !== null && o.tag.key === t.key && o.bbox.distanceTo(t.bbox) < reach);
    if (near.length) {
      const o = minBy(near, (o) => o.bbox.distanceTo(t.bbox));
      dupTag(o, t);
      usedT.add(t.id);
    }
  }
  return tags.filter((t) => !usedT.has(t.id));
}

interface Candidate {
  opening: OpeningDetection;
  dim: DimensionAnnotation;
  role: "width" | "height";
  score: number;
  signals: Evidence[];
  levelLike: boolean;
}

function roleExtents(o: OpeningDetection, role: "width" | "height"): [[number, number], [number, number]] {
  return role === "width" ? [o.edges, o.cross] : [o.cross, o.edges];
}

function evaluate(o: OpeningDetection, d: DimensionAnnotation, role: "width" | "height", view: View, ctx: DetectionContext): Candidate | null {
  const [[e0, e1], [c0, c1]] = roleExtents(o, role);
  const size = e1 - e0;
  const tol = Math.max(0.8, ctx.units(20), 0.015 * size, ctx.minTol);
  const [s0, s1] = d.span!;
  const d0 = Math.abs(s0 - e0);
  const d1 = Math.abs(s1 - e1);
  let edge: number;
  if (d0 <= tol && d1 <= tol) edge = 1;
  else if (d0 <= 3 * tol && d1 <= 3 * tol) edge = 0.75;
  else if (Math.min(d0, d1) <= tol) edge = 0.3;
  else return null;
  const pi = d.pageIndex;
  const lineBox = d.line ? d.line.bbox : d.textBBox;
  const sig: Evidence[] = [];
  sig.push(evidence("orientation", `${d.axis === "h" ? "Horizontal" : "Vertical"} dimension corresponds to opening ${role}`, true, { pageIndex: pi, bbox: d.textBBox }));
  if (edge === 1) sig.push(evidence("dim_line_edges", `Dimension line terminates at the opening's ${role === "width" ? "jambs" : "head and sill"}`, true, { score: edge, pageIndex: pi, bbox: lineBox }));
  else if (edge === 0.75) sig.push(evidence("dim_line_edges", "Dimension line ends close to the opening edges", true, { score: edge, pageIndex: pi, bbox: lineBox }));
  else sig.push(evidence("dim_line_edges", "Only one end of the dimension line meets an opening edge", false, { score: edge, pageIndex: pi, bbox: lineBox }));

  // extension lines
  let levelLike = false;
  let extScore: number | null = null;
  if (d.extensionLines.length) {
    let hits = 0;
    const g = ctx.units(450);
    for (const s of d.extensionLines) {
      const far = maxBy(
        [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ] as Pt[],
        (p) => Math.abs((d.axis === "h" ? p[1] : p[0]) - (d.linePos ?? 0)),
      );
      const al = d.axis === "h" ? far[0] : far[1];
      const ac = d.axis === "h" ? far[1] : far[0];
      if ((Math.abs(al - e0) <= tol || Math.abs(al - e1) <= tol) && c0 - g <= ac && ac <= c1 + g) hits++;
    }
    extScore = Math.min(1, hits / 2);
    if (hits) sig.push(evidence("extension_lines", `Extension line${hits > 1 ? "s" : ""} originate${hits > 1 ? "" : "s"} at the opening edges`, true, { score: extScore, pageIndex: pi, bbox: d.extensionLines[0].bbox }));
    else if (view.viewType === "elevation" && role === "height" && edge === 1) {
      levelLike = true;
      extScore = null;
      sig.push(
        evidence("level_alignment", "Level dimension: span aligns exactly with the opening's sill and head levels", true, {
          detail: "Extension lines start at the facade edge, so the dimension may apply to several openings at these levels",
          pageIndex: pi,
          bbox: lineBox,
        }),
      );
    } else sig.push(evidence("extension_lines", "Extension lines start away from this opening", false, { score: 0, pageIndex: pi, bbox: d.extensionLines[0].bbox }));
  } else sig.push(evidence("extension_lines", "No extension lines found for this dimension", null, { pageIndex: pi, bbox: d.textBBox }));

  // proximity of the dimension line to the opening
  const lp = d.linePos !== null ? d.linePos : d.axis === "h" ? d.textBBox.cy : d.textBBox.cx;
  const dist = c0 <= lp && lp <= c1 ? 0 : Math.min(Math.abs(lp - c0), Math.abs(lp - c1));
  const prox = Math.exp(-dist / ctx.units(2500));
  sig.push(evidence("proximity", prox > 0.4 ? "Dimension text is close to the opening" : "Dimension is some distance from the opening", prox > 0.4, { detail: `${pyFixed(ctx.real(dist), 0)} mm away`, score: prox, pageIndex: pi, bbox: d.textBBox }));

  // tag
  let tagS = 0;
  if (o.tag !== null) {
    const td = o.tag.bbox.distanceTo(d.textBBox);
    if (td < ctx.units(1600)) {
      tagS = 1;
      sig.push(evidence("tag_nearby", `Opening tag ${o.tag.text} is nearby`, true, { pageIndex: pi, bbox: o.tag.bbox, target: o.tag.id }));
    }
  }
  // scale consistency
  let sc: number;
  if (d.scaleCheck === null) sc = 0.5;
  else if (d.scaleCheck.consistent) {
    sc = 1;
    sig.push(evidence("scale_consistent", `Drawn length matches the value at ${view.scale.text || "the drawing scale"}`, true, { pageIndex: pi, bbox: lineBox }));
  } else {
    sc = 0;
    sig.push(evidence("scale_consistent", "Drawn length does not match the written value at the drawing scale", false, { detail: d.notes.length ? d.notes[d.notes.length - 1] : null, pageIndex: pi, bbox: d.textBBox }));
  }
  // plausibility and chains
  const [loOk, hiOk] = role === "width" ? [200, 9000] : [200, 5000];
  const plaus = loOk <= d.valueMm && d.valueMm <= hiOk ? 1 : 0.2;
  if (plaus < 1) sig.push(evidence("plausible", `Value ${formatLength(d.valueMm, "mm")} is outside the usual range for an opening ${role}`, false, { pageIndex: pi, bbox: d.textBBox }));
  if (d.chainSize > 1) sig.push(evidence("chain", `Segment of a ${d.chainSize}-part dimension chain whose ends coincide with this opening`, true, { pageIndex: pi, bbox: d.textBBox }));

  const extVal = extScore === null ? 0.5 : extScore;
  const score = WEIGHTS.edges * edge + WEIGHTS.extension * extVal + WEIGHTS.proximity * prox + WEIGHTS.tag * tagS + WEIGHTS.scale * sc + WEIGHTS.plausible * plaus;
  if (edge < 0.75 && (extScore ?? 0) < 1) return null; // geometry does not tie this dimension to the opening
  return { opening: o, dim: d, role, score: (score * d.confidence) / 0.96, signals: sig, levelLike };
}

/** Associate dimensions with openings in one view. Returns vision-call log entries. */
export async function associateDimensions(
  openings: OpeningDetection[],
  dims: DimensionAnnotation[],
  view: View,
  ctx: DetectionContext,
  vision: VisionProvider | null = null,
  crop: ((b: BBox) => Promise<Uint8Array>) | null = null,
): Promise<Record<string, unknown>[]> {
  const log: Record<string, unknown>[] = [];
  const linear = dims.filter((d) => d.kind === "linear" && d.viewId === view.id && d.span !== null);
  let cands: Candidate[] = [];
  for (const o of openings) {
    for (const d of linear) {
      const roles: ("width" | "height")[] = [];
      if (d.axis === o.axis) roles.push("width");
      if (view.viewType === "elevation" && d.axis !== o.axis) roles.push("height");
      for (const role of roles) {
        const c = evaluate(o, d, role, view, ctx);
        if (c !== null) cands.push(c);
      }
    }
  }
  const byOpen = new Map<string, Candidate[]>();
  for (const c of cands) {
    const k = `${c.opening.id}|${c.role}`;
    if (!byOpen.has(k)) byOpen.set(k, []);
    byOpen.get(k)!.push(c);
  }
  for (const [k, lst] of byOpen) {
    const sorted = sortedBy(lst, (c) => -c.score);
    byOpen.set(k, sorted);
    sorted[0].opening.candidateAssocs.push(...sorted.slice(0, 3).map((x) => ({ dimensionId: x.dim.id, role: x.role, score: x.score, signals: x.signals, sharedWith: [] })));
  }

  // global greedy assignment (one opening per dimension, except shared level dimensions)
  cands = sortedBy(cands, (c) => -c.score);
  const dimUsed = new Map<string, string>();
  for (const c of cands) {
    const o = c.opening;
    const slot = c.role === "width" ? "widthAssoc" : "heightAssoc";
    if (o[slot] !== null || c.score < ACCEPT) continue;
    const key = `${c.dim.id}|${c.role}`;
    if (dimUsed.has(key) && !c.levelLike) continue;
    const rivals = byOpen.get(`${o.id}|${c.role}`)!.filter((x) => x !== c && Math.abs(x.dim.valueMm - c.dim.valueMm) > 1 && !dimUsed.has(`${x.dim.id}|${x.role}`));
    let signals = [...c.signals];
    let chosen = c;
    if (rivals.length && rivals[0].score > c.score - AMBIGUITY_MARGIN) {
      let verdict: string | null = null;
      if (vision !== null && crop !== null && vision.available()) verdict = await askVision(vision, crop, o, [c, ...rivals.slice(0, 2)], view, log);
      if (verdict !== null && verdict !== c.dim.id) {
        const alt = rivals.find((x) => x.dim.id === verdict);
        if (alt) {
          chosen = alt;
          signals = [...alt.signals];
        }
      }
      signals.push(
        evidence("ambiguous", "Another dimension fits almost as well", false, {
          detail: `Alternative: ${rivals[0].dim.text}` + (verdict ? " (vision model consulted)" : ""),
          pageIndex: rivals[0].dim.pageIndex,
          bbox: rivals[0].dim.textBBox,
          target: rivals[0].dim.id,
        }),
      );
      if (verdict !== null) signals.push(evidence("vision", `Vision model selected ${chosen.dim.text}`, true, { pageIndex: chosen.dim.pageIndex, bbox: chosen.dim.textBBox }));
      chosen = { ...chosen, score: Math.min(chosen.score, 0.6), signals };
    }
    const shared = cands.filter((x) => x.dim.id === chosen.dim.id && x.role === chosen.role && x.opening !== o && x.levelLike).map((x) => x.opening.id);
    const assoc: Association = { dimensionId: chosen.dim.id, role: chosen.role, score: chosen.score, signals, sharedWith: chosen.levelLike ? shared : [] };
    o[slot] = assoc;
    dimUsed.set(`${chosen.dim.id}|${chosen.role}`, o.id);
  }

  // size callouts next to tags ("1200 x 1500")
  const callouts = dims.filter((d) => d.kind === "callout" && d.viewId === view.id);
  for (const o of openings) {
    if (o.tag === null) continue;
    const tag = o.tag;
    const near = callouts.filter((d) => d.textBBox.distanceTo(tag.bbox) < Math.max(ctx.units(1200), 3 * tag.bbox.h));
    for (const d of near) {
      const role = d.pairRole ?? "width";
      const slot = role === "width" ? "widthAssoc" : "heightAssoc";
      if (o[slot] !== null) continue;
      const s = d.pairRole ? 0.85 : 0.6;
      const sig = [
        evidence("callout", d.pairRole ? `Size callout "${d.text}" written beside tag ${tag.text}` : `Number "${d.text}" written on the tag line`, true, {
          detail: d.pairRole ? "Callout order is width x height" : "No dimension line - treated as width, please confirm",
          pageIndex: d.pageIndex,
          bbox: d.textBBox,
          target: d.id,
        }),
        evidence("tag_nearby", `Opening tag ${tag.text} is adjacent`, true, { pageIndex: tag.pageIndex, bbox: tag.bbox, target: tag.id }),
      ];
      o[slot] = { dimensionId: d.id, role, score: s * d.confidence, signals: sig, sharedWith: [] };
    }
  }

  // scale-derived sizes (used only when no explicit dimension is found later)
  for (const o of openings) {
    if (ctx.scaleKnown) {
      o.features.inferred_width_mm = pyRound(ctx.real(o.edges[1] - o.edges[0]), 1);
      if (view.viewType === "elevation") o.features.inferred_height_mm = pyRound(ctx.real(o.cross[1] - o.cross[0]), 1);
      o.features.scale_text = view.scale.text;
    }
  }
  return log;
}

async function askVision(vision: VisionProvider, crop: (b: BBox) => Promise<Uint8Array>, o: OpeningDetection, cands: Candidate[], view: View, log: Record<string, unknown>[]): Promise<string | null> {
  let b = o.bbox;
  for (const c of cands) b = b.union(c.dim.textBBox);
  let ans: { choice: string; confidence: number } | null;
  try {
    const img = await crop(b.expand(20));
    const question = {
      opening: { id: o.id, kind: o.kind, tag: o.tag ? o.tag.text : null, bbox: o.bbox.toDict() },
      role: cands[0].role,
      view_type: view.viewType,
      crop_origin: { x: b.expand(20).x, y: b.expand(20).y },
      candidates: cands.map((c) => ({ id: c.dim.id, text: c.dim.text, bbox: c.dim.textBBox.toDict() })),
    };
    ans = await vision.adjudicateAssociation(img, question);
  } catch (exc) {
    // the vision model is optional; never fail extraction because of it
    log.push({ opening: o.id, error: String(exc) });
    return null;
  }
  log.push({ opening: o.id, question: cands.map((c) => c.dim.id), answer: ans });
  if (!ans) return null;
  const valid = new Set(cands.map((c) => c.dim.id));
  if (valid.has(ans.choice) && Number(ans.confidence ?? 0) >= 0.6) return ans.choice;
  return null;
}
