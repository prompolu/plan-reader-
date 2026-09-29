/** Checks on files added to a project (type by content, size, readable, page limits). */
import { sniffType } from "../engine/runner";
import { engine } from "./engineClient";

export class UploadError extends Error {}

const ALLOWED: Record<string, string[]> = { "application/pdf": [".pdf"], "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] };

export function safeFilename(name: string): string {
  let n = (name || "upload").replace(/\\/g, "/").split("/").pop() ?? "upload";
  n = n.normalize("NFKC").replace(/[<>:"|?*\u0000-\u001f]/g, "");
  n = n.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  return (n || "upload").slice(0, 200);
}

export async function validateUpload(filename: string, data: Uint8Array): Promise<{ contentType: string; filename: string; pageCount: number }> {
  if (!data.length) throw new UploadError("File is empty");
  if (data.length > 200 * 1024 * 1024) throw new UploadError("File exceeds the 200 MB limit");
  const ctype = sniffType(data);
  if (!ctype) throw new UploadError("Unsupported file type - add PDF, PNG or JPG drawings");
  const name = safeFilename(filename);
  const ext = name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "";
  if (!ALLOWED[ctype].includes(ext)) throw new UploadError(`File extension does not match its content (${ctype})`);
  const info = await engine().inspect(data, name);
  if (info.error) throw new UploadError(info.error);
  return { contentType: ctype, filename: name, pageCount: info.pageCount };
}
