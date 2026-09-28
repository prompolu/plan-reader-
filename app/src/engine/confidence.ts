/** Confidence scoring and review flags. */
import { pyRound } from "./py";

export class Thresholds {
  constructor(
    /** >= high: green */
    public high = 0.85,
    /** >= medium: yellow (review recommended); below: red */
    public medium = 0.6,
  ) {}

  static fromDict(d: { high?: number; medium?: number } | null | undefined): Thresholds {
    const high = Number(d?.high ?? 0.85);
    const medium = Number(d?.medium ?? 0.6);
    if (!(0 < medium && medium < high && high <= 1)) return new Thresholds();
    return new Thresholds(high, medium);
  }

  band(value: number | null | undefined): "green" | "yellow" | "red" {
    if (value === null || value === undefined) return "red";
    if (value >= this.high) return "green";
    if (value >= this.medium) return "yellow";
    return "red";
  }
}

export const FLAG_INFO: Record<string, [string, string]> = {
  missing_width: ["warning", "Width missing"],
  missing_height: ["warning", "Height missing"],
  unclear_tag: ["warning", "Tag unclear"],
  low_confidence: ["warning", "Low confidence"],
  uncertain_association: ["warning", "Uncertain dimension association"],
  scale_inferred: ["warning", "Measurement inferred from drawing scale"],
  schedule_conflict: ["error", "Schedule conflict"],
  dimension_conflict: ["error", "Dimension conflict"],
  quantity_conflict: ["warning", "Quantity differs from schedule"],
  possible_duplicate: ["warning", "Possible duplicate"],
  unclear_type: ["warning", "Opening type unclear"],
  schedule_only: ["warning", "Schedule entry without drawing evidence"],
  reference_only: ["warning", "Not located on a floor plan"],
  poor_page_quality: ["warning", "Poor quality source page"],
  unit_assumed: ["info", "Unit assumed (no unit note found)"],
  geometry_not_found: ["warning", "Tag found but opening geometry not located"],
  counted_from_elevations: ["warning", "Quantity counted from elevations"],
  ai_update_available: ["info", "Re-extraction result differs from your edits"],
};

export interface Flag {
  code: string;
  severity: "info" | "warning" | "error";
  label: string;
  message: string;
  field?: string;
  page_index?: number;
  [k: string]: unknown;
}

export function flag(code: string, message: string, extra: Record<string, unknown> = {}): Flag {
  const [sev, label] = FLAG_INFO[code] ?? ["warning", code];
  return { code, severity: sev as Flag["severity"], label, message, ...extra };
}

export function overall(conf: Record<string, number | null>, requiredMissing: boolean): number {
  const vals = Object.entries(conf)
    .filter(([k, v]) => k !== "overall" && v !== null && v !== undefined)
    .map(([, v]) => v as number);
  if (!vals.length) return 0;
  let o = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (requiredMissing) o = Math.min(o, 0.49);
  return pyRound(o, 3);
}

export function needsReview(flags: Flag[]): boolean {
  return flags.some((f) => f.severity === "warning" || f.severity === "error");
}
