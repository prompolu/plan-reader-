"""Pipeline robustness on randomised drawing styles (imperial, rotated pages,
arrow/dot terminators, continuous chains, size-column schedules, ...)."""

import pytest

from planmeasure.benchmark.run import evaluate
from planmeasure.demo.sets import build_set, random_building
from planmeasure.pipeline.runner import run_on_bytes


@pytest.mark.parametrize("seed", [1, 4, 12, 17, 19, 23])
def test_random_sets(seed):
    b, opts = random_building(seed)
    pdf, gt = build_set(b, opts)
    res = run_on_bytes([(f"s{seed}.pdf", pdf)])
    m = evaluate(gt, res.records)
    assert m.fabricated == 0, m.errors
    assert m.det_fn == 0 and m.det_fp == 0, m.errors
    assert m.width.rate == 1.0 and m.height.rate == 1.0, m.errors


def test_rotated_imperial_page():
    # find a seed that produces a rotated imperial plan
    for seed in range(1, 200):
        b, opts = random_building(seed)
        if opts.rotate_plan_pages and b.style.units == "imperial":
            break
    else:
        pytest.skip("no rotated imperial seed")
    pdf, gt = build_set(b, opts)
    res = run_on_bytes([("rot.pdf", pdf)])
    plan = next(p for p in res.pages if p.cls.page_type == "floor_plan")
    assert plan.page.rotation == 90
    m = evaluate(gt, res.records)
    assert m.det_fn == 0 and m.fabricated == 0, m.errors
    assert any(d.unit == "ft_in" for d in plan.dims)
