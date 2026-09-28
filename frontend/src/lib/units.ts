import type { DisplayUnit, Measurement } from "../api/types";

/** Presentation only: the stored millimetre value is never changed by the display unit. */
export function formatFtIn(mm: number, denominator = 16): string {
  const totalIn = mm / 25.4;
  const sixteenths = Math.round(totalIn * denominator);
  const perFoot = 12 * denominator;
  const ft = Math.floor(sixteenths / perFoot);
  const rem = sixteenths - ft * perFoot;
  const wholeIn = Math.floor(rem / denominator);
  let fracN = rem - wholeIn * denominator;
  let frac = "";
  if (fracN) {
    let d = denominator;
    const g = gcd(fracN, d);
    fracN /= g;
    d /= g;
    frac = ` ${fracN}/${d}`;
  }
  return `${ft}'-${wholeIn}${frac}"`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function trim(x: number, nd: number): string {
  let s = x.toFixed(nd);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export function formatLength(mm: number | null | undefined, unit: DisplayUnit, original?: string | null, withUnit = true): string {
  if (mm === null || mm === undefined || Number.isNaN(mm)) return "—";
  if (unit === "original" && original) return original;
  switch (unit) {
    case "cm":
      return trim(mm / 10, 1) + (withUnit ? " cm" : "");
    case "m":
      return trim(mm / 1000, 3) + (withUnit ? " m" : "");
    case "ft_in":
      return formatFtIn(mm);
    default:
      return `${Math.round(mm)}` + (withUnit ? " mm" : "");
  }
}

export function measurementText(m: Measurement | null, unit: DisplayUnit): string {
  if (!m) return "Needs review";
  if (m.status === "conflict") return "Conflict";
  const t = formatLength(m.value, unit, m.original_text);
  return m.status === "inferred" ? `${t}*` : t;
}

export const UNIT_LABELS: Record<DisplayUnit, string> = {
  original: "Original",
  mm: "mm",
  cm: "cm",
  m: "m",
  ft_in: "ft-in",
};

export const SOURCE_LABELS: Record<string, string> = {
  explicit_dimension: "Dimension on drawing",
  callout: "Size callout",
  schedule: "Schedule",
  drawing_scale: "Inferred from drawing scale",
  user: "Entered by user",
  conflict: "Conflicting sources",
};
