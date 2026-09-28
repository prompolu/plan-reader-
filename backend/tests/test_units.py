import pytest

from planmeasure.pipeline.scale import format_ratio, parse_scale
from planmeasure.pipeline.units import find_expressions, format_ft_in, format_length, parse_dimension, parse_size


@pytest.mark.parametrize(
    "text,mm,unit",
    [
        ("900", 900, "mm"),
        ("2100", 2100, "mm"),
        ("900mm", 900, "mm"),
        ("90 cm", 900, "cm"),
        ("2.1m", 2100, "m"),
        ("3'-0\"", 914.4, "ft_in"),
        ("6'-8\"", 2032.0, "ft_in"),
        ("3'-6 1/2\"", 1079.5, "ft_in"),
        ("12' - 0\"", 3657.6, "ft_in"),
        ("36\"", 914.4, "in"),
        ("35 1/2\"", 901.7, "in"),
        ("3′-0″", 914.4, "ft_in"),  # prime characters
    ],
)
def test_parse_single_dimension(text, mm, unit):
    d = parse_dimension(text)
    assert d is not None
    assert d.value_mm == pytest.approx(mm, abs=0.05)
    assert d.unit == unit
    assert d.text == text  # original text is preserved exactly


@pytest.mark.parametrize(
    "text,w,h",
    [
        ("1200 x 1500", 1200, 1500),
        ("900x2100", 900, 2100),
        ("1200 X 1500", 1200, 1500),
        ("4'-0\" x 5'-0\"", 1219.2, 1524.0),
        ("120 x 150 cm", 1200, 1500),  # a trailing unit applies to both values
        ("1219 × 2032 mm", 1219, 2032),
    ],
)
def test_parse_size_pairs(text, w, h):
    pair = parse_size(text)
    assert pair is not None
    assert pair[0].value_mm == pytest.approx(w, abs=0.05)
    assert pair[1].value_mm == pytest.approx(h, abs=0.05)


@pytest.mark.parametrize("text", ["W-03", "A-102", "D01", "12.4 m²", "SCALE 1:100", "FFL +2.700"])
def test_non_dimensions_are_not_lengths(text):
    assert not [e for e in find_expressions(text) if e.kind in ("dim", "pair")]


def test_scale_and_levels_are_recognised_not_measured():
    kinds = [e.kind for e in find_expressions('SCALE 1/4" = 1\'-0"')]
    assert kinds == ["scale"]
    assert [e.kind for e in find_expressions("FFL +3.000")] == ["level"]


def test_plain_decimal_only_parsed_when_metres_are_stated():
    assert parse_dimension("2.10") is None
    d = parse_dimension("2.10", default_unit="m")
    assert d is not None and d.value_mm == pytest.approx(2100)


def test_display_formatting_never_changes_value():
    v = 1219.2
    assert format_length(v, "mm") == "1219 mm"
    assert format_length(v, "cm") == "121.9 cm"
    assert format_length(v, "m") == "1.219 m"
    assert format_length(v, "ft_in") == "4'-0\""
    assert format_length(v, "original", "4'-0\"") == "4'-0\""
    assert format_ft_in(1079.5) == "3'-6 1/2\""
    assert format_length(None, "mm") == "—"


@pytest.mark.parametrize(
    "text,ratio",
    [("1:50", 50), ("SCALE 1:100", 100), ('1/4" = 1\'-0"', 48), ('3/16" = 1\'-0"', 64), ('1/8" = 1\'-0"', 96)],
)
def test_parse_scale(text, ratio):
    parsed = parse_scale(text)
    assert parsed is not None
    assert parsed[1] == pytest.approx(ratio)


def test_format_ratio():
    assert format_ratio(100) == "1:100"
    assert format_ratio(48, imperial=True) == '1/4" = 1\'-0"'
