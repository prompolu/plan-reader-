/** Object URLs for rendered page images kept in IndexedDB. */
import { db } from "./db";

const urls = new Map<string, string>();

export async function imageUrl(key: string): Promise<string | null> {
  const cached = urls.get(key);
  if (cached) return cached;
  const blob = await (await db()).get("images", key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

export function revokeImage(key: string): void {
  const u = urls.get(key);
  if (u) {
    URL.revokeObjectURL(u);
    urls.delete(key);
  }
}

export async function imageBlob(key: string): Promise<Blob | undefined> {
  return (await db()).get("images", key);
}
