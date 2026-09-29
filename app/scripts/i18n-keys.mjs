/**
 * List the interface texts passed to t() / tp() as string literals.
 *   node scripts/i18n-keys.mjs            -> JSON array of keys
 * Used by the i18n test to check that French and Spanish cover every key.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "engine" && name !== "i18n") out.push(...files(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// a JS string literal: "..." (with escapes) or `...` without ${}
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const T_CALL = new RegExp(String.raw`\bt\(\s*` + STR, "g");
const TP_CALL = new RegExp(String.raw`\btp\(\s*[^,]+,\s*` + STR + String.raw`\s*,\s*` + STR, "g");

export function extractKeys() {
  const keys = new Set();
  for (const f of files(root)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(T_CALL)) keys.add(JSON.parse(`"${m[1]}"`));
    for (const m of src.matchAll(TP_CALL)) {
      keys.add(JSON.parse(`"${m[1]}"`));
      keys.add(JSON.parse(`"${m[2]}"`));
    }
  }
  return [...keys].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(extractKeys(), null, 1));
