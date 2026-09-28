/**
 * Accuracy benchmark over generated drawing sets with ground truth.
 *
 *   npx tsx scripts/benchmark.ts [sets-dir] [--out report-dir]
 *
 * Each set is `<name>.pdf` + `<name>.truth.json` (tools/drawing-generator).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useNodePlatform } from "../src/engine/node/platform";
import { runOnBytes } from "../src/engine/runner";
import { Metrics, evaluate, markdownReport, type GroundTruth } from "../src/engine/benchmark";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
const dir = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1)) ?? path.join(import.meta.dirname, "..", "benchmark", "sets");

useNodePlatform();
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".truth.json"))
  .map((f) => f.replace(/\.truth\.json$/, ""))
  .sort((a, b) => (a === "demo" ? -1 : b === "demo" ? 1 : a.localeCompare(b, "en", { numeric: true })));

const total = new Metrics();
const perSet: Record<string, unknown>[] = [];
const t0 = performance.now();
for (const name of names) {
  const pdf = new Uint8Array(readFileSync(path.join(dir, `${name}.pdf`)));
  const truth = JSON.parse(readFileSync(path.join(dir, `${name}.truth.json`), "utf8")) as GroundTruth;
  const t = performance.now();
  let met: Metrics;
  try {
    const res = await runOnBytes([[`${name}.pdf`, pdf]]);
    met = evaluate(truth, res.records);
  } catch (exc) {
    met = new Metrics();
    met.errors.push(`pipeline crashed: ${exc instanceof Error ? exc.stack : String(exc)}`);
  }
  total.merge(met);
  perSet.push({ set: name, seconds: Math.round((performance.now() - t) / 10) / 100, ...met.toDict() });
  process.stderr.write(".");
}
process.stderr.write("\n");
const report = {
  disclaimer: "Measured on a synthetic, programmatically generated dataset. Not a claim about accuracy on real-world drawings.",
  vector_sets: names.length,
  seconds: Math.round((performance.now() - t0) / 100) / 10,
  vector: total.toDict(),
  raster: null,
  per_set: perSet,
};
const md = markdownReport(report);
console.log(md);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(outDir, "REPORT.md"), md);
}
