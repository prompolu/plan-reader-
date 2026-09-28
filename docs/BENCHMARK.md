# Extraction benchmark

**Read this first:** every number below was measured on a *synthetic* dataset
that PlanMeasure AI generates itself (`planmeasure/demo/sets.py`): 30 randomised
residential drawing sets (metric and imperial, 1:50 / 1:100 / 1/4" scales, tick /
arrow / dot dimension terminators, dimension chains, rotated pages, door/window
schedules with deliberate conflicts and duplicate tags) plus rasterised copies of
5 of them to exercise the scanned-drawing (OCR) path.

Because the generator and the detector were built together, the vector-PDF
figures are an upper bound. **They are not a claim about accuracy on real-world
drawings**, which vary far more in drafting conventions, line weights, fonts and
scan quality. To measure that, add real drawings with hand-checked ground truth
(see `backend/planmeasure/benchmark/run.py`) and re-run.

What the numbers do show:

* **No fabricated measurements (0 in both paths).** When a value is not
  dimensioned it is reported as *Needs review* or *Inferred from drawing scale*,
  never as an explicit dimension.
* **Vector PDFs** (CAD exports) are handled well on this dataset.
* **Scanned / raster drawings are much weaker**: about a third of the openings
  are found and most dimensions are not associated. Everything that is found is
  mostly correct (high precision), and the rest is left for the reviewer - but
  expect substantial manual work on scans.

Reproduce (about one minute):

```bash
cd backend
python -m planmeasure.benchmark.run --sets 30 --raster 5 --seed 7 --out benchmark_results
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

<details><summary>First errors</summary>

- missed SD-01 (sliding_door) on page 2

</details>

## Rasterised floor plans (OCR path)

| Metric | Correct / total | Rate |
|---|---|---|
| Opening detection – recall | 31/91 | 34.1% |
| Opening detection – precision | 31/32 | 96.9% |
| Tag detection | 23/31 | 74.2% |
| Width extraction (value + status) | 0/0 | – |
| Height extraction (value + status) | 0/0 | – |
| Dimension association | 10/31 | 32.3% |
| Quantity (duplicate-safe counting) | 0/0 | – |
| Duplicate flagging | 0/0 | – |
| Opening type | 0/0 | – |
| Expected review flags raised | 0/0 | – |
| Fabricated measurements | 0 | must be 0 |

<details><summary>First errors</summary>

- association D-01 p1: got None expected 1020
- missed W-01 (window) on page 1
- missed W-01 (window) on page 1
- missed W-02 (window) on page 1
- missed GD-01 (garage_door) on page 1
- missed SD-01 (sliding_door) on page 1
- missed W-02 (window) on page 1
- missed W-01 (window) on page 1
- missed W-03 (window) on page 1
- association D-03 p1: got None expected 1600
- missed W-04 (window) on page 1
- association D-02 p1: got None expected 820
- missed None (opening) on page 1
- missed W-07 (window) on page 1
- missed D-04 (door) on page 1
- missed W-05 (sliding_window) on page 1
- missed W-05 (sliding_window) on page 1
- missed W-01 (window) on page 1
- missed W-01 (window) on page 1
- missed W-02 (window) on page 1
- missed W-04 (window) on page 1
- missed W-03 (window) on page 1
- association D-02 p1: got None expected 820
- association D-02 p1: got None expected 820
- association D-02 p1: got None expected 820
- missed W02 (window) on page 1
- missed W03 (window) on page 1
- association D02 p1: got None expected 920
- missed W01 (sliding_window) on page 1
- association D02 p1: got None expected 920

</details>

