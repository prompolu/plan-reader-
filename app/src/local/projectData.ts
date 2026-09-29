/**
 * Whole-project data operations: delete a project, save it as a project file
 * and open a project file.
 *
 * A project file (.planmeasure) is a zip archive with the original drawings,
 * the rendered pages, the extraction results, every edit and verification and
 * the audit trail - everything needed to continue the review on another
 * computer or phone.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { EXTRACTION_VERSION, sniffType } from "../engine/meta";
import { byProject, db, nowIso, uuid, type AuditRow, type DocumentRow, type OpeningRow, type PageRow, type ProjectRow, type RunRow } from "./db";
import { revokeImage } from "./images";

export const APP_VERSION = "2.0.0";
export const PROJECT_FILE_EXT = ".planmeasure";
const FORMAT = "planmeasure-project";
const FORMAT_VERSION = 1;
const MAX_ENTRY_BYTES = 400 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1536 * 1024 * 1024;

export class ProjectFileError extends Error {
  constructor(
    message: string,
    /** set when the project in the file is already in the app */
    readonly existing?: { id: string; name: string; updated_at: string },
  ) {
    super(message);
  }
}

export async function deleteProjectData(pid: string): Promise<void> {
  const d = await db();
  for (const pg of await byProject("pages", pid)) {
    await d.delete("images", `${pg.id}:image`);
    await d.delete("images", `${pg.id}:thumb`);
    await d.delete("overlays", pg.id);
    revokeImage(`${pg.id}:image`);
    revokeImage(`${pg.id}:thumb`);
    await d.delete("pages", pg.id);
  }
  for (const doc of await byProject("documents", pid)) {
    await d.delete("files", doc.id);
    await d.delete("documents", doc.id);
  }
  for (const o of await byProject("openings", pid)) await d.delete("openings", o.id);
  for (const r of await byProject("runs", pid)) await d.delete("runs", r.id);
  for (const j of await byProject("jobs", pid)) await d.delete("jobs", j.id);
  for (const a of await byProject("audit", pid)) await d.delete("audit", a.id!);
  await d.delete("projects", pid);
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

interface ProjectJson {
  project: ProjectRow;
  documents: DocumentRow[];
  pages: PageRow[];
  openings: OpeningRow[];
  runs: RunRow[];
  audit: Omit<AuditRow, "id">[];
}

const FILE_EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

export function projectFileName(name: string): string {
  return (name.replace(/[^A-Za-z0-9._ -]+/g, "_").trim().slice(0, 80) || "project") + PROJECT_FILE_EXT;
}

/** Build the project file for a project. */
export async function saveProjectFile(pid: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const d = await db();
  const project = await d.get("projects", pid);
  if (!project) throw new ProjectFileError("Project not found");
  const documents = await byProject("documents", pid);
  const pages = await byProject("pages", pid);
  const content: ProjectJson = {
    project,
    documents,
    pages,
    openings: await byProject("openings", pid),
    runs: (await byProject("runs", pid)).filter((r) => r.status !== "running"),
    audit: (await byProject("audit", pid)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(({ id: _id, ...rest }) => rest),
  };
  const files: Zippable = {};
  const bin = async (blob: Blob | undefined) => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
  for (const doc of documents) {
    const data = await bin(await d.get("files", doc.id));
    // drawings, PNG and JPEG are already compressed: store them as they are
    if (data) files[`documents/${doc.id}.${FILE_EXT[doc.content_type] ?? "bin"}`] = [data, { level: 0 }];
  }
  for (const pg of pages) {
    const image = await bin(await d.get("images", `${pg.id}:image`));
    const thumb = await bin(await d.get("images", `${pg.id}:thumb`));
    const overlay = await d.get("overlays", pg.id);
    if (image) files[`pages/${pg.id}.png`] = [image, { level: 0 }];
    if (thumb) files[`pages/${pg.id}.thumb.jpg`] = [thumb, { level: 0 }];
    if (overlay) files[`pages/${pg.id}.overlay.json`] = strToU8(JSON.stringify(overlay));
  }
  files["project.json"] = strToU8(JSON.stringify(content));
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        format: FORMAT,
        format_version: FORMAT_VERSION,
        app_version: APP_VERSION,
        extraction_version: EXTRACTION_VERSION,
        saved_at: nowIso(),
        project: { id: project.id, name: project.name },
        counts: { documents: documents.length, pages: pages.length, openings: content.openings.filter((o) => !o.deleted_at).length },
      },
      null,
      2,
    ),
  );
  const bytes = zipSync(files, { level: 6 });
  return { bytes, filename: projectFileName(project.name) };
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function readArchive(data: Uint8Array): Record<string, Uint8Array> {
  if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)) {
    throw new ProjectFileError("This is not a PlanMeasure project file");
  }
  let total = 0;
  try {
    return unzipSync(data, {
      filter: (f) => {
        total += f.originalSize;
        if (f.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new ProjectFileError("The project file is too large to open");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ProjectFileError) throw e;
    throw new ProjectFileError("The project file is damaged and could not be read");
  }
}

function parseJson(entries: Record<string, Uint8Array>, name: string): unknown {
  const raw = entries[name];
  if (!raw) throw new ProjectFileError(`The project file is incomplete (${name} is missing)`);
  try {
    return JSON.parse(strFromU8(raw));
  } catch {
    throw new ProjectFileError(`The project file is damaged (${name} could not be read)`);
  }
}

function validate(content: unknown): ProjectJson {
  const bad = (what: string) => new ProjectFileError(`The project file is damaged (${what})`);
  if (!isObj(content) || !isObj(content.project)) throw bad("no project");
  const project = content.project as unknown as ProjectRow;
  if (!isStr(project.id) || !isStr(project.name)) throw bad("project");
  const out: Partial<ProjectJson> = { project };
  for (const key of ["documents", "pages", "openings", "runs", "audit"] as const) {
    const rows = content[key];
    if (!Array.isArray(rows)) throw bad(key);
    for (const r of rows) {
      if (!isObj(r) || r.project_id !== project.id) throw bad(key);
      if (key !== "audit" && !isStr(r.id)) throw bad(key);
    }
    (out as Record<string, unknown>)[key] = rows;
  }
  const docIds = new Set(out.documents!.map((x) => x.id));
  for (const p of out.pages!) if (!docIds.has(p.document_id)) throw bad("pages");
  return out as ProjectJson;
}

/** Replace every id in `ids` wherever it appears (a copy gets new ids throughout). */
function remap<T>(value: T, ids: Map<string, string>): T {
  if (isStr(value)) return (ids.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => remap(v, ids)) as T;
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids)])) as T;
  return value;
}

export type OpenMode = "new" | "replace" | "copy";

/**
 * Add the project in a project file to the app.
 * - "new": fails with `existing` set when the project is already in the app
 * - "replace": the copy in the app is replaced by the file's version
 * - "copy": opened as a separate project next to the existing one
 */
export async function openProjectFile(data: Uint8Array, mode: OpenMode = "new"): Promise<ProjectRow> {
  const entries = readArchive(data);
  const manifest = parseJson(entries, "manifest.json");
  if (!isObj(manifest) || manifest.format !== FORMAT) throw new ProjectFileError("This is not a PlanMeasure project file");
  if (typeof manifest.format_version !== "number" || manifest.format_version > FORMAT_VERSION) {
    throw new ProjectFileError("This project file was saved by a newer version of PlanMeasure AI - update the app to open it");
  }
  let c = validate(parseJson(entries, "project.json"));

  // original drawings and page images, keyed by the ids in the file
  const docFiles = new Map<string, { data: Uint8Array; type: string }>();
  for (const doc of c.documents) {
    const name = Object.keys(entries).find((n) => n.startsWith(`documents/${doc.id}.`));
    const bytes = name ? entries[name] : undefined;
    const type = bytes ? sniffType(bytes) : null;
    if (!bytes || !type) throw new ProjectFileError(`The project file is damaged (drawing ${doc.original_filename} is missing)`);
    docFiles.set(doc.id, { data: bytes, type });
  }

  const d = await db();
  const existing = await d.get("projects", c.project.id);
  if (existing && mode === "new") {
    throw new ProjectFileError("This project is already in the app", { id: existing.id, name: existing.name, updated_at: existing.updated_at });
  }

  const oldIds = { project: c.project.id, docs: c.documents.map((x) => x.id), pages: c.pages.map((x) => x.id) };
  let idOf = (id: string) => id;
  if (existing && mode === "copy") {
    const ids = new Map<string, string>();
    for (const id of [c.project.id, ...c.documents.map((x) => x.id), ...c.pages.map((x) => x.id), ...c.openings.map((x) => x.id), ...c.runs.map((x) => x.id)]) ids.set(id, uuid());
    c = remap(c, ids);
    c.project.name = `${c.project.name} (copy)`;
    idOf = (id: string) => ids.get(id) ?? id;
  }
  if (existing && mode === "replace") await deleteProjectData(existing.id);

  const project: ProjectRow = { ...c.project, current_run_id: c.project.current_run_id ?? null };
  const stores = ["projects", "documents", "files", "pages", "images", "overlays", "openings", "runs", "audit"] as const;
  const tx = d.transaction([...stores], "readwrite");
  await tx.objectStore("projects").put(project);
  for (const doc of c.documents) await tx.objectStore("documents").put(doc);
  for (const oldId of oldIds.docs) {
    const f = docFiles.get(oldId)!;
    await tx.objectStore("files").put(new Blob([f.data as BlobPart], { type: f.type }), idOf(oldId));
  }
  for (const [i, oldId] of oldIds.pages.entries()) {
    const page = c.pages[i];
    const image = entries[`pages/${oldId}.png`];
    const thumb = entries[`pages/${oldId}.thumb.jpg`];
    const overlay = entries[`pages/${oldId}.overlay.json`];
    const imageType = image ? sniffType(image) : null;
    const thumbType = thumb ? sniffType(thumb) : null;
    const isImage = (t: string | null) => t === "image/png" || t === "image/jpeg";
    const hasImage = isImage(imageType) && isImage(thumbType);
    if (hasImage) {
      await tx.objectStore("images").put(new Blob([image as BlobPart], { type: imageType! }), `${page.id}:image`);
      await tx.objectStore("images").put(new Blob([thumb as BlobPart], { type: thumbType! }), `${page.id}:thumb`);
    }
    // pages without images are rendered again on the next extraction
    await tx.objectStore("pages").put({ ...page, has_image: hasImage && page.has_image });
    if (overlay) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(strFromU8(overlay));
      } catch {
        // the viewer works without overlay data
      }
      if (isObj(parsed)) await tx.objectStore("overlays").put(parsed, page.id);
    }
  }
  for (const o of c.openings) await tx.objectStore("openings").put(o);
  for (const r of c.runs) await tx.objectStore("runs").put(r);
  for (const a of c.audit) {
    const { id: _drop, ...row } = a as AuditRow;
    await tx.objectStore("audit").add(row);
  }
  await tx.objectStore("audit").add({
    project_id: project.id,
    opening_id: null,
    opening_ref: null,
    actor: "system",
    user: null,
    action: "open_file",
    field: null,
    old_value: null,
    new_value: null,
    message: `Project opened from a project file saved ${isStr(manifest.saved_at) ? manifest.saved_at.slice(0, 16).replace("T", " ") + " UTC" : ""}`.trim(),
    created_at: nowIso(),
  });
  await tx.done;
  return project;
}
