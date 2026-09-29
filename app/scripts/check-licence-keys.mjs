/**
 * Checks a built app (dist/) before it is published or packaged:
 *   - the vendor's public key is in it (licensing is on);
 *   - the test-only public key is NOT in it (its private key is in e2e/, so a
 *     build containing it could be activated by anyone).
 *   node scripts/check-licence-keys.mjs [dist]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(app, process.argv[2] ?? "dist");
const src = readFileSync(path.join(app, "src/license/keys.ts"), "utf8");

const testKey = /VITE_PLANMEASURE_TEST === "1" \? \["([0-9a-f]{64})"\]/.exec(src)?.[1];
const vendorBlock = /const VENDOR_KEYS[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
const vendorKeys = [...vendorBlock.matchAll(/"([0-9a-f]{64})"/g)].map((m) => m[1]);
if (!testKey) throw new Error("test key not found in src/license/keys.ts");

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(js|mjs|html)$/.test(n) ? [p] : [];
  });
}
const code = files(dist).map((f) => readFileSync(f, "utf8")).join("\n");

const problems = [];
if (code.includes(testKey)) problems.push("the test-only public key is in this build: build it with `npm run build`, not `build:e2e`");
for (const k of vendorKeys) if (!code.includes(k)) problems.push(`the vendor public key ${k.slice(0, 12)}… is missing`);
if (!vendorKeys.length) console.warn("warning: no vendor key in src/license/keys.ts - licensing is off in this build");

if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
console.log(`licence keys ok (${vendorKeys.length} vendor key${vendorKeys.length === 1 ? "" : "s"}, no test key) in ${path.relative(app, dist) || "."}`);
