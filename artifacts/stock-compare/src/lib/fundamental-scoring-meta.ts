// Client display helpers for fund-score families. Live scoring is fund-score-engine
// (value / growth / quality / safety + style weights + 10% sector layer). Keep labels
// in sync with artifacts/stock-compare/src/lib/fund-score-treatments.ts.

import {
  STYLE_FAMILY_WEIGHTS,
  type FamilyName,
  type StyleBucket,
} from "./fund-score-treatments";

export type FundamentalFamily = FamilyName;

export interface FundamentalMetricMeta {
  key: string;
  label: string;
  family: FundamentalFamily;
  weight: number;
  higherBetter: boolean;
  unit: "pct" | "ratio" | "years";
}

/** Legacy metric keys still used by older Why-panel formatting — not the full ENGINE_METRICS set. */
export const FUNDAMENTAL_METRIC_META: FundamentalMetricMeta[] = [
  { key: "grossMargin",     label: "Gross Margin",      family: "quality", weight: 2.0, higherBetter: true,  unit: "pct" },
  { key: "operatingMargin", label: "Operating Margin",  family: "quality", weight: 2.0, higherBetter: true,  unit: "pct" },
  { key: "netMargin",       label: "Net Margin",        family: "quality", weight: 3.0, higherBetter: true,  unit: "pct" },
  { key: "roe",             label: "Return on Equity",  family: "quality", weight: 2.0, higherBetter: true,  unit: "pct" },
  { key: "roicWacc",        label: "ROIC − WACC",       family: "quality", weight: 1.5, higherBetter: true,  unit: "pct" },
  { key: "revGrowth",       label: "Revenue Growth",    family: "growth",  weight: 3.0, higherBetter: true,  unit: "pct" },
  { key: "epsGrowth",       label: "EPS Growth",        family: "growth",  weight: 3.0, higherBetter: true,  unit: "pct" },
  { key: "currentRatio",    label: "Current Ratio",     family: "safety",  weight: 1.5, higherBetter: true,  unit: "ratio" },
  { key: "debtToEquity",    label: "Debt / Equity",     family: "safety",  weight: 1.0, higherBetter: false, unit: "ratio" },
  { key: "intCoverage",     label: "Interest Coverage", family: "safety",  weight: 2.5, higherBetter: true,  unit: "ratio" },
  { key: "cashRunway",      label: "Cash Runway",       family: "safety",  weight: 3.0, higherBetter: true,  unit: "years" },
];

export const FUNDAMENTAL_METRIC_BY_KEY: Record<string, FundamentalMetricMeta> =
  Object.fromEntries(FUNDAMENTAL_METRIC_META.map(m => [m.key, m]));

/** Display order on Rankings leaderboard (matches Breakdown Value/Growth/Quality/Safety). */
export const FAMILY_ORDER: FundamentalFamily[] = ["value", "growth", "quality", "safety"];

export const FAMILY_LABEL: Record<FundamentalFamily, string> = {
  value: "Value",
  growth: "Growth",
  quality: "Quality",
  safety: "Safety",
};

/** Blend-style defaults when styleBucket missing — matches STYLE_FAMILY_WEIGHTS.blend. */
export const DEFAULT_FAMILY_WEIGHTS: Record<FundamentalFamily, number> =
  STYLE_FAMILY_WEIGHTS.blend;

/** Family weights for the stacked bar — live engine uses style bucket, not macro regime. */
export function familyWeightsForStyle(styleBucket: string | null | undefined): Record<FundamentalFamily, number> {
  const key = (styleBucket && styleBucket in STYLE_FAMILY_WEIGHTS
    ? styleBucket
    : "blend") as StyleBucket;
  return STYLE_FAMILY_WEIGHTS[key];
}

/** @deprecated Prefer familyWeightsForStyle — regime no longer drives family weights. */
export function familyWeightsForRegime(_regime: string | undefined): Record<FundamentalFamily, number> {
  return DEFAULT_FAMILY_WEIGHTS;
}

export const SECTOR_WEIGHT: Record<string, number> = {
  grossMargin: 0.70, operatingMargin: 0.70, netMargin: 0.65, roe: 0.55, roicWacc: 0.50,
  revGrowth: 0.60, epsGrowth: 0.55, currentRatio: 0.65, debtToEquity: 0.70, intCoverage: 0.65,
  cashRunway: 0.30,
};
export const MIN_SECTOR_PEERS = 3;

export function formatMetricValue(meta: FundamentalMetricMeta | undefined, raw: number): string {
  if (!meta) return raw.toFixed(2);
  if (meta.unit === "pct")  return `${(raw * 100).toFixed(1)}%`;
  if (meta.unit === "years") return `${raw.toFixed(1)}y`;
  return Math.abs(raw) >= 10 ? raw.toFixed(1) : raw.toFixed(2);
}
