/**
 * The app's API, served inside the app itself (no server). Same routes and
 * JSON shapes the screens were built against, backed by IndexedDB and the
 * on-device extraction engine.
 */
import { OPENING_TYPE_LABELS, PAGE_TYPES, PAGE_TYPE_LABELS } from "../engine/types";
import { Thresholds } from "../engine/confidence";
import { formatRatio, parseScale } from "../engine/scale";
import { EXTRACTION_VERSION } from "../engine/meta";
import { db, byProject, nowIso, uuid, sha256Hex, type AuditRow, type DocumentRow, type JobRow, type OpeningRow, type PageRow, type ProjectRow } from "./db";
import * as svc from "./openings";
import { buildSchedule, GROUP_BY } from "./schedule";
import { enqueueJob, jobOut } from "./processing";
import { imageUrl, revokeImage } from "./images";
import { validateUpload, UploadError } from "./uploads";
import { buildReport } from "./report";
import { locAuditMessage, locLabels, locOpening, locReviewItem, locSchedule } from "./localize";
import { tx } from "../i18n";
import { engine } from "./engineClient";
import { getProfile, setProfile } from "./profile";
import { APP_VERSION, deleteProjectData, openProjectFile, ProjectFileError, saveProjectFile, type OpenMode } from "./projectData";

export { APP_VERSION, deleteProjectData };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const DEFAULT_SETTINGS: ProjectRow["settings"] = { thresholds: { high: 0.85, medium: 0.6 }, display_unit: "mm", default_unit: "mm" };
const INFO_KEYS = ["project_name", "drawing_set_name", "project_address", "prepared_by", "date", "notes"];
const UNITS = ["original", "mm", "cm", "m", "ft_in"];

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => Promise<unknown>;

const routes: [string, RegExp, Handler][] = [];
function route(method: string, pattern: string, h: Handler) {
  routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);
}

export async function localApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, "http://local");
  for (const [m, rx, h] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(rx);
    if (!match) continue;
    // everything under a project requires that project to exist
    if (match.groups?.pid && url.pathname !== `/api/projects/${match.groups.pid}`) await getProject(match.groups.pid);
    return h(match, url.searchParams, body);
  }
  throw new ApiError(404, `Not found: ${method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function user(): Promise<string> {
  return (await getProfile()).name || "You";
}

async function getProject(id: string): Promise<ProjectRow> {
  const p = await (await db()).get("projects", id);
  if (!p) throw new ApiError(404, "Project not found");
  return p;
}

async function writeAudit(projectId: string, events: Omit<AuditRow, "id" | "project_id" | "created_at">[]): Promise<void> {
  if (!events.length) return;
  const d = await db();
  const tx = d.transaction("audit", "readwrite");
  const t = nowIso();
  for (const e of events) await tx.store.add({ ...e, project_id: projectId, created_at: t });
  await tx.done;
}

async function audit(projectId: string, actor: AuditRow["actor"], action: string, message: string, extra: { user?: string | null; field?: string | null; old?: unknown; new?: unknown } = {}) {
  await writeAudit(projectId, [svc.auditFor(null, actor, action, message, extra)]);
}

async function touch(p: ProjectRow): Promise<void> {
  p.updated_at = nowIso();
  await (await db()).put("projects", p);
}

async function projectStats(p: ProjectRow) {
  const pages = await byProject("pages", p.id);
  const ops = (await byProject("openings", p.id)).filter((o) => o.deleted_at === null);
  const jobs = (await byProject("jobs", p.id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const docs = await byProject("documents", p.id);
  return {
    pages: pages.length,
    opening_types: ops.length,
    openings: ops.reduce((a, o) => a + (o.quantity ?? 0), 0),
    needs_review: ops.filter((o) => o.status === "needs_review").length,
    verified: ops.filter((o) => o.verified).length,
    documents: docs.length,
    job: jobs.length ? jobOut(jobs[0]) : null,
  };
}

async function projectOut(p: ProjectRow, stats = true) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    info: p.info ?? {},
    settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
    is_demo: p.is_demo,
    role: "owner",
    created_at: p.created_at,
    updated_at: p.updated_at,
    last_processed_at: p.last_processed_at,
    current_run_id: p.current_run_id,
    ...(stats ? { stats: await projectStats(p) } : {}),
  };
}

function docOut(d: DocumentRow) {
  return { id: d.id, filename: d.original_filename, content_type: d.content_type, size_bytes: d.size_bytes, page_count: d.page_count, status: d.status, error: d.error, sha256: d.sha256, created_at: d.created_at };
}

async function pageOut(p: PageRow, doc: DocumentRow | undefined) {
  const cls = (p.classification ?? {}) as { confidence?: number; signals?: unknown[]; secondary_types?: string[] };
  const type = p.page_type_override || p.page_type;
  return {
    id: p.id,
    document_id: p.document_id,
    document: doc ? doc.original_filename : null,
    page_index: p.page_index,
    page: p.page_index + 1,
    page_in_document: p.page_in_document + 1,
    width: p.width,
    height: p.height,
    unit: p.unit,
    mm_per_unit: p.mm_per_unit,
    rotation: p.rotation,
    image_url: p.has_image ? await imageUrl(`${p.id}:image`) : null,
    thumb_url: p.has_image ? await imageUrl(`${p.id}:thumb`) : null,
    image_width: p.image_width,
    image_height: p.image_height,
    region_token: "",
    page_type: type,
    page_type_detected: p.page_type,
    page_type_override: p.page_type_override,
    page_type_label: tx(PAGE_TYPE_LABELS[type ?? ""] ?? "Not analysed"),
    classification_confidence: cls.confidence ?? null,
    classification_signals: ((cls.signals ?? []) as { detail?: string }[]).map((sg) => ({ ...sg, detail: tx(sg.detail) })),
    secondary_types: cls.secondary_types ?? [],
    sheet_number: p.sheet_number,
    sheet_title: p.sheet_title,
    floor: p.floor,
    scale: p.scale ?? {},
    scale_override: p.scale_override,
    quality: p.quality ?? {},
    analysed: p.analysed,
  };
}

async function activeOpenings(pid: string): Promise<OpeningRow[]> {
  return (await byProject("openings", pid)).filter((o) => o.deleted_at === null).sort((a, b) => a.sort_index - b.sort_index || (a.ref < b.ref ? -1 : 1));
}

async function getOpening(pid: string, oid: string, includeDeleted = false): Promise<OpeningRow> {
  const o = await (await db()).get("openings", oid);
  if (!o || o.project_id !== pid || (o.deleted_at !== null && !includeDeleted)) throw new ApiError(404, "Opening not found");
  return o;
}

function auditOut(e: AuditRow) {
  return { id: e.id, opening_id: e.opening_id, opening_ref: e.opening_ref, actor: e.actor, user: e.user, action: e.action, field: e.field, old_value: e.old_value, new_value: e.new_value, message: locAuditMessage(e.message), created_at: e.created_at };
}

/** An opening as the screens receive it (labels and messages in the current language). */
function openingOut(o: OpeningRow) {
  return locOpening(svc.toDict(o));
}

/** Run an opening mutation, persisting the opening and its audit events together. */
async function mutateOpening(pid: string, oid: string, fn: (p: ProjectRow, o: OpeningRow, sink: svc.AuditSink) => void | Promise<void>, includeDeleted = false) {
  const p = await getProject(pid);
  const o = await getOpening(pid, oid, includeDeleted);
  const events: Omit<AuditRow, "id" | "project_id" | "created_at">[] = [];
  try {
    await fn(p, o, (e) => events.push(e));
  } catch (e) {
    if (e instanceof svc.EditError) throw new ApiError(422, e.message);
    throw e;
  }
  await (await db()).put("openings", o);
  await writeAudit(pid, events);
  await touch(p);
  return openingOut(o);
}

// ---------------------------------------------------------------------------
// session / system
// ---------------------------------------------------------------------------

async function sessionOut() {
  const prof = await getProfile();
  return { user: { id: "local", email: "", name: prof.name, preferences: prof.preferences ?? {}, workspace: true, local: true }, csrf_token: "" };
}
route("POST", "/api/auth/workspace", () => sessionOut());
route("GET", "/api/auth/me", () => sessionOut());
route("PATCH", "/api/auth/me", async (_m, _q, body) => {
  const b = (body ?? {}) as { name?: string };
  const prof = await getProfile();
  if (typeof b.name === "string") prof.name = b.name.trim().slice(0, 200);
  await setProfile(prof);
  return (await sessionOut()).user;
});
route("PATCH", "/api/auth/me/preferences", async (_m, _q, body) => {
  const b = (body ?? {}) as { display_unit?: string; thresholds?: { high: number; medium: number } };
  const prof = await getProfile();
  const prefs = { ...(prof.preferences ?? {}) };
  if (b.display_unit !== undefined) {
    if (!UNITS.includes(b.display_unit)) throw new ApiError(422, "unknown display unit");
    prefs.display_unit = b.display_unit;
  }
  if (b.thresholds) {
    const t = Thresholds.fromDict(b.thresholds);
    prefs.thresholds = { high: t.high, medium: t.medium };
  }
  prof.preferences = prefs;
  await setProfile(prof);
  return (await sessionOut()).user;
});

route("GET", "/api/system", async () => ({
  app_version: APP_VERSION,
  extraction_version: EXTRACTION_VERSION,
  ocr: { provider: "tesseract.js", available: true, version: "5" },
  vision: { provider: "none", model: null, configured: false, used_for: "ambiguous page classification and dimension associations only; it can only pick among values read from the drawing" },
  limits: { max_upload_mb: 200, max_pages_per_document: 300, max_files_per_upload: 20 },
  opening_types: locLabels(OPENING_TYPE_LABELS),
  page_types: locLabels(PAGE_TYPE_LABELS),
  storage: "device",
}));

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

route("GET", "/api/projects", async () => {
  const ps = (await (await db()).getAll("projects")).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return Promise.all(ps.map((p) => projectOut(p)));
});

export async function createProject(name: string, extra: Partial<ProjectRow> = {}): Promise<ProjectRow> {
  const prof = await getProfile();
  const prefs = prof.preferences ?? {};
  const t = nowIso();
  const p: ProjectRow = {
    id: uuid(),
    name: name.trim(),
    description: "",
    info: { project_name: name.trim(), prepared_by: prof.name || null },
    settings: { thresholds: prefs.thresholds ?? { high: 0.85, medium: 0.6 }, display_unit: prefs.display_unit ?? "mm", default_unit: "mm" },
    is_demo: false,
    current_run_id: null,
    last_processed_at: null,
    created_at: t,
    updated_at: t,
    ...extra,
  };
  await (await db()).put("projects", p);
  await audit(p.id, "user", "create_project", `Project created by ${await user()}`, { user: await user() });
  return p;
}

route("POST", "/api/projects", async (_m, _q, body) => {
  const b = (body ?? {}) as { name?: string };
  if (!b.name || !b.name.trim()) throw new ApiError(422, "Enter a project name");
  if (b.name.length > 200) throw new ApiError(422, "Project name is too long");
  return projectOut(await createProject(b.name));
});

route("POST", "/api/projects/demo", async () => {
  const res = await fetch(new URL("demo/Residential_Plans.pdf", document.baseURI));
  if (!res.ok) throw new ApiError(500, "The demo drawing set could not be loaded");
  const data = new Uint8Array(await res.arrayBuffer());
  const p = await createProject("Residential Building (Demo)", {
    description: "Sample project - a generated 10-page residential drawing set with plans, elevations and schedules.",
    is_demo: true,
    info: { project_name: "Residential Building", drawing_set_name: "Residential_Plans.pdf - Construction Issue Rev B", project_address: "14 Harbour Street, Northbridge", prepared_by: (await getProfile()).name || "", date: "", notes: "" },
  });
  await addDocument(p, "Residential_Plans.pdf", data);
  const job = await enqueueJob(p.id, "demo");
  return { ...(await projectOut(p)), job: jobOut(job) };
});

route("GET", "/api/projects/:pid", async (m) => projectOut(await getProject(m.groups!.pid)));

route("PATCH", "/api/projects/:pid", async (m, _q, body) => {
  const p = await getProject(m.groups!.pid);
  const b = (body ?? {}) as { name?: string; description?: string; info?: Record<string, string | null>; settings?: Record<string, unknown> };
  if (b.name !== undefined) {
    if (!b.name.trim()) throw new ApiError(422, "Name cannot be empty");
    p.name = b.name.trim().slice(0, 200);
  }
  if (b.description !== undefined) p.description = b.description;
  if (b.info) {
    const info = { ...(p.info ?? {}) };
    for (const [k, v] of Object.entries(b.info)) {
      if (!INFO_KEYS.includes(k)) throw new ApiError(422, `unknown project info field '${k}'`);
      if (v !== null && v !== undefined && String(v).length > (k === "notes" ? 5000 : 300)) throw new ApiError(422, `${k} is too long`);
      info[k] = v;
    }
    p.info = info;
  }
  let thresholdsChanged = false;
  if (b.settings) {
    const st = { ...p.settings };
    for (const [k, v] of Object.entries(b.settings)) {
      if (k === "thresholds") {
        const tv = v as { high: number; medium: number };
        const t = Thresholds.fromDict(tv);
        if (t.high !== Number(tv.high ?? t.high) || t.medium !== Number(tv.medium ?? t.medium)) throw new ApiError(422, "Thresholds must satisfy 0 < medium < high <= 1");
        st.thresholds = { high: t.high, medium: t.medium };
        thresholdsChanged = true;
      } else if (k === "display_unit") {
        if (!UNITS.includes(String(v))) throw new ApiError(422, "unknown display unit");
        st.display_unit = String(v);
      } else if (k === "default_unit") {
        if (!["mm", "cm", "m", "in"].includes(String(v))) throw new ApiError(422, "unknown default unit");
        st.default_unit = String(v);
      } else throw new ApiError(422, `unknown setting '${k}'`);
    }
    p.settings = st;
  }
  if (thresholdsChanged) {
    const thr = svc.thresholdsFor(p);
    const d = await db();
    for (const o of await activeOpenings(p.id)) {
      svc.refreshStatus(o, thr);
      await d.put("openings", o);
    }
  }
  await touch(p);
  await audit(p.id, "user", "update_project", "Project details updated", { user: await user() });
  return projectOut(p);
});


route("DELETE", "/api/projects/:pid", async (m) => {
  await getProject(m.groups!.pid);
  await deleteProjectData(m.groups!.pid);
  return undefined;
});

/** High-resolution rendering of part of a page (the viewer, zoomed in); returns an object URL. */
export async function renderRegionUrl(pid: string, pageId: string, x: number, y: number, w: number, h: number, scale: number): Promise<string> {
  await getProject(pid);
  const d = await db();
  const page = await d.get("pages", pageId);
  if (!page || page.project_id !== pid) throw new ApiError(404, "Page not found");
  const doc = await d.get("documents", page.document_id);
  if (!doc) throw new ApiError(404, "Document not found");
  if (![x, y, w, h, scale].every(Number.isFinite) || w <= 0 || h <= 0 || scale <= 0) throw new ApiError(422, "invalid region");
  const blob = await engine().renderRegion(
    {
      id: doc.id,
      filename: doc.original_filename,
      load: async () => {
        const f = await d.get("files", doc.id);
        if (!f) throw new ApiError(404, "The drawing file is missing");
        return new Uint8Array(await f.arrayBuffer());
      },
    },
    page.page_in_document,
    x,
    y,
    w,
    h,
    Math.min(scale, 12),
  );
  return URL.createObjectURL(blob);
}

// project files (save / open)
route("GET", "/api/projects/:pid/file", async (m) => {
  const p = await getProject(m.groups!.pid);
  const { bytes, filename } = await saveProjectFile(p.id);
  await audit(p.id, "user", "save_file", `Project saved to ${filename}`, { user: await user() });
  return { blob: new Blob([bytes as BlobPart], { type: "application/zip" }), filename };
});

/** Open a project file (the UI's "Open project file"). */
export async function openProjectUpload(file: File, mode: OpenMode = "new") {
  if (file.size > 1536 * 1024 * 1024) throw new ApiError(422, "The project file is too large to open");
  try {
    const p = await openProjectFile(new Uint8Array(await file.arrayBuffer()), mode);
    return projectOut(p);
  } catch (e) {
    if (e instanceof ProjectFileError) {
      if (e.existing) throw new ApiError(409, e.message, { existing: e.existing });
      throw new ApiError(422, e.message);
    }
    throw e;
  }
}

route("GET", "/api/projects/:pid/members", async () => []);

route("GET", "/api/projects/:pid/runs", async (m) => {
  const p = await getProject(m.groups!.pid);
  const runs = (await byProject("runs", p.id)).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return runs.map((r) => ({ ...r, current: r.id === p.current_run_id }));
});

route("GET", "/api/projects/:pid/jobs", async (m) => {
  const jobs = (await byProject("jobs", m.groups!.pid)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20);
  return jobs.map(jobOut);
});

route("POST", "/api/projects/:pid/process", async (m) => {
  const p = await getProject(m.groups!.pid);
  if (!(await byProject("documents", p.id)).length) throw new ApiError(409, "Upload drawings first");
  const running = (await byProject("jobs", p.id)).some((j) => j.status === "running");
  const job = await enqueueJob(p.id, "reprocess");
  await audit(p.id, "user", "reprocess", `Re-extraction requested (pipeline v${EXTRACTION_VERSION})`, { user: await user() });
  return { job: jobOut(job), queued_behind_running_job: running };
});

route("GET", "/api/projects/:pid/audit", async (m, q) => {
  const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 200), 1000));
  const rows = (await byProject("audit", m.groups!.pid)).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, limit);
  return rows.map(auditOut);
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

route("GET", "/api/projects/:pid/documents", async (m) => {
  const docs = (await byProject("documents", m.groups!.pid)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return docs.map(docOut);
});

export async function addDocument(p: ProjectRow, filename: string, data: Uint8Array): Promise<DocumentRow> {
  const meta = await validateUpload(filename, data);
  const sha = await sha256Hex(data);
  const dup = (await byProject("documents", p.id)).find((d) => d.sha256 === sha);
  if (dup) throw new UploadError(`This file was already uploaded as ${dup.original_filename}`);
  const doc: DocumentRow = {
    id: uuid(),
    project_id: p.id,
    original_filename: meta.filename,
    content_type: meta.contentType,
    size_bytes: data.length,
    sha256: sha,
    page_count: meta.pageCount,
    status: "uploaded",
    error: null,
    // strictly increasing, so page order follows upload order
    created_at: new Date(Date.now() + ((await byProject("documents", p.id)).length ? 1 : 0)).toISOString(),
  };
  const d = await db();
  await d.put("files", new Blob([data as BlobPart], { type: meta.contentType }), doc.id);
  await d.put("documents", doc);
  await audit(p.id, "user", "upload", `Uploaded ${doc.original_filename} (${doc.page_count} page${doc.page_count !== 1 ? "s" : ""})`, { user: await user() });
  return doc;
}

/** Upload files (the UI's multipart upload). */
export async function uploadFiles(pid: string, files: File[], onProgress?: (frac: number) => void) {
  const p = await getProject(pid);
  if (!files.length) throw new ApiError(422, "No files uploaded");
  if (files.length > 20) throw new ApiError(422, "Upload at most 20 files at a time");
  const created: DocumentRow[] = [];
  const errors: { filename: string; error: string }[] = [];
  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let done = 0;
  for (const f of files) {
    try {
      if (f.size > 200 * 1024 * 1024) throw new UploadError("File exceeds the 200 MB limit");
      const data = new Uint8Array(await f.arrayBuffer());
      created.push(await addDocument(p, f.name, data));
    } catch (e) {
      errors.push({ filename: f.name, error: e instanceof Error ? e.message : String(e) });
    }
    done += f.size;
    onProgress?.(done / total);
  }
  let job: JobRow | null = null;
  if (created.length) {
    job = await enqueueJob(p.id, "upload");
    await touch(p);
  }
  if (!created.length && errors.length) throw new ApiError(422, "No files were accepted", { detail: { message: "No files were accepted", errors } });
  return { documents: created.map(docOut), errors, job: job ? jobOut(job) : null };
}

route("DELETE", "/api/projects/:pid/documents/:did", async (m) => {
  const p = await getProject(m.groups!.pid);
  const d = await db();
  const doc = await d.get("documents", m.groups!.did);
  if (!doc || doc.project_id !== p.id) throw new ApiError(404, "Document not found");
  const pages = await d.getAllFromIndex("pages", "document", doc.id);
  const ids = new Set(pages.map((x) => x.id));
  for (const pg of pages) {
    await d.delete("images", `${pg.id}:image`);
    await d.delete("images", `${pg.id}:thumb`);
    await d.delete("overlays", pg.id);
    revokeImage(`${pg.id}:image`);
    revokeImage(`${pg.id}:thumb`);
    await d.delete("pages", pg.id);
  }
  // openings keep the user's work but lose their link to the removed pages
  for (const o of await byProject("openings", p.id)) {
    if (o.page_id && ids.has(o.page_id)) {
      o.page_id = null;
      await d.put("openings", o);
    }
  }
  await d.delete("files", doc.id);
  await d.delete("documents", doc.id);
  await audit(p.id, "user", "delete_document", `Deleted ${doc.original_filename}`, { user: await user() });
  // renumber remaining pages
  const docs = (await byProject("documents", p.id)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const order = new Map(docs.map((x, i) => [x.id, i]));
  const remaining = (await byProject("pages", p.id)).sort((a, b) => (order.get(a.document_id)! - order.get(b.document_id)! || a.page_in_document - b.page_in_document));
  for (let i = 0; i < remaining.length; i++) {
    remaining[i].page_index = i;
    await d.put("pages", remaining[i]);
  }
  await touch(p);
  return undefined;
});

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

route("GET", "/api/projects/:pid/pages", async (m) => {
  const pid = m.groups!.pid;
  const docs = new Map((await byProject("documents", pid)).map((d) => [d.id, d]));
  const pages = (await byProject("pages", pid)).sort((a, b) => a.page_index - b.page_index);
  return Promise.all(pages.map((p) => pageOut(p, docs.get(p.document_id))));
});

route("PATCH", "/api/projects/:pid/pages/:id", async (m, _q, body) => {
  const pr = await getProject(m.groups!.pid);
  const d = await db();
  const p = await d.get("pages", m.groups!.id);
  if (!p || p.project_id !== pr.id) throw new ApiError(404, "Page not found");
  const b = (body ?? {}) as { page_type_override?: string | null; scale_override?: string | null; clear_page_type?: boolean };
  const u = await user();
  if (b.clear_page_type) {
    p.page_type_override = null;
    await audit(pr.id, "user", "page_type", `Page ${p.page_index + 1}: page type override removed`, { user: u });
  } else if (b.page_type_override !== undefined && b.page_type_override !== null) {
    if (!(PAGE_TYPES as readonly string[]).includes(b.page_type_override)) throw new ApiError(422, "unknown page type");
    p.page_type_override = b.page_type_override;
    await audit(pr.id, "user", "page_type", `Page ${p.page_index + 1} classified as ${PAGE_TYPE_LABELS[b.page_type_override]} by user`, { user: u, new: b.page_type_override });
  }
  if (b.scale_override !== undefined && b.scale_override !== null) {
    if (b.scale_override.trim() === "") {
      p.scale_override = null;
      await audit(pr.id, "user", "scale", `Page ${p.page_index + 1}: manual scale removed`, { user: u });
    } else {
      const parsed = parseScale(b.scale_override);
      if (!parsed) throw new ApiError(422, "Could not read that scale - use e.g. 1:100 or 1/4\" = 1'-0\"");
      const [text, ratio] = parsed;
      p.scale_override = { text: text.includes("=") ? text : formatRatio(ratio), ratio };
      await audit(pr.id, "user", "scale", `Page ${p.page_index + 1}: manual scale set to ${p.scale_override.text}`, { user: u, new: p.scale_override });
    }
  }
  await d.put("pages", p);
  return pageOut(p, await d.get("documents", p.document_id));
});

const EMPTY_OVERLAY = { views: [], dimensions: [], tags: [], detections: [], schedule_rows: [], text: [] };

route("GET", "/api/projects/:pid/pages/:id/overlay", async (m) => {
  const ov = await (await db()).get("overlays", m.groups!.id);
  return ov ?? EMPTY_OVERLAY;
});

route("GET", "/api/projects/:pid/search", async (m, q) => {
  const needle = (q.get("q") ?? "").trim().toUpperCase();
  if (!needle) throw new ApiError(422, "Enter something to search for");
  const d = await db();
  const out: Record<string, unknown>[] = [];
  const pages = (await byProject("pages", m.groups!.pid)).sort((a, b) => a.page_index - b.page_index);
  for (const p of pages) {
    const ov = (await d.get("overlays", p.id)) as { text?: { text: string; bbox: unknown }[] } | undefined;
    for (const t of ov?.text ?? []) {
      if (t.text.toUpperCase().includes(needle)) {
        out.push({ page_id: p.id, page_index: p.page_index, sheet: p.sheet_number, text: t.text, bbox: t.bbox });
        if (out.length >= 200) return out;
      }
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// openings
// ---------------------------------------------------------------------------

route("GET", "/api/projects/:pid/openings", async (m, q) => {
  const pid = m.groups!.pid;
  const all = q.get("include_deleted") === "true" ? await byProject("openings", pid) : await activeOpenings(pid);
  return all.map(openingOut);
});

route("POST", "/api/projects/:pid/openings", async (m, _q, body) => {
  const p = await getProject(m.groups!.pid);
  const existing = await byProject("openings", p.id);
  const pages = await byProject("pages", p.id);
  const events: Omit<AuditRow, "id" | "project_id" | "created_at">[] = [];
  let o: OpeningRow;
  try {
    o = svc.createManual(p, existing, (body ?? {}) as Record<string, unknown>, await user(), pages, (e) => events.push(e));
  } catch (e) {
    if (e instanceof svc.EditError) throw new ApiError(422, e.message);
    throw e;
  }
  await (await db()).put("openings", o);
  await writeAudit(p.id, events);
  await touch(p);
  return openingOut(o);
});

route("PATCH", "/api/projects/:pid/openings/:oid", async (m, _q, body) => {
  const b = (body ?? {}) as { changes?: Record<string, unknown>; version?: number };
  const pages = await byProject("pages", m.groups!.pid);
  const u = await user();
  return mutateOpening(m.groups!.pid, m.groups!.oid, (p, o, sink) => {
    if (b.version !== undefined && b.version !== null && b.version !== o.version) throw new ApiError(409, "This opening was changed elsewhere - reload to see the latest values");
    svc.applyEdits(p, o, b.changes ?? {}, u, pages, sink);
  });
});

route("POST", "/api/projects/:pid/openings/:oid/verify", async (m, _q, body) => {
  const verified = (body as { verified?: boolean } | undefined)?.verified ?? true;
  const u = await user();
  return mutateOpening(m.groups!.pid, m.groups!.oid, (p, o, sink) => svc.verify(p, o, u, verified, sink));
});

route("POST", "/api/projects/:pid/openings/:oid/resolve-conflict", async (m, _q, body) => {
  const b = (body ?? {}) as { field?: string; candidate_index?: number };
  if (b.field !== "width" && b.field !== "height") throw new ApiError(422, "field must be width or height");
  const u = await user();
  return mutateOpening(m.groups!.pid, m.groups!.oid, (p, o, sink) => svc.resolveConflict(p, o, b.field as "width" | "height", Number(b.candidate_index), u, sink));
});

route("POST", "/api/projects/:pid/openings/:oid/ai-update", async (m, _q, body) => {
  const accept = !!(body as { accept?: boolean } | undefined)?.accept;
  const pages = new Map((await byProject("pages", m.groups!.pid)).map((p) => [p.page_index, p]));
  const u = await user();
  return mutateOpening(m.groups!.pid, m.groups!.oid, (p, o, sink) => svc.acceptPending(p, o, u, accept, pages, sink));
});

route("DELETE", "/api/projects/:pid/openings/:oid", async (m) => {
  const u = await user();
  await mutateOpening(m.groups!.pid, m.groups!.oid, (_p, o, sink) => {
    o.deleted_at = nowIso();
    o.version += 1;
    sink(svc.auditFor(o, "user", "delete", `User deleted ${o.ref} ${o.tag || ""}`.trim(), { user: u }));
  });
  return undefined;
});

route("POST", "/api/projects/:pid/openings/:oid/restore", async (m) => {
  const u = await user();
  return mutateOpening(
    m.groups!.pid,
    m.groups!.oid,
    (_p, o, sink) => {
      o.deleted_at = null;
      o.version += 1;
      sink(svc.auditFor(o, "user", "restore", `User restored ${o.ref}`, { user: u }));
    },
    true,
  );
});

route("GET", "/api/projects/:pid/openings/:oid/audit", async (m) => {
  const o = await getOpening(m.groups!.pid, m.groups!.oid, true);
  const rows = (await (await db()).getAllFromIndex("audit", "opening", o.id)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return rows.map(auditOut);
});

route("GET", "/api/projects/:pid/review", async (m) => {
  const items = svc.reviewItems(await activeOpenings(m.groups!.pid)).map(locReviewItem);
  return { count: new Set(items.map((i) => i.opening_id)).size, items };
});

// ---------------------------------------------------------------------------
// schedule and export
// ---------------------------------------------------------------------------

route("GET", "/api/projects/:pid/schedule", async (m, q) => {
  const groupBy = q.get("group_by") ?? "type";
  const unit = q.get("unit") ?? "mm";
  if (!(GROUP_BY as readonly string[]).includes(groupBy)) throw new ApiError(422, `group_by must be one of ${GROUP_BY.join(", ")}`);
  if (!UNITS.includes(unit)) throw new ApiError(422, "unknown unit");
  return locSchedule(buildSchedule(await activeOpenings(m.groups!.pid), groupBy, unit, q.get("include_unverified") !== "false"));
});

route("POST", "/api/projects/:pid/export/pdf", async (m, _q, body) => {
  const p = await getProject(m.groups!.pid);
  const b = { kind: "summary", page_size: "A4", orientation: "portrait", group_by: "type", unit: "mm", include_unverified: true, include_notes: true, ...(body as object) } as {
    kind: string;
    page_size: string;
    orientation: string;
    group_by: string;
    unit: string;
    include_unverified: boolean;
    include_notes: boolean;
    info?: Record<string, string | null>;
  };
  if (!["summary", "detailed"].includes(b.kind)) throw new ApiError(422, "kind must be summary or detailed");
  if (!["A4", "A3", "LETTER"].includes(b.page_size.toUpperCase()) || !["portrait", "landscape"].includes(b.orientation)) throw new ApiError(422, "unsupported page size or orientation");
  if (!(GROUP_BY as readonly string[]).includes(b.group_by) || !UNITS.includes(b.unit)) throw new ApiError(422, "invalid grouping or unit");
  const info = { ...(p.info ?? {}) };
  for (const [k, v] of Object.entries(b.info ?? {})) if (INFO_KEYS.includes(k) && (v === null || String(v).length <= 5000)) info[k] = v;
  p.info = info;
  await touch(p);
  const ops = await activeOpenings(p.id);
  const sched = buildSchedule(ops, b.group_by, b.unit, b.include_unverified);
  const included = ops.filter((o) => b.include_unverified || o.verified);
  const pages = await byProject("pages", p.id);
  const blob = await buildReport({
    projectName: p.name,
    info,
    schedule: locSchedule(sched),
    openings: included,
    pages,
    kind: b.kind as "summary" | "detailed",
    pageSize: b.page_size.toUpperCase() as "A4" | "A3" | "LETTER",
    orientation: b.orientation as "portrait" | "landscape",
    includeNotes: b.include_notes,
    generatedBy: await user(),
  });
  await audit(p.id, "user", "export_pdf", `${b.kind[0].toUpperCase() + b.kind.slice(1)} PDF exported (${b.page_size.toUpperCase()} ${b.orientation}, ${included.length} opening types)`, { user: await user() });
  const fname = ((info.project_name || p.name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "project") + `_measurement_schedule_${b.kind}.pdf`;
  return { blob, filename: fname };
});
