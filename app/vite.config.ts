import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Content Security Policy for the built app (desktop and web). Everything is
 * loaded from the app itself; nothing is sent anywhere. 'unsafe-eval' is
 * needed by the OpenCV.js runtime (scanned drawings).
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Offline support for the installable web app (iPhone "Add to Home Screen"):
 * a CSP meta tag and a service worker that precaches the app and its engine
 * files, so it opens and works without a connection after the first visit.
 */
function offlineApp(): Plugin {
  let publicDir = "";
  return {
    name: "planmeasure-offline",
    apply: "build",
    configResolved(c) {
      publicDir = c.publicDir;
    },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }];
    },
    generateBundle(_o, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      // character maps and the non-SIMD OCR engine are cached when first used
      const pub = listFiles(publicDir).filter((f) => !f.startsWith("pdfjs/cmaps/") && !/tesseract-core-lstm\.wasm\.js$/.test(f));
      const files = ["./", ...[...built, ...pub].sort()];
      const version = createHash("sha256").update(files.join("\n")).update(String(Date.now())).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `/* generated at build time */\nconst VERSION = ${JSON.stringify("pm-" + version)};\nconst PRECACHE = ${JSON.stringify(files)};\n${SW_BODY}`,
      });
    },
  };
}

const SW_BODY = `
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("pm-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // pages: network first so updates arrive, cached copy offline
    e.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./", { ignoreSearch: true }))));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;

export default defineConfig({
  // relative paths: the same build runs from the desktop app and from any web folder
  base: "./",
  plugins: [react(), offlineApp()],
  server: { port: 5173 },
  worker: { format: "es" },
  build: {
    sourcemap: false,
    target: "es2020",
    chunkSizeWarningLimit: 12000,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // the vendor's activation-code generator (no secret inside: the key stays on its devices)
        generator: fileURLToPath(new URL("./generator.html", import.meta.url)),
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
