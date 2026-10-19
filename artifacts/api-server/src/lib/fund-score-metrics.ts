/** A83 — metric catalog + style family weights (split from fund-score-engine). */
import type { FamilyName, MetricDef, StyleBucket } from "./fund-score-types.js";

export const METRICS: MetricDef[] = [
  { key: "earningsYield", family: "value", baseIntra: 3, higherIsBetter: true, excludeStyles: ["pre_revenue"] },
  { key: "fcfYield", family: "value", baseIntra: 3, higherIsBetter: true },
  { key: "ps", family: "value", baseIntra: 1.5, higherIsBetter: false },
  { key: "peg", family: "value", baseIntra: 2, higherIsBetter: false, excludeStyles: ["pre_revenue"] },
  { key: "fwdpe", family: "value", baseIntra: 2, higherIsBetter: false, excludeStyles: ["pre_revenue"] },
  { key: "evEbitda", family: "value", baseIntra: 2, higherIsBetter: false },
  { key: "evRev", family: "value", baseIntra: 1, higherIsBetter: false },
  { key: "pb", family: "value", baseIntra: 1, higherIsBetter: false },
  { key: "ptbv", family: "value", baseIntra: 2, higherIsBetter: false },
  { key: "pFfo", family: "value", baseIntra: 2.5, higherIsBetter: false },
  { key: "expEy", family: "value", baseIntra: 3.5, higherIsBetter: true },
  { key: "divy", family: "value", baseIntra: 1, higherIsBetter: true },

  { key: "revgrow", family: "growth", baseIntra: 2.5, higherIsBetter: true },
  { key: "revaccel", family: "growth", baseIntra: 2, higherIsBetter: true },
  { key: "epsgrow", family: "growth", baseIntra: 2.5, higherIsBetter: true },
  { key: "upside", family: "growth", baseIntra: 1, higherIsBetter: true },
  { key: "avgEpsSurprise", family: "growth", baseIntra: 1, higherIsBetter: true },
  // WRDS IBES cache — street momentum / standardized surprise (null if unsynced)
  // optional: same coverage bug as ibesFwdGrowth — no IBES row must not shrink data coverage / wipe growth.
  { key: "ibesRevBreadth", family: "growth", baseIntra: 1.5, higherIsBetter: true, optional: true },
  // A25 F1: lab IC ~0 for SUE — keep field for UI/diagnostics, weight 0 so it doesn't move fund score.
  { key: "ibesSue", family: "growth", baseIntra: 0, higherIsBetter: true },
  // Consensus EPS growth FY1→FY2 (same IBES statpers, so split-invariant). Fair-value factor study:
  // IC +0.108 (t 3.4) vs 126-d peer-relative return, uncorrelated with breadth/drift/trend.
  // Weight 0 in fund-1.0.0; fund-1.1.0 (challenger → user-approved promotion) gives it weight.
  // optional: a ticker IBES doesn't cover is "not covered", not "missing data" — it must not shrink coverage
  // (without this, HOLX fell below the 0.4 total gate and CMPS lost its growth family in the before/after).
  { key: "ibesFwdGrowth", family: "growth", baseIntra: 0, higherIsBetter: true, optional: true },

  { key: "grossmgn", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "operatingmgn", family: "quality", baseIntra: 2.25, higherIsBetter: true },
  { key: "netmgn", family: "quality", baseIntra: 3.25, higherIsBetter: true },
  { key: "roe", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "fcfmgn", family: "quality", baseIntra: 2.25, higherIsBetter: true },
  { key: "roicwacc", family: "quality", baseIntra: 1.5, higherIsBetter: true },
  { key: "gpa", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "accruals", family: "quality", baseIntra: 2, higherIsBetter: false },
  { key: "fScore", family: "quality", baseIntra: 2, higherIsBetter: true },

  { key: "cashrun", family: "safety", baseIntra: 3, higherIsBetter: true },
  { key: "intcov", family: "safety", baseIntra: 2.5, higherIsBetter: true },
  { key: "dilution", family: "safety", baseIntra: 2, higherIsBetter: false },
  { key: "cr", family: "safety", baseIntra: 1.5, higherIsBetter: true },
  { key: "de", family: "safety", baseIntra: 1, higherIsBetter: false, excludeStyles: ["financial"] },
  { key: "netDebtEbitda", family: "safety", baseIntra: 2, higherIsBetter: false, excludeStyles: ["financial"] },
  { key: "beta", family: "safety", baseIntra: 1.5, higherIsBetter: false },
  { key: "netCashAssets", family: "safety", baseIntra: 2, higherIsBetter: true },
];

export const STYLE_FAMILY_WEIGHTS: Record<StyleBucket, Record<FamilyName, number>> = {
  value: { value: 35, growth: 15, quality: 30, safety: 20 },
  // Growth: slightly less pure-growth, more quality — profitable compounders (PLTR) beat
  // revenue rockets that only win on revgrow/epsgrow overweight.
  growth: { value: 14, growth: 35, quality: 33, safety: 18 },
  garp: { value: 25, growth: 28, quality: 32, safety: 15 },
  blend: { value: 25, growth: 25, quality: 30, safety: 20 },
  quality_defensive: { value: 15, growth: 15, quality: 40, safety: 30 },
  pre_revenue: { value: 5, growth: 40, quality: 25, safety: 30 },
  financial: { value: 25, growth: 15, quality: 30, safety: 30 },
};

/** Megacaps in blend: peer multiples bury franchises — lean quality/safety over value. */
export const MEGACAP_BLEND_FAMILY_WEIGHTS: Record<FamilyName, number> = {
  value: 15, growth: 20, quality: 40, safety: 25,
};

export const MIN_PEERS_CONFIDENT = 5;
