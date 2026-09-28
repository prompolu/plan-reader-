"""End-to-end pipeline tests on the generated demo drawing set.

The demo set is built with known ground truth and deliberately contains a
schedule conflict, a quantity mismatch, a scale-only measurement, missing
heights, a schedule-only entry, a duplicated tag and an enlarged plan that
repeats openings from the main plan.
"""

import pytest

from planmeasure.benchmark.run import evaluate
from planmeasure.demo.sets import demo_set
from planmeasure.pipeline.runner import run_on_bytes


@pytest.fixture(scope="module")
def demo():
    pdf, gt = demo_set()
    res = run_on_bytes([("Residential_Plans.pdf", pdf)])
    by_tag = {r["tag"]: r for r in res.records}
    return pdf, gt, res, by_tag


def test_page_classification(demo):
    _, gt, res, _ = demo
    for page, truth in zip(res.pages, gt.pages):
        expected = truth["page_type"]
        assert page.cls.page_type == expected, page.cls.signals
        assert page.cls.sheet_number == truth["sheet_number"]


def test_scales_detected_and_verified(demo):
    _, _, res, _ = demo
    plan = res.pages[3]
    view = next(v for v in plan.views if v.view_type == "floor_plan")
    assert view.scale.ratio == 100
    assert any("Verified against" in n for n in view.scale.notes)
    enlarged = next(v for v in res.pages[8].views if v.view_type == "detail")
    assert enlarged.scale.ratio == 50 and enlarged.enlarged


def test_matches_ground_truth(demo):
    _, gt, res, _ = demo
    m = evaluate(gt, res.records)
    assert m.det_fn == 0 and m.det_fp == 0, m.errors
    assert m.fabricated == 0
    assert m.width.rate == 1.0 and m.height.rate == 1.0, m.errors
    assert m.quantity.rate == 1.0, m.errors
    assert m.flags.rate == 1.0, m.errors


def test_explicit_measurements_keep_original_text_and_evidence(demo):
    *_, by_tag = demo
    w = by_tag["W-02"]["width"]
    assert w["value"] == 1800 and w["original_text"] == "1800"
    assert w["source"] == "explicit_dimension" and w["status"] == "explicit"
    codes = {e["code"] for e in w["evidence"]}
    assert {"dim_line_edges", "extension_lines", "orientation"} <= codes
    assert w["bbox"] and w["line"]  # traceable to the drawing


def test_schedule_conflict_is_reported_not_resolved(demo):
    *_, by_tag = demo
    r = by_tag["W-03"]
    assert r["height"]["status"] == "conflict"
    assert r["height"]["value"] is None
    values = sorted({c["value"] for c in r["height"]["candidates"]})
    assert values == [1200, 1500]
    assert any(f["code"] == "schedule_conflict" for f in r["flags"])
    assert r["status"] == "needs_review"


def test_missing_height_is_never_guessed(demo):
    *_, by_tag = demo
    assert by_tag["W-07"]["height"] is None
    assert any(f["code"] == "missing_height" for f in by_tag["W-07"]["flags"])
    # D-04: no width dimension, not scheduled -> width inferred from scale and marked as such
    d4 = by_tag["D-04"]
    assert d4["width"]["source"] == "drawing_scale" and d4["width"]["status"] == "inferred"
    assert d4["width"]["confidence"] < 0.6
    assert d4["height"] is None


def test_same_opening_on_several_sheets_is_counted_once(demo):
    *_, by_tag = demo
    w2 = by_tag["W-02"]
    assert w2["quantity"] == 3  # plan instances only
    assert len(w2["references"]) >= 3  # elevations reference the same windows
    assert all(not ref["counted"] for ref in w2["references"])
    w4 = by_tag["W-04"]
    assert w4["quantity"] == 2
    assert any(ref["view_type"] == "detail" for ref in w4["references"])  # enlarged plan


def test_quantity_conflict_with_schedule(demo):
    *_, by_tag = demo
    f = next(f for f in by_tag["W-01"]["flags"] if f["code"] == "quantity_conflict")
    assert f["schedule_quantity"] == 6 and f["located"] == 5


def test_schedule_only_entries_are_not_counted(demo):
    *_, by_tag = demo
    w6 = by_tag["W-06"]
    assert w6["quantity"] == 0 and w6["quantity_basis"] == "schedule_only"
    assert any(f["code"] == "schedule_only" for f in w6["flags"])


def test_duplicate_tag_flagged_but_counted_once(demo):
    *_, by_tag = demo
    w5 = by_tag["W-05"]
    assert w5["quantity"] == 2
    assert any(f["code"] == "possible_duplicate" for f in w5["flags"])


def test_confidence_components(demo):
    *_, by_tag = demo
    c = by_tag["D-01"]["confidence"]
    for k in ("detection", "tag", "width", "height", "association", "overall"):
        assert c[k] is not None and 0 <= c[k] <= 1
    assert by_tag["W-07"]["confidence"]["overall"] < 0.5  # missing height caps the overall score
