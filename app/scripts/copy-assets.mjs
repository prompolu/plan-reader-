/**
 * Copy the files the app loads at run time into public/ so it works offline:
 * the OCR worker, engine and English model, the PDF.js fonts and character
 * maps, and the demo drawing set. Runs before `dev` and `build`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const pub = path.join(root, "public");
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

function copy(from, to) {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

for (const d of ["tesseract", "pdfjs"]) rmSync(path.join(pub, d), { recursive: true, force: true });

// OCR (scanned drawings): worker script, LSTM engine builds (SIMD and plain), English model
copy(path.join(pkgDir("tesseract.js"), "dist", "worker.min.js"), path.join(pub, "tesseract", "worker.min.js"));
const core = pkgDir("tesseract.js-core");
for (const f of readdirSync(core).filter((f) => /^tesseract-core(-simd)?-lstm\.wasm\.js$/.test(f))) {
  copy(path.join(core, f), path.join(pub, "tesseract", "core", f));
}
copy(path.join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"), path.join(pub, "tesseract", "lang", "eng.traineddata.gz"));

// PDF.js: standard fonts and CJK character maps
const pdfjs = pkgDir("pdfjs-dist");
copy(path.join(pdfjs, "standard_fonts"), path.join(pub, "pdfjs", "standard_fonts"));
copy(path.join(pdfjs, "cmaps"), path.join(pub, "pdfjs", "cmaps"));

// demo drawing set
copy(path.join(root, "e2e", "fixtures", "residential_plans.pdf"), path.join(pub, "demo", "Residential_Plans.pdf"));

console.log("assets copied to public/");
