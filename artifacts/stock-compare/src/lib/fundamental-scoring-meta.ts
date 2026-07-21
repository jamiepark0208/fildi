// Mirrors SCORING_METRICS / REGIME_WEIGHTS in artifacts/api-server/src/lib/fundamentals-db.ts.
// Server is the source of truth for the actual computation — this copy exists only so the
// "Why" breakdown can reproduce the same formula client-side. Keep in sync if the server changes.

export type FundamentalFamily = "quality" | "growth" | "safety";

export interface FundamentalMetricMeta {
  key: string;
  label: string;
  family: FundamentalFamily;
  weight: number;
  higherBetter: boolean;
  unit: "pct" | "ratio" | "years";
}

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

export const REGIME_FAMILY_WEIGHTS: Record<string, Record<FundamentalFamily, number>> = {
  expansion:   { quality: 35, growth: 41, safety: 24 },
  late_cycle:  { quality: 44, growth: 25, safety: 31 },
  contraction: { quality: 44, growth: 19, safety: 37 },
  recession:   { quality: 35, growth: 12, safety: 53 },
  recovery:    { quality: 35, growth: 41, safety: 24 },
  stagflation: { quality: 47, growth: 13, safety: 40 },
};
export const DEFAULT_FAMILY_WEIGHTS: Record<FundamentalFamily, number> = { quality: 40, growth: 35, safety: 25 };

export function familyWeightsForRegime(regime: string | undefined): Record<FundamentalFamily, number> {
  return (regime && REGIME_FAMILY_WEIGHTS[regime]) ? REGIME_FAMILY_WEIGHTS[regime] : DEFAULT_FAMILY_WEIGHTS;
}

// How much each metric's percentile leans on same-sector peers vs. the whole universe.
// Mirrors SECTOR_WEIGHT / MIN_SECTOR_PEERS in fundamentals-db.ts.
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
