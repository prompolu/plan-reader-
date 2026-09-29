"""Generate the demo drawing set and the benchmark drawings with their ground truth.

    pip install -r requirements.txt
    python generate.py --out ../../app/benchmark              # 30 sets (seed 7) + 6 scans
    python generate.py --demo ../../app/e2e/fixtures/residential_plans.pdf

Sets are written as <name>.pdf + <name>.truth.json under <out>/sets, and the
floor plans of the first sets as 200 dpi grey-scale scans under <out>/raster
(ground truth re-indexed to the single image). The app's benchmark scripts read
these folders.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pymupdf

from drawgen.sets import GroundTruth, SetOptions, build_set, demo_building, demo_set, random_building

DPI = 200


def rasterize(pdf: bytes, gt: GroundTruth, dpi: int = DPI) -> list[tuple[str, bytes, int]]:
    """Render the floor-plan pages to PNG images (for the OCR / scan path)."""
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    out = []
    for p in gt.pages:
        if p["page_type"] != "floor_plan":
            continue
        pix = doc[p["index"]].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        out.append((f"{gt.set_name}_p{p['index']}", pix.tobytes("png"), p["index"]))
    doc.close()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, help="benchmark folder (writes sets/ and raster/)")
    ap.add_argument("--sets", type=int, default=30, help="number of randomised sets (plus the demo set)")
    ap.add_argument("--seed", type=int, default=7, help="seed of the first randomised set")
    ap.add_argument("--raster", type=int, default=5, help="number of sets whose floor plans are also written as scans")
    ap.add_argument("--demo", type=Path, help="write the demo drawing set PDF here")
    args = ap.parse_args()
    if not args.out and not args.demo:
        ap.error("nothing to do: give --out and/or --demo")

    if args.demo:
        pdf, _ = demo_set()
        args.demo.parent.mkdir(parents=True, exist_ok=True)
        args.demo.write_bytes(pdf)
        print(f"demo set -> {args.demo}")

    if args.out:
        sets = [("demo", *build_set(demo_building(), SetOptions(name="demo")))]
        for s in range(args.seed, args.seed + args.sets):
            b, opts = random_building(s)
            sets.append((opts.name, *build_set(b, opts)))
        (args.out / "sets").mkdir(parents=True, exist_ok=True)
        (args.out / "raster").mkdir(parents=True, exist_ok=True)
        for name, pdf, gt in sets:
            (args.out / "sets" / f"{name}.pdf").write_bytes(pdf)
            (args.out / "sets" / f"{name}.truth.json").write_text(gt.to_json())
        scale = DPI / 72.0
        for name, pdf, gt in sets[: args.raster]:
            for fname, png, page_index in rasterize(pdf, gt):
                g = json.loads(gt.to_json())
                g["instances"] = [{**i, "page_index": 0, "gap_bbox": [v * scale for v in i["gap_bbox"]]} for i in g["instances"] if i["page_index"] == page_index]
                # type-level truth needs the whole set; a single plan image is scored on instances only
                g["types"] = []
                (args.out / "raster" / f"{fname}.png").write_bytes(png)
                (args.out / "raster" / f"{fname}.truth.json").write_text(json.dumps(g))
        print(f"{len(sets)} sets -> {args.out}")


if __name__ == "__main__":
    main()
