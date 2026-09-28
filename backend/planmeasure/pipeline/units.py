"""Parsing and formatting of architectural dimension notation.

The parser never invents a value: it only converts text that is actually
present on the drawing. The original text is always preserved alongside the
normalised millimetre value.

Supported notations::

    900   2100   1200mm   90 cm   2.1m   1200 x 1500   900x2100
    3'-0"   6'-8"   3'-6 1/2"   36"   35 1/2"   4'-0" x 5'-0"
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from fractions import Fraction

MM_PER_UNIT = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8, "ft_in": 25.4}

_CHAR_MAP = {
    "′": "'",  # prime
    "″": '"',  # double prime
    "’": "'",
    "‘": "'",
    "”": '"',
    "“": '"',
    "×": "x",  # multiplication sign
    "–": "-",  # en dash
    "—": "-",
    "−": "-",  # minus
    " ": " ",
}


def normalize_chars(text: str) -> str:
    """Character-for-character normalisation (keeps string length and offsets)."""
    return "".join(_CHAR_MAP.get(c, c) for c in text)


# --- component regexes -----------------------------------------------------

_FT_IN = (
    r"(?P<ft>\d{1,3})\s*'\s*(?:-\s*)?"
    r"(?:(?P<in>\d{1,2}(?:\.\d+)?)(?:\s*[-\s]\s*(?P<num>\d{1,2})\s*/\s*(?P<den>\d{1,2}))?"
    r"|(?P<fnum>\d{1,2})\s*/\s*(?P<fden>\d{1,2}))?"
    r"\s*(?:\"|'')?"
)
_INCH = (
    r"(?:(?P<iin>\d{1,3}(?:\.\d+)?)(?:\s*[-\s]\s*(?P<inum>\d{1,2})\s*/\s*(?P<iden>\d{1,2}))?"
    r"|(?P<ifnum>\d{1,2})\s*/\s*(?P<ifden>\d{1,2}))\s*(?:\"|'')"
)
_METRIC_UNIT = r"(?P<mval>\d{1,6}(?:[.,]\d{1,3})?)\s*(?P<munit>mm|cm|m)(?![a-zA-Z0-9\u00b2\u00b3])"
_PLAIN_INT = r"(?P<pint>\d{2,5})"
_PLAIN_DEC = r"(?P<pdec>\d{1,2}\.\d{1,3})"

RE_FT_IN = re.compile(r"(?<![\w.'\"/])" + _FT_IN)
RE_INCH = re.compile(r"(?<![\w.'\"/-])" + _INCH)
RE_METRIC_UNIT = re.compile(r"(?<![\w.,])" + _METRIC_UNIT, re.IGNORECASE)
# a trailing/leading "x" is allowed so that "900x2100" parses as a pair
RE_PLAIN = re.compile(
    r"(?<![0-9A-WYZa-wyz_.,/:'\"+\-#])(?:" + _PLAIN_DEC + "|" + _PLAIN_INT + r")(?![0-9A-WYZa-wyz_.,/:'\"%])"
)

RE_SCALE_METRIC = re.compile(r"(?<![\d.])1\s*:\s*(?P<den>\d{1,5})(?![\d])")
RE_SCALE_IMPERIAL = re.compile(
    r"(?P<paper>\d{1,2}(?:\s*[- ]\s*\d{1,2}/\d{1,2})?|\d{1,2}/\d{1,3})\s*(?:\"|'')\s*=\s*(?P<real>\d{1,3})\s*'\s*-?\s*0?\s*(?:\"|'')?"
)
RE_LEVEL = re.compile(
    r"(?:(?:FFL|FL|RL|EL|LEVEL|TOS|SSL|SFL|T\.O\.)\.?\s*)?[+±-]\s*\d{1,3}[.,]\d{2,3}", re.IGNORECASE
)
RE_PAIR_SEP = re.compile(r"^\s*[xX]\s*$")


@dataclass
class ParsedDimension:
    value_mm: float
    unit: str  # "mm" | "cm" | "m" | "in" | "ft_in"
    unit_explicit: bool
    system: str  # "metric" | "imperial"
    text: str

    def to_dict(self) -> dict:
        return {
            "value_mm": round(self.value_mm, 2),
            "unit": self.unit,
            "unit_explicit": self.unit_explicit,
            "system": self.system,
            "original_text": self.text,
        }


@dataclass
class Expression:
    kind: str  # "dim" | "pair" | "level" | "scale"
    start: int
    end: int
    text: str
    dim: ParsedDimension | None = None
    pair: tuple[ParsedDimension, ParsedDimension] | None = None
    # offsets of each pair member, for highlighting
    pair_spans: tuple[tuple[int, int], tuple[int, int]] | None = None


def _frac(num: str | None, den: str | None) -> float:
    if not num or not den:
        return 0.0
    d = int(den)
    if d == 0:
        return 0.0
    return int(num) / d


def _from_ft_in(m: re.Match) -> float | None:
    ft = int(m.group("ft"))
    inches = 0.0
    if m.group("in") is not None:
        inches = float(m.group("in")) + _frac(m.group("num"), m.group("den"))
    elif m.group("fnum") is not None:
        inches = _frac(m.group("fnum"), m.group("fden"))
    if inches >= 12:
        return None  # 3'-14" is not valid notation
    return (ft * 12 + inches) * 25.4


def _from_inch(m: re.Match) -> float | None:
    if m.group("iin") is not None:
        inches = float(m.group("iin")) + _frac(m.group("inum"), m.group("iden"))
    else:
        inches = _frac(m.group("ifnum"), m.group("ifden"))
    return inches * 25.4 if inches > 0 else None


def find_expressions(text: str, default_unit: str = "mm") -> list[Expression]:
    """Find dimension-like expressions in one text line.

    Scale notations ("1:100", '1/4" = 1'-0"') and level markers ("+2.700")
    are recognised first so that they are never mistaken for opening sizes.
    """
    norm = normalize_chars(text)
    taken = [False] * len(norm)
    found: list[Expression] = []

    def free(a: int, b: int) -> bool:
        return not any(taken[a:b])

    def take(a: int, b: int) -> None:
        for i in range(a, b):
            taken[i] = True

    for rx, kind in ((RE_SCALE_IMPERIAL, "scale"), (RE_SCALE_METRIC, "scale"), (RE_LEVEL, "level")):
        for m in rx.finditer(norm):
            if free(m.start(), m.end()):
                take(m.start(), m.end())
                found.append(Expression(kind, m.start(), m.end(), text[m.start() : m.end()]))

    singles: list[Expression] = []

    for m in RE_FT_IN.finditer(norm):
        a, b = m.start(), m.end()
        # strip trailing whitespace captured by optional groups
        while b > a and norm[b - 1] == " ":
            b -= 1
        if not free(a, b):
            continue
        v = _from_ft_in(m)
        if v is None:
            continue
        take(a, b)
        singles.append(Expression("dim", a, b, text[a:b], ParsedDimension(v, "ft_in", True, "imperial", text[a:b])))

    for m in RE_INCH.finditer(norm):
        a, b = m.start(), m.end()
        if not free(a, b):
            continue
        v = _from_inch(m)
        if v is None:
            continue
        take(a, b)
        singles.append(Expression("dim", a, b, text[a:b], ParsedDimension(v, "in", True, "imperial", text[a:b])))

    for m in RE_METRIC_UNIT.finditer(norm):
        a, b = m.start(), m.end()
        if not free(a, b):
            continue
        unit = m.group("munit").lower()
        val = float(m.group("mval").replace(",", "."))
        take(a, b)
        singles.append(
            Expression("dim", a, b, text[a:b], ParsedDimension(val * MM_PER_UNIT[unit], unit, True, "metric", text[a:b]))
        )

    for m in RE_PLAIN.finditer(norm):
        a, b = m.start(), m.end()
        if not free(a, b):
            continue
        if m.group("pint") is not None:
            val = float(m.group("pint"))
            unit = default_unit if default_unit in ("mm", "cm", "in") else "mm"
        else:
            val = float(m.group("pdec"))
            # a plain decimal is only a length if the drawing states metres
            if default_unit != "m":
                continue
            unit = "m"
        take(a, b)
        system = "imperial" if unit == "in" else "metric"
        singles.append(
            Expression("dim", a, b, text[a:b], ParsedDimension(val * MM_PER_UNIT[unit], unit, False, system, text[a:b]))
        )

    singles.sort(key=lambda e: e.start)
    # combine "A x B" into pairs
    i = 0
    while i < len(singles):
        cur = singles[i]
        if i + 1 < len(singles):
            nxt = singles[i + 1]
            between = norm[cur.end : nxt.start]
            if RE_PAIR_SEP.match(between) and cur.dim and nxt.dim:
                first = cur.dim
                if not first.unit_explicit and nxt.dim.unit_explicit and nxt.dim.system == "metric":
                    # "120 x 150 cm": the unit written after the pair applies to both values
                    raw = first.value_mm / MM_PER_UNIT[first.unit]
                    first = ParsedDimension(raw * MM_PER_UNIT[nxt.dim.unit], nxt.dim.unit, True, "metric", first.text)
                found.append(
                    Expression(
                        "pair",
                        cur.start,
                        nxt.end,
                        text[cur.start : nxt.end],
                        pair=(first, nxt.dim),
                        pair_spans=((cur.start, cur.end), (nxt.start, nxt.end)),
                    )
                )
                i += 2
                continue
        found.append(cur)
        i += 1

    found.sort(key=lambda e: e.start)
    return found


def parse_dimension(text: str, default_unit: str = "mm") -> ParsedDimension | None:
    """Parse text that should contain exactly one dimension."""
    exprs = [e for e in find_expressions(text.strip(), default_unit) if e.kind == "dim"]
    if len(exprs) != 1:
        return None
    return exprs[0].dim


def parse_size(text: str, default_unit: str = "mm") -> tuple[ParsedDimension, ParsedDimension] | None:
    """Parse a size like '1200 x 1500' or 4'-0\" x 5'-0\" (width x height)."""
    exprs = [e for e in find_expressions(text.strip(), default_unit) if e.kind == "pair"]
    if len(exprs) != 1:
        return None
    return exprs[0].pair


# --- formatting -------------------------------------------------------------

DISPLAY_UNITS = ("original", "mm", "cm", "m", "ft_in")


def _trim(x: float, nd: int) -> str:
    s = f"{x:.{nd}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def format_ft_in(value_mm: float, denominator: int = 16) -> str:
    total_in = value_mm / 25.4
    sixteenths = round(total_in * denominator)
    ft, rem = divmod(sixteenths, 12 * denominator)
    whole_in, frac_n = divmod(rem, denominator)
    frac = ""
    if frac_n:
        f = Fraction(frac_n, denominator)
        frac = f" {f.numerator}/{f.denominator}"
    return f"{ft}'-{whole_in}{frac}\""


def format_length(value_mm: float | None, unit: str, original_text: str | None = None, with_unit: bool = True) -> str:
    """Format a normalised millimetre value for display.

    Formatting never changes the stored value - it is presentation only.
    """
    if value_mm is None or (isinstance(value_mm, float) and math.isnan(value_mm)):
        return "—"
    if unit == "original" and original_text:
        return original_text
    if unit in ("original", "mm"):
        return f"{round(value_mm):d}" + (" mm" if with_unit else "")
    if unit == "cm":
        return _trim(value_mm / 10, 1) + (" cm" if with_unit else "")
    if unit == "m":
        return _trim(value_mm / 1000, 3) + (" m" if with_unit else "")
    if unit in ("ft_in", "in"):
        return format_ft_in(value_mm)
    return f"{round(value_mm):d} mm"


def approx_equal_mm(a: float, b: float, rel: float = 0.005, abs_mm: float = 3.0) -> bool:
    """Tolerance for comparing two sources of the same measurement.

    3 mm absorbs imperial->metric rounding; 0.5% absorbs rounding of large values.
    """
    return abs(a - b) <= max(abs_mm, rel * max(abs(a), abs(b)))
