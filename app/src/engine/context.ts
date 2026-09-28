import type { PageData, View } from "./types";

/** Per-page scale helpers shared by detectors. */
export class DetectionContext {
  readonly scaleKnown: boolean;
  readonly mmPerUnit: number;
  readonly ratio: number;
  /** page units per real-world millimetre */
  readonly upm: number;
  /** raster geometry jitters by a few pixels */
  readonly raster: boolean;
  /** geometric tolerance floor */
  readonly minTol: number;

  constructor(
    readonly page: PageData,
    readonly view: View | null,
  ) {
    const ratio = view && view.scale.ratio ? view.scale.ratio : null;
    this.scaleKnown = ratio !== null && page.mmPerUnit !== null;
    let mpu = page.mmPerUnit;
    if (mpu === null) {
      // raster page with no DPI: estimate paper size from text height (~2.5 mm)
      const sizes = page.lines.map((ln) => ln.size).filter((s) => s > 0).sort((a, b) => a - b);
      const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
      mpu = 2.5 / med;
    }
    this.mmPerUnit = mpu;
    this.ratio = ratio ? ratio : 100;
    this.upm = 1 / (this.ratio * this.mmPerUnit);
    this.raster = page.quality.kind === "raster" || page.unit === "px";
    this.minTol = page.unit === "px" ? 3 : this.raster ? 1.2 : 0;
  }

  /** Page units -> real millimetres (using the view scale or an assumed 1:100). */
  real(units: number): number {
    return units * this.mmPerUnit * this.ratio;
  }

  units(realMm: number): number {
    return realMm * this.upm;
  }
}
