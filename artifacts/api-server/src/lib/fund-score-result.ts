/** A83 — fund-score result types + rank helper (split from fund-score-engine). */
import type { FamilyName, MetricKey, StyleBucket } from "./fund-score-types.js";

export type MetricScoreDetail = {
  value: number | null;
  peerNorm: number | null;
  histNorm: number | null;
  blended: number | null;
  weightedScore: number;
};

export type ScoredTicker = {
  ticker: string;
  totalScore: number | null;
  /** Company score before sector-opportunity blend (null if unscored). */
  companyScore: number | null;
  /** Calibrated peer-group sector opportunity (same units as total). */
  sectorScore: number | null;
  valueScore: number | null;
  qualityScore: number | null;
  growthScore: number | null;
  safetyScore: number | null;
  styleBucket: StyleBucket;
  confidence: "high" | "low";
  peerGroupId: string | null;
  peerGroupSize: number;
  coverage: { value: number; growth: number; quality: number; safety: number; total: number };
  ranked: boolean;
  metricScores: Record<string, MetricScoreDetail>;
};

export type HistoryByTicker = Record<string, Partial<Record<MetricKey, number[]>>>;
export type SurpriseByTicker = Record<string, number | null>;

/** WRDS IBES growth extras — missing tickers stay null (no penalty). */
export type IbesSignalsByTicker = Record<
  string,
  { revBreadth: number | null; sue: number | null; fwdGrowth?: number | null }
>;

/** Optional overrides from public.scorecard_params champion (fund-1.0.0 seed = code defaults). */
export type ScoreUniverseParams = {
  metricBaseIntra?: Partial<Record<MetricKey, number>>;
  styleFamilyWeights?: Partial<Record<StyleBucket, Partial<Record<FamilyName, number>>>>;
  megacapBlendFamilyWeights?: Partial<Record<FamilyName, number>>;
  totalMinCoverage?: number;
  familyMinCoverage?: number;
  /**
   * Metrics where "no value" means "not covered" (skipped, no coverage shrink). Absent = METRICS `optional` flags.
   * Present = the complete list (replaces the defaults, so a retired version reproduces exactly — e.g. fund-1.1.0
   * had only ibesFwdGrowth). Callers warn via missingDefaultOptionals() when a champion drops a code default.
   */
  optionalMetrics?: MetricKey[];
  /** A329 before/after: legacy reads negative vendor D/E; sanitized uses worst leverage + skip ROE. */
  negativeEquityLeverage?: "legacy" | "sanitized";
};

export function withRanks(scored: ScoredTicker[]): (ScoredTicker & { rank: number })[] {
  const ranked = scored
    .filter((r) => r.ranked && r.totalScore != null)
    .sort((a, b) => b.totalScore! - a.totalScore!);
  const map = new Map(ranked.map((r, i) => [r.ticker, i + 1]));
  return scored.map((r) => ({ ...r, rank: map.get(r.ticker) ?? 0 }));
}

