/**
 * Render the app icon (a door and a window under a dimension line) to every
 * size the desktop and web apps need. Run after changing the design:
 *   node scripts/make-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** rounded: app/favicon icon with transparent corners; otherwise full-bleed (iOS, maskable) */
function svg({ rounded, inset = 0 }) {
  const s = 1 - inset * 2;
  const t = (v) => (inset * 512 + v * s).toFixed(1);
  const bg = rounded
    ? `<rect x="16" y="16" width="480" height="480" rx="108" fill="url(#g)"/>`
    : `<rect width="512" height="512" fill="url(#g)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3f36"/><stop offset="1" stop-color="#231e1a"/></linearGradient></defs>
  ${bg}
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${t(128)} ${t(150)}H${t(384)}M${t(128)} ${t(126)}V${t(174)}M${t(384)} ${t(126)}V${t(174)}" stroke="#f1de72" stroke-width="${(20 * s).toFixed(1)}"/>
    <path d="M${t(128)} ${t(396)}V${t(214)}H${t(230)}V${t(396)}" stroke="#fffaf2" stroke-width="${(24 * s).toFixed(1)}"/>
    <circle cx="${t(206)}" cy="${t(310)}" r="${(10 * s).toFixed(1)}" fill="#fffaf2" stroke="none"/>
    <rect x="${t(282)}" y="${t(214)}" width="${(102 * s).toFixed(1)}" height="${(112 * s).toFixed(1)}" stroke="#fffaf2" stroke-width="${(24 * s).toFixed(1)}"/>
    <path d="M${t(333)} ${t(214)}V${t(326)}" stroke="#fffaf2" stroke-width="${(14 * s).toFixed(1)}"/>
    <path d="M${t(96)} ${t(396)}H${t(416)}" stroke="#bfe9b5" stroke-width="${(12 * s).toFixed(1)}" opacity=".9"/>
  </g>
</svg>`;
}

async function png(svgText, size, file) {
  const img = await loadImage(Buffer.from(svgText));
  const c = createCanvas(size, size);
  c.getContext("2d").drawImage(img, 0, 0, size, size);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await c.encode("png"));
}

const rounded = svg({ rounded: true });
const square = svg({ rounded: false });
const maskable = svg({ rounded: false, inset: 0.1 });

mkdirSync(path.join(root, "build"), { recursive: true });
writeFileSync(path.join(root, "public", "favicon.svg"), rounded + "\n");
writeFileSync(path.join(root, "build", "icon.svg"), rounded + "\n");
await png(rounded, 1024, path.join(root, "build", "icon.png"));
await png(rounded, 192, path.join(root, "public", "icons", "icon-192.png"));
await png(rounded, 512, path.join(root, "public", "icons", "icon-512.png"));
await png(maskable, 512, path.join(root, "public", "icons", "maskable-512.png"));
await png(square, 180, path.join(root, "public", "icons", "apple-touch-icon.png"));
console.log("icons written");
