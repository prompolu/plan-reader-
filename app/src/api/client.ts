/**
 * The screens talk to the app's own on-device API (IndexedDB + the extraction
 * engine in a Web Worker). Nothing is sent over the network.
 */
import { ApiError as LocalApiError, localApi, openProjectUpload, renderRegionUrl as localRegion, uploadFiles } from "../local/api";
import type { OpenMode } from "../local/projectData";

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function wrap(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof LocalApiError) return new ApiError(e.status, e.message, e.details);
  console.error(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (/quota|QuotaExceeded/i.test(msg)) return new ApiError(507, "This device is out of storage space for the app - delete old projects or free up space");
  return new ApiError(500, msg || "Something went wrong");
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return (await localApi(opts.method ?? "GET", path, opts.body)) as T;
  } catch (e) {
    throw wrap(e);
  }
}

/** Add drawings to a project (reading the files reports progress). */
export async function uploadWithProgress<T>(path: string, form: FormData, onProgress: (frac: number) => void): Promise<T> {
  const pid = /^\/api\/projects\/([^/]+)\/documents$/.exec(path)?.[1];
  if (!pid) throw new ApiError(404, "Not found");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  try {
    return (await uploadFiles(pid, files, onProgress)) as T;
  } catch (e) {
    throw wrap(e);
  }
}

/** Open a .planmeasure project file. A 409 error carries `details.existing` when the project is already here. */
export async function openProjectFile<T>(file: File, mode: OpenMode = "new"): Promise<T> {
  try {
    return (await openProjectUpload(file, mode)) as T;
  } catch (e) {
    throw wrap(e);
  }
}

/** Render part of a page at high resolution; returns an object URL the caller revokes. */
export async function renderRegion(projectId: string, pageId: string, x: number, y: number, w: number, h: number, scale: number): Promise<string> {
  try {
    return await localRegion(projectId, pageId, x, y, w, h, scale);
  } catch (e) {
    throw wrap(e);
  }
}

/** Save a file to the user's device (a save dialog in the desktop app, Downloads/Files in a browser). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Generate a file with the local API (PDF export, project file) and save it. */
export async function downloadBlob(path: string, body: unknown, fallbackName: string, method = "POST"): Promise<void> {
  const r = await api<{ blob: Blob; filename?: string }>(path, { method, body });
  saveBlob(r.blob, r.filename || fallbackName);
}
