import type { Thresholds } from "../api/types";

export type Band = "green" | "yellow" | "red";

export function band(value: number | null | undefined, t: Thresholds): Band {
  if (value === null || value === undefined) return "red";
  if (value >= t.high) return "green";
  if (value >= t.medium) return "yellow";
  return "red";
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 100)}%`;
}

export const BAND_COLORS: Record<Band, string> = {
  green: "#15803d",
  yellow: "#ca8a04",
  red: "#dc2626",
};

export const DEFAULT_THRESHOLDS: Thresholds = { high: 0.85, medium: 0.6 };
