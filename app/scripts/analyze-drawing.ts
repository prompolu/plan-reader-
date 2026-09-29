/**
 * Runs the extraction engine on real drawings and prints what it found, page
 * by page: page type, text layer, dimensions, openings and the resulting
 * opening types. For diagnosing drawings the app misreads.
 *
 *   npx tsx scripts/analyze-drawing.ts <file.pdf|png|jpg> [...more] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { useNodePlatform } from "../src/engine/node/platform";
import { pageResultToDict, runOnBytes } from "../src/engine/runner";
import { TesseractOCR } from "../src/engine/ocr";
import { createTesseractBackend } from "../src/engine/tesseract";

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const files = args.filter((_, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1));
if (!files.length) {
  console.error("usage: npx tsx scripts/analyze-drawing.ts <file> [...] [--json out.json]");
  process.exit(1);
}

const require = createRequire(import.meta.url);
useNodePlatform();
const backend = await createTesseractBackend({ langPath: path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int") });
const ocr = new TesseractOCR(backend);

const t0 = performance.now();
const res = await runOnBytes(
  files.map((f) => [path.basename(f), new Uint8Array(readFileSync(f))]),
  ocr,
  null,
  undefined,
  (step, frac, msg) => process.stderr.write(`  [${step} ${Math.round(frac * 100)}%] ${msg}\n`),
);
await backend.terminate();

console.log(`\n${files.join(", ")}: ${res.pages.length} page(s), ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (res.warnings.length) console.log("warnings:", res.warnings);
for (const r of res.pages) {
  const p = r.page;
  console.log(
    `\npage ${p.index + 1} "${p.label}": ${Math.round(p.width)}x${Math.round(p.height)} ${p.unit}, text layer ${p.hasTextLayer ? "yes" : "no (OCR)"}` +
      `, quality ${p.quality.poor ? "POOR " + p.quality.reasons.join("; ") : "ok"}`,
  );
  console.log(`  type ${r.cls.pageType} (${r.cls.confidence?.toFixed?.(2) ?? r.cls.confidence}), sheet ${r.cls.sheetNumber ?? "-"} "${r.cls.sheetTitle ?? ""}", floor ${r.cls.floor ?? "-"}`);
  console.log(`  views: ${r.views.map((v) => `${v.viewType}${v.title ? ` "${v.title}"` : ""}`).join(", ") || "-"}`);
  console.log(`  dimensions ${r.dims.length}: ${r.dims.slice(0, 25).map((d) => d.text).join(" | ")}${r.dims.length > 25 ? " …" : ""}`);
  console.log(`  tags ${r.tags.length}: ${r.tags.slice(0, 30).map((t) => t.text).join(" ")}`);
  console.log(`  openings detected ${r.detections.length}, schedule rows ${r.schedules.length}`);
}
console.log(`\nopening types: ${res.records.length}`);
for (const o of res.records) {
  const v = (m: typeof o.width) => (m ? `${m.value === null ? "?" : Math.round(m.value)}mm "${m.original_text ?? ""}" [${m.source}${m.status !== "explicit" ? " " + m.status : ""}]` : "—");
  console.log(`  ${o.tag ?? "(no tag)"} ${o.type} W ${v(o.width)} H ${v(o.height)} qty ${o.quantity} p${(o.page_index ?? -1) + 1} ${o.status}${o.flags.length ? " flags: " + o.flags.map((f) => f.code).join(",") : ""}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ pages: res.pages.map(pageResultToDict), records: res.records, warnings: res.warnings }, null, 1));
