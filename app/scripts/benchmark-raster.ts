/**
 * Scan / OCR-path benchmark: rasterised floor plans with per-image truth.
 *
 *   npx tsx scripts/benchmark-raster.ts [images-dir]
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { useNodePlatform } from "../src/engine/node/platform";
import { runOnBytes } from "../src/engine/runner";
import { Metrics, evaluate, markdownReport, type GroundTruth } from "../src/engine/benchmark";
import { TesseractOCR } from "../src/engine/ocr";
import { createTesseractBackend } from "../src/engine/tesseract";

const require = createRequire(import.meta.url);
const dir = process.argv[2] ?? path.join(import.meta.dirname, "..", "benchmark", "raster");
useNodePlatform();
const backend = await createTesseractBackend({ langPath: path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int") });
const ocr = new TesseractOCR(backend);
const total = new Metrics();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
  const name = f.replace(/\.png$/, "");
  const truth = JSON.parse(readFileSync(path.join(dir, `${name}.truth.json`), "utf8")) as GroundTruth;
  const t = performance.now();
  const res = await runOnBytes([[f, new Uint8Array(readFileSync(path.join(dir, f)))]], ocr);
  const m = evaluate(truth, res.records);
  total.merge(m);
  console.error(`${name}: tp ${m.detTp} fn ${m.detFn} fp ${m.detFp} tags ${m.tag.correct}/${m.tag.total} assoc ${m.association.correct} (${((performance.now() - t) / 1000).toFixed(1)} s)`, res.warnings);
}
await backend.terminate();
console.log(markdownReport({ disclaimer: "Measured on a synthetic, programmatically generated dataset. Not a claim about accuracy on real-world drawings.", vector: null, raster: total.toDict() }));
