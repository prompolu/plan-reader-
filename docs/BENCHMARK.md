# Extraction benchmark

**Read this first:** every number below was measured on a *synthetic* dataset
that PlanMeasure AI's drawing generator produced: 31 randomised residential
drawing sets (metric and imperial, 1:50 / 1:100 / 1/4" scales, tick / arrow /
dot dimension terminators, dimension chains, rotated pages, door/window
schedules with deliberate conflicts and duplicate tags) plus 6 rasterised
floor plans (200 dpi) to exercise the scanned-drawing (OCR) path. The drawings
and their ground truth are in `app/benchmark/`.

Because the generator and the detector were built together, the vector-PDF
figures are an upper bound. **They are not a claim about accuracy on real-world
drawings**, which vary far more in drafting conventions, line weights, fonts and
scan quality. To measure that, add real drawings with hand-checked ground truth
(`<name>.pdf` + `<name>.truth.json` in `app/benchmark/sets/`, or `.png` in
`app/benchmark/raster/`) and re-run.

What the numbers do show:

* **No fabricated measurements (0 in both paths).** When a value is not
  dimensioned it is reported as *Needs review* or *Inferred from drawing scale*,
  never as an explicit dimension.
* **Vector PDFs** (CAD exports) are handled well on this dataset.
* **Scanned / raster drawings are much weaker**: about two in five openings are
  found and about half of those get their dimension. What is found is mostly
  correct (90 % precision) and the rest is left for the reviewer - expect
  substantial manual work on scans.

These numbers come from the on-device engine (TypeScript, the code the app
runs). It is a port of the original Python pipeline and gives identical results
on the vector sets. On scans it uses tesseract.js 5 (the WebAssembly build of
Tesseract) instead of native Tesseract, so OCR output differs slightly: the
Python pipeline found 31/91 openings at 96.9 % precision on the same images.

Reproduce:

```bash
cd app
npm run benchmark          # vector sets, a few seconds
npm run benchmark:scans    # scanned floor plans, about two minutes
```

---

## Vector PDF sets

| Metric | Correct / total | Rate |
|---|---|---|
| Opening detection – recall | 515/516 | 99.8% |
| Opening detection – precision | 515/515 | 100.0% |
| Tag detection | 515/515 | 100.0% |
| Width extraction (value + status) | 237/237 | 100.0% |
| Height extraction (value + status) | 237/237 | 100.0% |
| Dimension association | 515/515 | 100.0% |
| Quantity (duplicate-safe counting) | 237/237 | 100.0% |
| Duplicate flagging | 20/20 | 100.0% |
| Opening type | 237/237 | 100.0% |
| Expected review flags raised | 84/84 | 100.0% |
| Fabricated measurements | 0 | must be 0 |

<details><summary>Errors</summary>

- missed SD-01 (sliding_door) on page 2

</details>

## Scanned floor plans (OCR path)

| Metric | Correct / total | Rate |
|---|---|---|
| Opening detection – recall | 38/91 | 41.8% |
| Opening detection – precision | 38/42 | 90.5% |
| Tag detection | 24/38 | 63.2% |
| Dimension association | 18/38 | 47.4% |
| Fabricated measurements | 0 | must be 0 |

Width / height / quantity checks are not scored on single scanned sheets (the
ground truth for those comes from schedules and elevations, which these images
do not include).

<details><summary>First errors</summary>

- association W02 p1: got none, expected 600
- tag none instead of W03 on page 1
- missed D02 (door) on page 1
- missed W01 (sliding_window) on page 1
- missed W03 (window) on page 1
- missed D03 (double_door) on page 1
- missed D01 (door) on page 1
- association D02 p1: got none, expected 920
- tag none instead of W-4 on page 1
- association W-4 p1: got none, expected 2'-0"
- missed D-1 (door) on page 1
- missed W-2 (sliding_window) on page 1
- missed W-4 (window) on page 1
- missed W-1 (window) on page 1
- missed W-5 (window) on page 1
- missed W-3 (window) on page 1

</details>

Speed on a laptop-class CPU: a 10-page vector drawing set is extracted in about
6 seconds in the browser; a scanned sheet takes 10–25 seconds (mostly OCR).
