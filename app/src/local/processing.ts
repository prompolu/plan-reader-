/**
 * Processing jobs: render pages, run the extraction engine (in the engine
 * worker), persist results and merge them with the user's work. One job runs
 * at a time; progress is kept on the job so the Upload screen can show it.
 */
import { EXTRACTION_VERSION, STEPS } from "../engine/meta";
import { OPENING_TYPE_LABELS } from "../engine/types";
import { byProject, db, nowIso, uuid, type AuditRow, type DocumentRow, type JobRow, type PageRow, type RunRow } from "./db";
import { assetBase, engine, type WorkerDoc } from "./engineClient";
import { revokeImage } from "./images";
import * as svc from "./openings";

const RANGES: Record<string, [number, number]> = {
  rendered: [0.02, 0.25],
  analyzed: [0.25, 0.85],
  classified: [0.85, 0.86],
  dimensions: [0.86, 0.87],
  openings: [0.87, 0.88],
  associated: [0.88, 0.89],
  schedules: [0.89, 0.92],
  crossref: [0.92, 0.95],
  scored: [0.95, 0.98],
};
const ORDER = STEPS.map(([s]) => s);

export function jobOut(j: JobRow) {
  return {
    id: j.id,
    status: j.status,
    progress: Math.round((j.progress ?? 0) * 1000) / 1000,
    step: j.step,
    steps: j.steps,
    message: j.message,
    error: j.error,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    run_id: j.run_id,
  };
}

function initialSteps(): JobRow["steps"] {
  const out: JobRow["steps"] = {};
  for (const [sid, label] of STEPS) out[sid] = { label, status: "pending", detail: null };
  out.uploaded.status = "done";
  return out;
}

/** Queue processing for a project (or reuse a queued, not yet started job). */
export async function enqueueJob(projectId: string, trigger: string): Promise<JobRow> {
  const d = await db();
  const queued = (await byProject("jobs", projectId)).find((j) => j.status === "queued");
  if (queued) return queued;
  const job: JobRow = {
    id: uuid(),
    project_id: projectId,
    run_id: null,
    status: "queued",
    progress: 0,
    step: "uploaded",
    steps: initialSteps(),
    message: "Queued",
    error: null,
    trigger,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
  };
  await d.put("jobs", job);
  void runQueue();
  return job;
}

let running = false;

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const jobs = (await (await db()).getAll("jobs")).filter((j) => j.status === "queued").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      if (!jobs.length) break;
      await runJob(jobs[0]);
    }
  } finally {
    running = false;
  }
}

/** Jobs that were running when the app was closed cannot resume: mark them failed. */
export async function recoverJobs(): Promise<void> {
  const d = await db();
  for (const j of await d.getAll("jobs")) {
    if (j.status === "running") {
      j.status = "failed";
      j.error = "Processing was interrupted (the app was closed). Press “Re-extract all” to run it again.";
      j.message = "Processing interrupted";
      j.finished_at = nowIso();
      await d.put("jobs", j);
    }
  }
  void runQueue();
}

async function runJob(job: JobRow): Promise<void> {
  const d = await db();
  job.status = "running";
  job.started_at = nowIso();
  job.message = "Starting";
  await d.put("jobs", job);

  let lastWrite = 0;
  let current: string | null = null;
  const progress = (step: string, frac: number, message: string) => {
    const t = Date.now();
    const changed = step !== current;
    if (!changed && t - lastWrite < 300 && frac < 1) return;
    lastWrite = t;
    current = step;
    const [lo, hi] = RANGES[step] ?? [0, 1];
    const overall = lo + (hi - lo) * Math.max(0, Math.min(1, frac));
    const idx = ORDER.indexOf(step);
    ORDER.forEach((sid, i) => {
      const e = job.steps[sid];
      if (!e) return;
      if (i < idx) e.status = "done";
      else if (i === idx) {
        e.status = frac >= 1 ? "done" : "running";
        e.detail = message;
      }
    });
    job.step = step;
    job.progress = Math.max(job.progress ?? 0, overall);
    job.message = message;
    void d.put("jobs", { ...job, steps: JSON.parse(JSON.stringify(job.steps)) });
  };

  let run: RunRow | null = null;
  try {
    run = await processProject(job, progress);
    job.status = "succeeded";
    job.progress = 1;
    job.finished_at = nowIso();
    for (const sid of Object.keys(job.steps)) job.steps[sid].status = "done";
    job.message = "Complete";
    job.run_id = run.id;
  } catch (e) {
    console.error(e);
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
    job.message = "Processing failed";
    job.finished_at = nowIso();
    if (job.run_id) {
      const r = await d.get("runs", job.run_id);
      if (r) {
        r.status = "failed";
        r.finished_at = nowIso();
        r.warnings = [...r.warnings, job.error];
        await d.put("runs", r);
      }
    }
  }
  await d.put("jobs", { ...job });
}

async function processProject(job: JobRow, progress: (step: string, frac: number, msg: string) => void): Promise<RunRow> {
  const d = await db();
  const project = await d.get("projects", job.project_id);
  if (!project) throw new Error("project no longer exists");
  const docs = (await byProject("documents", project.id)).filter((x) => x.status !== "failed").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  if (!docs.length) throw new Error("no documents to process");
  let pages = await byProject("pages", project.id);

  // documents whose pages have no images yet are rendered in this run
  const hasImages = new Set(pages.filter((p) => p.has_image).map((p) => p.document_id));
  const inputs: WorkerDoc[] = [];
  for (let i = 0; i < docs.length; i++) {
    const blob = await d.get("files", docs[i].id);
    if (!blob) throw new Error(`${docs[i].original_filename}: file missing`);
    inputs.push({ id: docs[i].id, index: i, filename: docs[i].original_filename, data: new Uint8Array(await blob.arrayBuffer()), render: !hasImages.has(docs[i].id) });
  }

  // page overrides are keyed by the global page index
  const run: RunRow = { id: uuid(), project_id: project.id, version: EXTRACTION_VERSION, models: {}, status: "running", trigger: job.trigger, stats: {}, warnings: [], started_at: nowIso(), finished_at: null };
  await d.put("runs", run);
  job.run_id = run.id;
  await d.put("jobs", { ...job });

  const result = await engine().process(
    inputs,
    {
      thresholds: project.settings.thresholds,
      manualScales: pages.filter((p) => p.scale_override?.ratio).map((p) => [p.page_index, p.scale_override!] as [number, { text?: string | null; ratio: number }]),
      pageTypeOverrides: pages.filter((p) => p.page_type_override).map((p) => [p.page_index, p.page_type_override!] as [number, string]),
      assetBase: assetBase(),
    },
    progress,
  );

  // 1. page rows and images (global page index follows document order)
  const offsets = new Map<string, number>();
  let offset = 0;
  const docById = new Map<string, DocumentRow>();
  for (const doc of docs) {
    docById.set(doc.id, doc);
    offsets.set(doc.id, offset);
    offset += doc.page_count;
  }
  const byDocPage = new Map(pages.map((p) => [`${p.document_id}:${p.page_in_document}`, p]));
  for (const rp of result.rendered) {
    let p = byDocPage.get(`${rp.docId}:${rp.pageInDocument}`);
    if (!p) {
      p = newPage(project.id, rp.docId, rp.pageInDocument);
      byDocPage.set(`${rp.docId}:${rp.pageInDocument}`, p);
    }
    p.width = rp.width;
    p.height = rp.height;
    p.unit = rp.unit;
    p.image_width = rp.imageWidth;
    p.image_height = rp.imageHeight;
    p.has_image = true;
    await d.put("images", rp.image, `${p.id}:image`);
    await d.put("images", rp.thumb, `${p.id}:thumb`);
    revokeImage(`${p.id}:image`);
    revokeImage(`${p.id}:thumb`);
    const doc = docById.get(rp.docId)!;
    if (doc.status === "uploaded") doc.status = "rendered";
  }
  for (const p of byDocPage.values()) {
    const off = offsets.get(p.document_id);
    if (off !== undefined) p.page_index = off + p.page_in_document;
  }

  // 2. page analysis
  const byIndex = new Map([...byDocPage.values()].map((p) => [p.page_index, p]));
  for (const ap of result.pages) {
    const p = byIndex.get(ap.index);
    if (!p) continue;
    p.page_type = ap.pageType;
    p.classification = ap.classification;
    p.sheet_number = ap.sheetNumber;
    p.sheet_title = ap.sheetTitle;
    p.floor = ap.floor;
    p.quality = ap.quality;
    p.mm_per_unit = ap.mmPerUnit;
    p.rotation = ap.rotation;
    p.scale = ap.scale;
    p.analysed = true;
    p.run_id = run.id;
    await d.put("overlays", ap.overlay, p.id);
  }
  for (const p of byDocPage.values()) await d.put("pages", p);
  pages = [...byDocPage.values()];

  // 3. merge opening records (never silently overwriting user edits)
  const events: Omit<AuditRow, "id" | "project_id" | "created_at">[] = [];
  const existing = await byProject("openings", project.id);
  const [touched, stats] = svc.mergeRun(project, existing, run.id, result.records, byIndex, (e) => events.push(e));
  const tx = d.transaction(["openings", "audit"], "readwrite");
  for (const o of touched) await tx.objectStore("openings").put(o);
  const t = nowIso();
  for (const e of events) await tx.objectStore("audit").add({ ...e, project_id: project.id, created_at: t });
  await tx.done;

  for (const doc of docs) {
    doc.status = "processed";
    await d.put("documents", doc);
  }
  run.status = "succeeded";
  run.finished_at = nowIso();
  run.models = result.models;
  run.warnings = result.warnings;
  run.stats = {
    pages: result.pages.length,
    records: result.records.length,
    physical_openings: result.records.reduce((a, r) => a + (r.quantity ?? 0), 0),
    needs_review: result.records.filter((r) => r.status === "needs_review").length,
    merge: stats,
    stages: result.stages,
    vision_calls: (result.models.vision_calls as number) ?? 0,
  };
  await d.put("runs", run);
  project.current_run_id = run.id;
  project.last_processed_at = run.finished_at;
  project.updated_at = nowIso();
  await d.put("projects", project);
  const types = result.records.length;
  await d.add("audit", {
    project_id: project.id,
    opening_id: null,
    opening_ref: null,
    actor: "system",
    user: null,
    action: "extraction_run",
    field: null,
    old_value: null,
    new_value: null,
    message: `Extraction v${EXTRACTION_VERSION} completed: ${types} opening types, ${stats.created} new, ${stats.updated} updated, ${stats.pending_confirmation} awaiting confirmation`,
    created_at: nowIso(),
  });
  void OPENING_TYPE_LABELS;
  return run;
}

function newPage(projectId: string, docId: string, pageInDocument: number): PageRow {
  return {
    id: uuid(),
    project_id: projectId,
    document_id: docId,
    page_index: 0,
    page_in_document: pageInDocument,
    width: 0,
    height: 0,
    unit: "pt",
    mm_per_unit: null,
    rotation: 0,
    image_width: null,
    image_height: null,
    has_image: false,
    page_type: null,
    page_type_override: null,
    classification: {},
    sheet_number: null,
    sheet_title: null,
    floor: null,
    scale: {},
    scale_override: null,
    quality: {},
    analysed: false,
    run_id: null,
    created_at: nowIso(),
  };
}
