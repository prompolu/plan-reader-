/** Raster drawings (PNG / JPG scans and photos). */
import { emptyGeometry, newQuality, type BBox, type PageData } from "./types";
import { platform, type RgbaImage } from "./platform";

export class ImageDocument {
  readonly kind = "image";
  readonly pageCount = 1;

  private constructor(
    private img: RgbaImage,
    readonly filename: string,
    /** scan resolution from the file, when stated and plausible */
    readonly dpi: number | null,
  ) {}

  static async open(data: Uint8Array, filename = "image.png"): Promise<ImageDocument> {
    const img = await platform().decodeImage(data);
    const dpi = img.dpi && img.dpi > 30 ? img.dpi : null;
    return new ImageDocument({ width: img.width, height: img.height, data: img.data }, filename, dpi);
  }

  async pageSize(): Promise<[number, number, "px"]> {
    return [this.img.width, this.img.height, "px"];
  }

  async extract(_i: number, index = 0, documentIndex = 0): Promise<PageData> {
    return {
      index,
      documentIndex,
      pageInDocument: 0,
      width: this.img.width,
      height: this.img.height,
      unit: "px",
      mmPerUnit: this.dpi ? 25.4 / this.dpi : null,
      rotation: 0,
      lines: [],
      geometry: emptyGeometry(),
      quality: newQuality("raster", this.dpi),
      hasTextLayer: false,
      label: this.filename,
    };
  }

  /** Render at `scale` (output px per image px), optionally clipped to a box in image pixels. */
  async render(_i: number, scale: number, clip?: BBox | null): Promise<RgbaImage> {
    const src = this.img;
    let x0 = 0;
    let y0 = 0;
    let x1 = src.width;
    let y1 = src.height;
    if (clip) {
      x0 = Math.max(Math.trunc(clip.x0), 0);
      y0 = Math.max(Math.trunc(clip.y0), 0);
      x1 = Math.min(Math.ceil(clip.x1), src.width);
      y1 = Math.min(Math.ceil(clip.y1), src.height);
      if (x1 <= x0 || y1 <= y0) return { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
    }
    const cw = x1 - x0;
    const ch = y1 - y0;
    const w = Math.max(1, Math.round(cw * scale));
    const h = Math.max(1, Math.round(ch * scale));
    const { createCanvas } = platform();
    const srcCanvas = createCanvas(src.width, src.height);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sctx = srcCanvas.getContext("2d") as any;
    const id = sctx.createImageData(src.width, src.height);
    id.data.set(src.data);
    sctx.putImageData(id, 0, 0);
    const out = createCanvas(w, h);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octx = out.getContext("2d") as any;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(srcCanvas, x0, y0, cw, ch, 0, 0, w, h);
    const d = octx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: d.data };
  }

  async close(): Promise<void> {
    this.img = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  }
}
