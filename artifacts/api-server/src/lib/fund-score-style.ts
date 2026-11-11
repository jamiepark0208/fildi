/**
 * Style-bucket classifiers (A83 god-file split from fund-score-engine).
 */
import { isExtendedCyclical } from "./fund-score-guards.js";
import type { FundRowInput, StyleBucket } from "./fund-score-types.js";

export type { FundRowInput, StyleBucket, FamilyName } from "./fund-score-types.js";

const FINANCIAL_GROUP_RE = /(bank|insur|reit|financial|broker|asset_manag)/i;
const DEFENSIVE_GROUP_RE = /(staples|utilities|healthcare|pharma|telecom)/i;
const FINANCIAL_MODE = new Set(["financial", "insurance", "reit", "financial_mixed"]);

/** True pre-revenue / pre-profit speculative: zero revenue, or loss-making with small scale.
 *  Missing revenue = unknown, not pre-revenue (11-11: 39 non-USD ADRs — TSM, ASML, SAP, NVO, TM — have revenue cleared by
 *  the A329 non-USD gold policy and were all scored with pre-revenue weights). */
export function isEconomicallyPreRevenue(r: FundRowInput): boolean {
  const rev = r.totalRevenue;
  const ni = r.netIncome;
  if (rev == null) return false;
  if (rev <= 0) return true;
  if (rev < 50_000_000 && (ni == null || ni < 0)) return true;
  return false;
}

/** Loss-making operating company (has real revenue but negative earnings). */
export function isUnprofitableOperator(r: FundRowInput): boolean {
  return !isEconomicallyPreRevenue(r) && r.netIncome != null && r.netIncome < 0;
}

export function isFinancialLike(r: FundRowInput): boolean {
  if (r.scoringMode && FINANCIAL_MODE.has(r.scoringMode)) return true;
  return !!(r.peerGroupId && FINANCIAL_GROUP_RE.test(r.peerGroupId));
}

export function isCyclicalLike(r: FundRowInput): boolean {
  return isExtendedCyclical(r);
}

export function isChineseLike(r: FundRowInput): boolean {
  return r.scoringMode === "chinese" || !!(r.peerGroupId && /chinese/i.test(r.peerGroupId));
}

export function isReitLike(r: FundRowInput): boolean {
  return r.scoringMode === "reit" || !!(r.peerGroupId && /reit/i.test(r.peerGroupId));
}

/** Neg equity (neg PB), or critically thin liquidity. */
export function isDistressed(r: FundRowInput): boolean {
  if (r.priceToBook != null && r.priceToBook < 0) return true;
  if (r.currentRatio != null && r.currentRatio > 0 && r.currentRatio < 0.5) return true;
  return false;
}

export function assignStyleBucket(
  r: FundRowInput,
  peerValueNorm: number | null,
  peerGrowthNorm: number | null,
): StyleBucket {
  if (isEconomicallyPreRevenue(r)) return "pre_revenue";
  if (isFinancialLike(r)) return "financial";
  if (r.peerGroupId && DEFENSIVE_GROUP_RE.test(r.peerGroupId) && (peerValueNorm == null || peerValueNorm < 0.7)) {
    if (peerGrowthNorm == null || peerGrowthNorm < 0.55) return "quality_defensive";
  }
  const v = peerValueNorm ?? 0.5;
  const g = peerGrowthNorm ?? 0.5;
  if (isUnprofitableOperator(r)) {
    if (g >= 0.55) return "growth";
    return "blend";
  }
  if (v >= 0.55 && g >= 0.55) return "garp";
  if (v >= 0.6 && g < 0.45) return "value";
  if (g >= 0.6 && v < 0.45) return "growth";
  if (v < 0.4 && g < 0.4 && (r.beta == null || r.beta < 0.9)) return "quality_defensive";
  return "blend";
}
