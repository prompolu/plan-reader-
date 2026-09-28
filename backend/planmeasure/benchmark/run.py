"""Accuracy benchmark for the extraction pipeline.

Generates drawing sets with known ground truth (the demo set plus randomised
variations: metric/imperial, 1:50/1:100/1/4", ticks/arrows/dots, continuous
chains, rotated pages, size-column schedules, schedule conflicts, duplicate
tags) and optional rasterised copies, runs the pipeline and measures:

* opening detection (precision / recall on floor-plan instances)
* tag detection
* width / height extraction (value AND status: explicit / inferred / missing / conflict)
* fabricated measurements (explicit value reported where the drawing has none) - must be 0
* dimension association (which dimension text was linked to each instance)
* quantity / duplicate handling
* expected review flags

Usage::

    python -m planmeasure.benchmark.run --sets 20 --raster 3 --out benchmark_results

The numbers describe THIS synthetic dataset only. They are not a claim about
accuracy on arbitrary real-world drawings; add real drawings with hand-made
ground truth under ``benchmark/datasets`` to measure that.
"""

from __future__ import annotations

import argparse
import io
import json
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pymupdf

from planmeasure.demo.sets import GroundTruth, build_set, demo_building, SetOptions, random_building
from planmeasure.pipeline.ocr import get_ocr_provider
from planmeasure.pipeline.runner import run_on_bytes
from planmeasure.pipeline.tags import parse_tag
from planmeasure.pipeline.types import BBox
from planmeasure.pipeline.units import approx_equal_mm


@dataclass
class Counter:
    correct: int = 0
    total: int = 0

    def add(self, ok: bool) -> None:
        self.total += 1
        self.correct += int(ok)

    @property
    def rate(self) -> float | None:
        return self.correct / self.total if self.total else None

    def to_dict(self) -> dict[str, Any]:
        return {"correct": self.correct, "total": self.total, "rate": round(self.rate, 4) if self.rate is not None else None}


@dataclass
class Metrics:
    det_tp: int = 0
    det_fn: int = 0
    det_fp: int = 0
    tag: Counter = field(default_factory=Counter)
    width: Counter = field(default_factory=Counter)
    height: Counter = field(default_factory=Counter)
    association: Counter = field(default_factory=Counter)
    quantity: Counter = field(default_factory=Counter)
    type_kind: Counter = field(default_factory=Counter)
    flags: Counter = field(default_factory=Counter)
    duplicates: Counter = field(default_factory=Counter)
    fabricated: int = 0
    errors: list[str] = field(default_factory=list)

    def merge(self, o: "Metrics") -> None:
        self.det_tp += o.det_tp
        self.det_fn += o.det_fn
        self.det_fp += o.det_fp
        for k in ("tag", "width", "height", "association", "quantity", "type_kind", "flags", "duplicates"):
            a, b = getattr(self, k), getattr(o, k)
            a.correct += b.correct
            a.total += b.total
        self.fabricated += o.fabricated
        self.errors += o.errors

    def to_dict(self) -> dict[str, Any]:
        p = self.det_tp / (self.det_tp + self.det_fp) if self.det_tp + self.det_fp else None
        r = self.det_tp / (self.det_tp + self.det_fn) if self.det_tp + self.det_fn else None
        return {
            "opening_detection": {
                "true_positives": self.det_tp,
                "false_negatives": self.det_fn,
                "false_positives": self.det_fp,
                "precision": round(p, 4) if p is not None else None,
                "recall": round(r, 4) if r is not None else None,
            },
            "tag_detection": self.tag.to_dict(),
            "width_extraction": self.width.to_dict(),
            "height_extraction": self.height.to_dict(),
            "dimension_association": self.association.to_dict(),
            "quantity_and_duplicates": self.quantity.to_dict(),
            "duplicate_flagging": self.duplicates.to_dict(),
            "opening_type": self.type_kind.to_dict(),
            "expected_review_flags": self.flags.to_dict(),
            "fabricated_measurements": self.fabricated,
            "errors": self.errors[:50],
        }


def _key(tag: str | None) -> str | None:
    if not tag:
        return None
    p = parse_tag(tag)
    return p[1] if p else tag


def _match_measure(truth_status: str, truth_value, m: dict | None) -> tuple[bool, bool]:
    """Returns (correct, fabricated)."""
    if truth_status == "missing":
        ok = m is None
        return ok, bool(m and m["status"] == "explicit")
    if truth_status == "conflict":
        return bool(m and m["status"] == "conflict"), False
    if truth_status == "inferred":
        ok = bool(m and m["status"] == "inferred" and m["value"] is not None and abs(m["value"] - truth_value) <= max(15.0, 0.03 * truth_value))
        return ok, bool(m and m["status"] == "explicit")
    ok = bool(m and m["status"] == "explicit" and m["value"] is not None and approx_equal_mm(m["value"], truth_value))
    return ok, False


def evaluate(gt: GroundTruth | dict, records: list[dict[str, Any]], raster: bool = False) -> Metrics:
    g = gt if isinstance(gt, dict) else json.loads(gt.to_json())
    m = Metrics()
    # ---- instance detection on floor plans ----
    sys_inst = []
    for r in records:
        for inst in r["instances"]:
            sys_inst.append((r, inst))
    used = set()
    for gi in g["instances"]:
        if not gi["counted"]:
            continue
        gb = BBox.from_points(*gi["gap_bbox"])
        best = None
        for k, (r, inst) in enumerate(sys_inst):
            if k in used or inst["page_index"] != gi["page_index"]:
                continue
            b = BBox.from_dict(inst["bbox"])
            ov = b.intersection_area(gb.expand(1.0))
            if ov <= 0 and not b.expand(2).contains_point(gb.cx, gb.cy):
                continue
            score = ov / max(gb.area, 1e-6)
            if best is None or score > best[0]:
                best = (score, k)
        if best is None:
            m.det_fn += 1
            m.errors.append(f"missed {gi['tag']} ({gi['kind']}) on page {gi['page_index'] + 1}")
            continue
        used.add(best[1])
        m.det_tp += 1
        r, inst = sys_inst[best[1]]
        m.tag.add(_key(inst.get("tag_text")) == _key(gi["tag"]))
        if _key(inst.get("tag_text")) != _key(gi["tag"]):
            m.errors.append(f"tag {inst.get('tag_text')} != {gi['tag']} on page {gi['page_index'] + 1}")
        ok_assoc = (inst.get("width_text") or None) == (gi["width_dim_text"] or None)
        if not ok_assoc and inst.get("width_text") and gi["width_dim_text"]:
            ok_assoc = approx_equal_mm(_num(inst["width_text"]), _num(gi["width_dim_text"]))
        m.association.add(ok_assoc)
        if not ok_assoc:
            m.errors.append(f"association {gi['tag']} p{gi['page_index'] + 1}: got {inst.get('width_text')} expected {gi['width_dim_text']}")
    m.det_fp += sum(1 for k, (r, inst) in enumerate(sys_inst) if k not in used and not inst.get("geometry_missing"))
    for k, (r, inst) in enumerate(sys_inst):
        if k not in used and not inst.get("geometry_missing"):
            m.errors.append(f"false positive {r['type']} {inst.get('tag_text')} on page {inst['page_index'] + 1}")

    # ---- type-level ----
    by_key = {}
    for r in records:
        if r["tag_key"]:
            by_key[r["tag_key"]] = r
    for t in g["types"]:
        if not t["tag"]:
            continue
        if t["quantity"] == 0 and not t["in_schedule"]:
            continue
        r = by_key.get(_key(t["tag"]))
        if r is None:
            m.errors.append(f"type {t['tag']} not reported")
            for c in (m.width, m.height, m.quantity, m.type_kind):
                c.add(False)
            continue
        ok_w, fab_w = _match_measure(t["width_status"], t["width_expected"], r["width"])
        ok_h, fab_h = _match_measure(t["height_status"], t["height_expected"], r["height"])
        m.width.add(ok_w)
        m.height.add(ok_h)
        m.fabricated += int(fab_w) + int(fab_h)
        if not ok_w:
            m.errors.append(f"{t['tag']} width: expected {t['width_status']} {t['width_expected']}, got {_fmt(r['width'])}")
        if not ok_h:
            m.errors.append(f"{t['tag']} height: expected {t['height_status']} {t['height_expected']}, got {_fmt(r['height'])}")
        m.quantity.add(r["quantity"] == t["quantity"])
        if r["quantity"] != t["quantity"]:
            m.errors.append(f"{t['tag']} quantity {r['quantity']} expected {t['quantity']}")
        m.type_kind.add(r["type"] == t["kind"])
        if r["type"] != t["kind"]:
            m.errors.append(f"{t['tag']} type {r['type']} expected {t['kind']}")
        got = {f["code"] for f in r["flags"]}
        for ef in t["expected_flags"]:
            equiv = {"dimension_conflict": {"dimension_conflict", "schedule_conflict"}}.get(ef, {ef})
            ok = bool(got & equiv)
            if ef == "possible_duplicate":
                m.duplicates.add(ok)
            m.flags.add(ok)
            if not ok:
                m.errors.append(f"{t['tag']} missing flag {ef}")
    return m


def _num(t: str) -> float:
    from planmeasure.pipeline.units import parse_dimension

    p = parse_dimension(t)
    return p.value_mm if p else -1.0


def _fmt(meas: dict | None) -> str:
    if meas is None:
        return "missing"
    return f"{meas['status']} {meas['value']}"


def rasterize(pdf: bytes, gt: GroundTruth, dpi: int = 200) -> list[tuple[str, bytes, int]]:
    """Render the floor-plan pages to PNG images (for the OCR / raster path)."""
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    out = []
    for p in gt.pages:
        if p["page_type"] != "floor_plan":
            continue
        pix = doc[p["index"]].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        out.append((f"{gt.set_name}_p{p['index']}.png", pix.tobytes("png"), p["index"]))
    doc.close()
    return out


def run_benchmark(n_sets: int, n_raster: int, out_dir: Path | None, seed0: int = 1) -> dict[str, Any]:
    sets: list[tuple[str, bytes, GroundTruth]] = []
    pdf, gt = build_set(demo_building(), SetOptions(name="demo"))
    sets.append(("demo", pdf, gt))
    for s in range(seed0, seed0 + n_sets):
        b, opts = random_building(s)
        pdf, gt = build_set(b, opts)
        sets.append((opts.name, pdf, gt))
    total = Metrics()
    per_set = []
    t0 = time.perf_counter()
    for name, pdf, gt in sets:
        t = time.perf_counter()
        try:
            res = run_on_bytes([(f"{name}.pdf", pdf)])
            met = evaluate(gt, res.records)
        except Exception as exc:  # report, keep going
            met = Metrics(errors=[f"pipeline crashed: {exc!r}"])
        total.merge(met)
        per_set.append({"set": name, "seconds": round(time.perf_counter() - t, 2), **met.to_dict()})
        if out_dir:
            (out_dir / "sets").mkdir(parents=True, exist_ok=True)
            (out_dir / "sets" / f"{name}.pdf").write_bytes(pdf)
            (out_dir / "sets" / f"{name}.truth.json").write_text(gt.to_json())

    raster_total = Metrics()
    raster_sets = []
    ocr = get_ocr_provider("tesseract")
    if n_raster and ocr.available():
        for name, pdf, gt in sets[:n_raster]:
            for fname, png, page_index in rasterize(pdf, gt):
                # evaluate the single image against the truth for that page (re-indexed to page 0)
                g = json.loads(gt.to_json())
                scale = 200 / 72.0
                g["instances"] = [
                    {**i, "page_index": 0, "gap_bbox": [v * scale for v in i["gap_bbox"]]} for i in g["instances"] if i["page_index"] == page_index
                ]
                # type-level truth needs the whole set; for a single plan image only instance metrics apply
                g["types"] = []
                t = time.perf_counter()
                try:
                    res = run_on_bytes([(fname, png)], ocr=ocr)
                    met = evaluate(g, res.records, raster=True)
                except Exception as exc:
                    met = Metrics(errors=[f"pipeline crashed: {exc!r}"])
                raster_total.merge(met)
                raster_sets.append({"image": fname, "seconds": round(time.perf_counter() - t, 2), **met.to_dict()})

    report = {
        "disclaimer": "Measured on a synthetic, programmatically generated dataset. Not a claim about accuracy on real-world drawings.",
        "vector_sets": len(sets),
        "seconds": round(time.perf_counter() - t0, 1),
        "vector": total.to_dict(),
        "raster": raster_total.to_dict() if raster_sets else None,
        "per_set": per_set,
        "raster_images": raster_sets,
    }
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(json.dumps(report, indent=2))
        (out_dir / "REPORT.md").write_text(markdown_report(report))
    return report


def markdown_report(rep: dict[str, Any]) -> str:
    def row(label: str, d: dict | None) -> str:
        if not d:
            return f"| {label} | – | – |\n"
        rate = d.get("rate")
        return f"| {label} | {d['correct']}/{d['total']} | {rate * 100:.1f}% |\n" if rate is not None else f"| {label} | 0/0 | – |\n"

    out = "# PlanMeasure AI – extraction benchmark\n\n"
    out += f"> {rep['disclaimer']}\n\n"
    for kind in ("vector", "raster"):
        m = rep.get(kind)
        if not m:
            continue
        od = m["opening_detection"]
        out += f"## {'Vector PDF sets' if kind == 'vector' else 'Rasterised floor plans (OCR path)'}\n\n"
        out += "| Metric | Correct / total | Rate |\n|---|---|---|\n"
        p = od["precision"]
        r = od["recall"]
        out += f"| Opening detection – recall | {od['true_positives']}/{od['true_positives'] + od['false_negatives']} | {r * 100:.1f}% |\n" if r is not None else ""
        out += f"| Opening detection – precision | {od['true_positives']}/{od['true_positives'] + od['false_positives']} | {p * 100:.1f}% |\n" if p is not None else ""
        out += row("Tag detection", m["tag_detection"])
        out += row("Width extraction (value + status)", m["width_extraction"])
        out += row("Height extraction (value + status)", m["height_extraction"])
        out += row("Dimension association", m["dimension_association"])
        out += row("Quantity (duplicate-safe counting)", m["quantity_and_duplicates"])
        out += row("Duplicate flagging", m["duplicate_flagging"])
        out += row("Opening type", m["opening_type"])
        out += row("Expected review flags raised", m["expected_review_flags"])
        out += f"| Fabricated measurements | {m['fabricated_measurements']} | must be 0 |\n\n"
        if m["errors"]:
            out += "<details><summary>First errors</summary>\n\n" + "\n".join(f"- {e}" for e in m["errors"][:30]) + "\n\n</details>\n\n"
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sets", type=int, default=20)
    ap.add_argument("--raster", type=int, default=3, help="number of sets whose plans are also tested as raster images")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    rep = run_benchmark(args.sets, args.raster, args.out, args.seed)
    print(markdown_report(rep))


if __name__ == "__main__":
    main()
