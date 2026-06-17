import { SCORECARD_METRICS_V2, FAMILY_PRESETS } from "@/lib/rankings";
import { TECHNICAL_SCORECARD_METRICS_V2 } from "@/lib/technical-rankings";
import {
  W_INCOME, W_BUFFER, W_IV_RELATIVE, W_IV_ABSOLUTE, W_STOCK_QUALITY, W_SUPPORT, W_DTE,
  WS_TECHNICAL, WS_FUNDAMENTAL, WS_RELATIVE_MOVE, WS_BEST_OPTION, WS_TAG,
} from "@/lib/option-scorer-constants";

export type GuideTab = "fundamental" | "technical" | "options";
export type CoverageDomain = "fundamentals" | "technicals" | "options";
export type RefreshCadence = "Weekly" | "Daily" | "On scan" | "Static" | "Mixed";

import type { WeightGroup } from "@/lib/scoring-weights";

export type GuideMetricRow = {
  key: string;
  label: string;
  weight: number;
  weightLabel: string;
  higherIsBetter: boolean | "band";
  source: string;
  refresh: RefreshCadence;
  coverageDomain: CoverageDomain;
  family?: string;
  notes: string;
  section?: string;
  weightGroup: WeightGroup;
  weightKey: string;
  /** true for 0–100 family preset weights; false for 0–1 fractional */
  weightIsPercent?: boolean;
};

const FUND_CAVEATS: Record<string, string> = {
  peg: "Null if EPS growth ≤ 0 or negative earnings",
  roicwacc: "Excluded for HOOD, SOFI (financials)",
  cashrun: "Cash-generative names capped at max runway",
  upside: "Analyst consensus proxy, not intrinsic value",
};

export const FUNDAMENTAL_FAMILY_WEIGHTS = Object.entries(FAMILY_PRESETS.PUT_SELLER).map(([family, pct]) => ({
  family,
  pct,
}));

export const FUNDAMENTAL_GUIDE_ROWS: GuideMetricRow[] = SCORECARD_METRICS_V2.map(m => ({
  key: m.key,
  label: m.label,
  family: m.family,
  weight: m.intraWeight,
  weightLabel: String(m.intraWeight),
  higherIsBetter: m.higherIsBetter,
  source: "FactSet→FMP",
  refresh: "Weekly" as const,
  coverageDomain: "fundamentals" as const,
  notes: FUND_CAVEATS[m.key] ?? "Missing field → 0 on metric",
  weightGroup: "fundamentalMetrics",
  weightKey: m.key,
}));

export const FUNDAMENTAL_FAMILY_GUIDE_ROWS: GuideMetricRow[] = Object.entries(FAMILY_PRESETS.PUT_SELLER).map(
  ([family, pct]) => ({
    key: `fam_${family}`,
    label: `${family.charAt(0).toUpperCase()}${family.slice(1)} family`,
    family,
    weight: pct,
    weightLabel: `${pct}%`,
    higherIsBetter: true,
    source: "Computed",
    refresh: "Static" as const,
    coverageDomain: "fundamentals" as const,
    notes: "Inter-family blend weight",
    weightGroup: "familyPreset",
    weightKey: family,
    weightIsPercent: true,
  }),
);

export const TECHNICAL_GUIDE_ROWS: GuideMetricRow[] = TECHNICAL_SCORECARD_METRICS_V2.map(m => ({
  key: m.key,
  label: m.label,
  weight: m.weight,
  weightLabel: `${Math.round(m.weight * 100)}%`,
  higherIsBetter: true,
  source: "Yahoo→DB",
  refresh: "Daily" as const,
  coverageDomain: "technicals" as const,
  notes: m.key === "volatilityState"
    ? "IV rank/percentile use realized-vol proxy until IV history builds"
    : m.key === "optionsFlow"
      ? "Put/call percentile needs ~60d history"
      : m.description,
  weightGroup: "technical",
  weightKey: m.key,
}));

const opt = (
  key: string, label: string, weight: number, higher: boolean | "band",
  source: string, refresh: RefreshCadence, notes: string, section: string,
  weightGroup: "optionStock" | "optionStrike", weightKey: string,
): GuideMetricRow => ({
  key, label, weight, weightLabel: `${Math.round(weight * 100)}%`, higherIsBetter: higher,
  source, refresh, coverageDomain: "options", notes, section, weightGroup, weightKey,
});

export const OPTIONS_STOCK_ROWS: GuideMetricRow[] = [
  opt("wsTechnical", "Technical", WS_TECHNICAL, true, "DB", "Daily", "V2 technical score", "stock", "optionStock", "technical"),
  opt("wsFundamental", "Fundamental", WS_FUNDAMENTAL, true, "DB", "Weekly", "V2 fundamental score", "stock", "optionStock", "fundamental"),
  opt("wsRelativeMove", "Relative move", WS_RELATIVE_MOVE, true, "DB", "Daily", "Oversold vs own history", "stock", "optionStock", "relativeMove"),
  opt("wsBestOption", "Best option", WS_BEST_OPTION, true, "Computed", "On scan", "Top strike score", "stock", "optionStock", "bestOption"),
  opt("wsTag", "Watchlist tag", WS_TAG, true, "DB", "Static", "Small tie-breaker only", "stock", "optionStock", "tag"),
];

export const OPTIONS_STRIKE_ROWS: GuideMetricRow[] = [
  opt("wIncome", "Income", W_INCOME, "band", "Yahoo", "On scan", "Regime-adjusted weekly yield target", "strike", "optionStrike", "income"),
  opt("wBuffer", "Buffer", W_BUFFER, "band", "Yahoo", "On scan", "Delta band + SD vs expected move", "strike", "optionStrike", "buffer"),
  opt("wIvRel", "IV relative", W_IV_RELATIVE, true, "DB+Yahoo", "Mixed", "IV rank from DB", "strike", "optionStrike", "ivRelative"),
  opt("wIvAbs", "IV absolute", W_IV_ABSOLUTE, true, "Yahoo", "On scan", "Capped — avoids junk-high IV", "strike", "optionStrike", "ivAbsolute"),
  opt("wQuality", "Stock quality", W_STOCK_QUALITY, true, "DB", "Mixed", "Tech + fund combined", "strike", "optionStrike", "stockQuality"),
  opt("wSupport", "Support", W_SUPPORT, true, "DB", "Daily", "Distance to swing/pivot support", "strike", "optionStrike", "support"),
  opt("wDte", "DTE fit", W_DTE, "band", "Yahoo", "On scan", "~7d weekly expiry preferred", "strike", "optionStrike", "dte"),
];
