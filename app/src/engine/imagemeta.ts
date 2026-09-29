/** Scan resolution stated in PNG (pHYs) / JPEG (JFIF) headers. */
export function imageDpi(bytes: Uint8Array): number | null {
  // pHYs chunk: pixels per metre
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (!sig.every((b, i) => bytes[i] === b)) return jpegDpi(bytes);
  let p = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (p + 8 < bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8));
    if (type === "pHYs") {
      const ppmX = dv.getUint32(p + 8);
      const unit = bytes[p + 16];
      return unit === 1 && ppmX > 0 ? ppmX * 0.0254 : null;
    }
    if (type === "IDAT") break;
    p += 12 + len;
  }
  return null;
}

function jpegDpi(bytes: Uint8Array): number | null {
  // JFIF APP0: units (1 = dpi, 2 = dpcm), Xdensity
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.slice(6, 10)) === "JFIF") {
    const units = bytes[13];
    const xd = (bytes[14] << 8) | bytes[15];
    if (units === 1) return xd;
    if (units === 2) return xd * 2.54;
  }
  return null;
}

