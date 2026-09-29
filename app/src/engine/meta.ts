/** Engine constants with no dependencies (safe to import on the UI thread). */

export const EXTRACTION_VERSION = "1.4.0";

/** user-facing processing steps (id, label) */
export const STEPS: [string, string][] = [
  ["uploaded", "Uploaded"],
  ["rendered", "PDF rendered"],
  ["analyzed", "Pages analyzed"],
  ["classified", "Relevant pages identified"],
  ["dimensions", "Extracting dimensions"],
  ["openings", "Openings detected"],
  ["associated", "Associating dimensions with openings"],
  ["schedules", "Cross-checking schedules"],
  ["crossref", "Detecting duplicates and conflicts"],
  ["scored", "Scoring confidence"],
];

export function sniffType(data: Uint8Array): string | null {
  const b = (i: number) => data[i];
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d) return "application/pdf";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  return null;
}
