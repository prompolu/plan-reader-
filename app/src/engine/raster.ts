/** Raster (scan) processing: line removal, geometry, symbol tags, quality. Filled in below. */
import type { BBox, PageGeometry, PageQuality, TextLine } from "./types";
import type { GrayImage, OCRProvider } from "./platform";

export async function removeLongLines(gray: GrayImage, _minLen: number): Promise<GrayImage> {
  return gray;
}
export async function readSymbolTags(_gray: GrayImage, _upp: number, _prefix: string, _textPx: number, _ocr: OCRProvider): Promise<[TextLine[], BBox[]]> {
  return [[], []];
}
export async function extractRasterGeometry(_gray: GrayImage, _upp: number, _mask: BBox[]): Promise<PageGeometry> {
  throw new Error("raster geometry not implemented yet");
}
export async function assessRaster(_gray: GrayImage, _lines: TextLine[], _pxPerUnit: number, _dpi: number | null, kind: PageQuality["kind"]): Promise<PageQuality> {
  return { kind, effective_dpi: null, blur_score: null, contrast: null, mean_ocr_confidence: null, poor: false, reasons: [] };
}
