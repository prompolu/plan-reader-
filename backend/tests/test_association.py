"""Unit tests for the dimension association engine on hand-built geometry."""

from planmeasure.pipeline.association import associate_dimensions
from planmeasure.pipeline.interfaces import DetectionContext
from planmeasure.pipeline.types import BBox, DimensionAnnotation, OpeningDetection, PageData, ScaleInfo, Segment, View
from planmeasure.pipeline.vision import FakeVisionProvider

PT = 72 / 25.4 / 100  # page points per real mm at 1:100


def _page():
    return PageData(index=0, document_index=0, page_in_document=0, width=1000, height=800, unit="pt", mm_per_unit=25.4 / 72, rotation=0)


def _view():
    return View("v0", BBox(0, 0, 1000, 800), "floor_plan", "PLAN", None, ScaleInfo("1:100", 100.0, "detected", 0.9))


def _opening(a0, a1):
    return OpeningDetection(
        id="o1", page_index=0, view_id="v0", view_type="floor_plan", kind="window",
        bbox=BBox.from_points(a0, 400, a1, 407), axis="h", edges=(a0, a1), cross=(400, 407),
        detector="test", confidence=0.9,
    )


def _dim(id_, text, value, s0, s1, line_y=360, ext=True):
    exts = [Segment(s0, 402, s0, line_y - 4), Segment(s1, 402, s1, line_y - 4)] if ext else []
    return DimensionAnnotation(
        id=id_, page_index=0, text=text, value_mm=value, unit="mm", unit_explicit=False, unit_basis="note",
        text_bbox=BBox((s0 + s1) / 2 - 8, line_y - 10, 16, 8), text_angle=0, kind="linear", confidence=0.92, source="pdf",
        axis="h", span=(s0, s1), line_pos=line_y, line=Segment(s0, line_y, s1, line_y), extension_lines=exts, view_id="v0",
        scale_check={"consistent": True, "relative_error": 0.0, "scale_ratio": 100, "drawn_length_mm": value},
    )


def test_dimension_whose_span_matches_jambs_is_associated():
    o = _opening(100, 100 + 1200 * PT)
    d = _dim("d1", "1200", 1200, 100, 100 + 1200 * PT)
    associate_dimensions([o], [d], _view(), DetectionContext(_page(), _view()))
    assert o.width_assoc is not None and o.width_assoc.dimension_id == "d1"
    codes = {s["code"] for s in o.width_assoc.signals}
    assert {"dim_line_edges", "extension_lines", "orientation"} <= codes
    assert o.width_assoc.score > 0.8


def test_nearby_number_without_geometric_link_is_not_associated():
    """The closest number is not assumed to belong to the opening."""
    o = _opening(100, 100 + 1200 * PT)
    # a chain segment right next to the window but spanning the wall pier beside it
    d = _dim("d1", "600", 600, 100 + 1200 * PT, 100 + 1800 * PT, line_y=395)
    associate_dimensions([o], [d], _view(), DetectionContext(_page(), _view()))
    assert o.width_assoc is None


def test_chain_segments_only_associate_where_they_meet_the_opening():
    a0, a1 = 100 + 900 * PT, 100 + 2100 * PT
    o = _opening(a0, a1)
    dims = [
        _dim("c1", "900", 900, 100, a0),
        _dim("c2", "1200", 1200, a0, a1),
        _dim("c3", "1500", 1500, a1, a1 + 1500 * PT),
    ]
    associate_dimensions([o], dims, _view(), DetectionContext(_page(), _view()))
    assert o.width_assoc.dimension_id == "c2"


def test_ambiguous_association_consults_vision_and_is_flagged():
    a0, a1 = 100, 100 + 1200 * PT
    o = _opening(a0, a1)
    d1 = _dim("d1", "1200", 1200, a0, a1)
    d2 = _dim("d2", "1210", 1210, a0, a1, line_y=350)
    vision = FakeVisionProvider(choice_index=1)
    associate_dimensions([o], [d1, d2], _view(), DetectionContext(_page(), _view()), vision, crop=lambda b: _png())
    assert vision.calls and vision.calls[0][0] == "adjudicate"
    # the model may only choose among detected ids - never supply a number
    assert o.width_assoc.dimension_id in {"d1", "d2"}
    codes = {s["code"] for s in o.width_assoc.signals}
    assert "ambiguous" in codes
    assert o.width_assoc.score <= 0.6


def _png():
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (50, 50), "white").save(buf, format="PNG")
    return buf.getvalue()
