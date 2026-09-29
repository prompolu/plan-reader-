/**
 * Minimal binary-image operations (the subset of OpenCV the view
 * segmentation used): line / rectangle / circle drawing, 3x3 dilation and
 * 8-connected component labelling with bounding-box stats.
 */

export class Grid {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h);
  }

  set(x: number, y: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.data[y * this.w + x] = 255;
  }

  /** 8-connected Bresenham line between integer points (cv2.line, thickness 1). */
  line(x0: number, y0: number, x1: number, y1: number): void {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    // bound the walk for lines far outside the grid
    let guard = dx - dy + 2;
    for (;;) {
      this.set(x, y);
      if ((x === x1 && y === y1) || guard-- < 0) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Filled rectangle including both corners (cv2.rectangle, thickness -1). */
  fillRect(x0: number, y0: number, x1: number, y1: number): void {
    const xa = Math.max(0, Math.min(x0, x1));
    const xb = Math.min(this.w - 1, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1));
    const yb = Math.min(this.h - 1, Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) this.data.fill(255, y * this.w + xa, y * this.w + xb + 1);
  }

  /** Circle outline (midpoint algorithm, cv2.circle thickness 1). */
  circle(cx: number, cy: number, r: number): void {
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      for (const [px, py] of [
        [x, y],
        [y, x],
        [-y, x],
        [-x, y],
        [-x, -y],
        [-y, -x],
        [y, -x],
        [x, -y],
      ])
        this.set(cx + px, cy + py);
      y++;
      if (err < 0) err += 2 * y + 1;
      else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  /** 3x3 dilation (pixels outside the grid do not contribute). */
  dilate3(iterations = 1): void {
    const { w, h } = this;
    let src = this.data;
    for (let it = 0; it < iterations; it++) {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !v; yy++) {
            for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
              if (src[yy * w + xx]) {
                v = 255;
                break;
              }
            }
          }
          out[y * w + x] = v;
        }
      }
      src = out;
    }
    this.data.set(src);
  }

  /** 8-connected components; labels follow raster order of each component's first pixel. */
  components(): { x: number; y: number; w: number; h: number; area: number }[] {
    const { w, h, data } = this;
    const labels = new Int32Array(w * h).fill(-1);
    const out: { x: number; y: number; w: number; h: number; area: number }[] = [];
    const stack: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (!data[i] || labels[i] >= 0) continue;
      const lab = out.length;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      let area = 0;
      labels[i] = lab;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % w;
        const py = (p - px) / w;
        area++;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (data[q] && labels[q] < 0) {
              labels[q] = lab;
              stack.push(q);
            }
          }
        }
      }
      out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    }
    return out;
  }
}
