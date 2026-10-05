/**
 * Fund-score v3 guards: outlier caps, expected earnings, soft-peer blend,
 * speculative/China/cyclical/megacap post-adjustments.
 * Pure functions — unit-testable without DB.
 */

export type GuardRow = {
  ticker?: string;
  marketCap: number | null;
  forwardPe: number | null;
  netIncome: number | null;
  epsGrowth: number | null;
  totalRevenue: number | null;
  priceToSales?: number | null;
  peerGroupId: string | null;
  scoringMode: string | null;
  cashAndEquivalents?: number | null;
  totalDebt?: number | null;
  totalAssets?: number | null;
};

export type StyleBucket =
  | "value"
  | "growth"
  | "blend"
  | "garp"
  | "quality_defensive"
  | "pre_revenue"
  | "financial";

/** Cap YoY growth used in scoring so one 900% EPS print cannot crown a cohort. */
export const GROWTH_SCORE_CAP = 1.0; // ±100%
export const GROWTH_SCORE_FLOOR = -0.8;

/** PEG below this is treated as unreliable (data artifact / one-year spike), not "ultra cheap". */
export const PEG_UNRELIABLE_FLOOR = 0.25;

/** Soft / thin peer sets lean harder on sector + universe norms. */
export type BlendWeights = { peer: number; sector: number; universe: number };

export const DEFAULT_BLEND: BlendWeights = { peer: 0.55, sector: 0.30, universe: 0.15 };
export const SOFT_PEER_BLEND: BlendWeights = { peer: 0.35, sector: 0.35, universe: 0.30 };
export const MEGACAP_BLEND: BlendWeights = { peer: 0.45, sector: 0.30, universe: 0.25 };
/** Expected-earnings yield always uses a universe-heavy blend (cross-peer absolute-ish). */
export const EXP_EY_BLEND: BlendWeights = { peer: 0.25, sector: 0.35, universe: 0.40 };

export const MEGACAP_USD = 200e9;
export const SPECULATIVE_REV_FLOOR = 500e6; // $500M
export const SPECULATIVE_SCORE_CAP = 55;
export const CHINA_TOTAL_MULT = 0.90;
/**
 * Expensive-growth P/S post-haircut — DISABLED (mult=1).
 * P/S is already a value metric (higherIsBetter=false); a flat total × stacked on
 * top double-counted valuation pain. PLTR-class profitable growth should compete
 * on quality+growth families, not get a second P/S penalty.
 */
export const EXPENSIVE_GROWTH_PS = 25;
export const EXPENSIVE_GROWTH_MULT = 1.0;
export const MISSING_SAFETY_PRIOR = 38;
/** Megacap floor: blend quality into total when quality is at least respectable. */
export const MEGACAP_QUALITY_MIN = 48;
export const MEGACAP_TOTAL_WEIGHT = 0.72;
export const MEGACAP_QUALITY_WEIGHT = 0.28;

export function clampGrowth(g: number | null): number | null {
  if (g == null || !Number.isFinite(g)) return null;
  return Math.max(GROWTH_SCORE_FLOOR, Math.min(GROWTH_SCORE_CAP, g));
}

/**
 * Expected earnings yield — forward profit / price.
 * Prefer sane 1/forwardPE; else 1/trailingPE × (1+g); else NI/mcap with currency-mismatch guard.
 * Chinese ADRs often store NI/FCF in HKD/CNY while mcap from pe×eps×shares is USD —
 * those NI/mcap ratios look like 30–300% yields and must not enter the score.
 */
export function expectedEarningsYield(r: {
  marketCap: number | null;
  forwardPe: number | null;
  peRatio?: number | null;
  netIncome: number | null;
  epsGrowth: number | null;
}): number | null {
  if (r.forwardPe != null && r.forwardPe >= SANE_FORWARD_PE_MIN && r.forwardPe <= SANE_FORWARD_PE_MAX) {
    return 1 / r.forwardPe;
  }
  const trail = trailingEarningsYield(r);
  if (trail == null) return null;
  const g = clampGrowth(r.epsGrowth) ?? 0;
  const gVal = Math.min(0.35, Math.max(-0.25, g));
  return trail * (1 + gVal);
}

/** Trailing earnings yield — prefer 1/PE (unit-consistent); NI/mcap only if not absurd. */
export function trailingEarningsYield(r: {
  marketCap: number | null;
  peRatio?: number | null;
  netIncome: number | null;
}): number | null {
  if (r.peRatio != null && r.peRatio >= SANE_PE_MIN && r.peRatio <= SANE_PE_MAX) {
    return 1 / r.peRatio;
  }
  return sanitizedFlowYield(r.netIncome, r.marketCap);
}

/** FCF / mcap with currency-mismatch guard (same ADR issue as NI). */
export function sanitizedFcfYield(r: {
  marketCap: number | null;
  freeCashFlow: number | null;
}): number | null {
  return sanitizedFlowYield(r.freeCashFlow, r.marketCap);
}

/**
 * Dollar flow / USD mcap. If the ratio exceeds MAX_SANE_YIELD, local-currency
 * numerator vs USD denominator is the usual cause — return null.
 */
export function sanitizedFlowYield(flow: number | null, marketCap: number | null): number | null {
  if (flow == null || marketCap == null || marketCap <= 0) return null;
  const y = flow / marketCap;
  if (!Number.isFinite(y)) return null;
  if (Math.abs(y) > MAX_SANE_YIELD) return null;
  return y;
}

export const SANE_PE_MIN = 3;
export const SANE_PE_MAX = 100;
/** Forward PE below ~5 on large names is almost always a vendor field bug for ADRs. */
export const SANE_FORWARD_PE_MIN = 5;
export const SANE_FORWARD_PE_MAX = 80;
/** >25% EY/FCFY from NI÷mcap is not credible for liquid large caps — flag currency mix. */
export const MAX_SANE_YIELD = 0.25;

/** Net cash / assets — simple solvency signal already available in gold. */
export function netCashToAssets(
  cash: number | null,
  debt: number | null,
  assets: number | null,
): number | null {
  if (assets == null || assets <= 0) return null;
  const c = cash ?? 0;
  const d = debt ?? 0;
  return (c - d) / assets;
}

export function isMegacap(r: { marketCap: number | null }): boolean {
  return r.marketCap != null && r.marketCap >= MEGACAP_USD;
}

export function isSpeculativeThin(r: GuardRow): boolean {
  const mode = (r.scoringMode ?? "").toLowerCase();
  if (mode.includes("speculative")) return true;
  const rev = r.totalRevenue;
  const ni = r.netIncome;
  if (rev != null && rev < SPECULATIVE_REV_FLOOR && (ni == null || ni < 0)) return true;
  if (rev != null && rev < 150e6) return true; // micro revenue
  if (rev == null || rev <= 0) return true;
  return false;
}

export function isSoftPeerSet(r: GuardRow, peerSize: number): boolean {
  if (peerSize < 8) return true;
  const mode = (r.scoringMode ?? "").toLowerCase();
  if (mode.includes("speculative") || mode === "chinese") return true;
  if (r.peerGroupId && /(chinese|speculative|quantum|crypto)/i.test(r.peerGroupId)) return true;
  return false;
}

export function blendWeightsFor(r: GuardRow, peerSize: number, metricKey?: string): BlendWeights {
  if (metricKey === "expEy") return EXP_EY_BLEND;
  if (isSoftPeerSet(r, peerSize)) return SOFT_PEER_BLEND;
  if (isMegacap(r)) return MEGACAP_BLEND;
  return DEFAULT_BLEND;
}

export function blendThree(
  peer: number | null,
  sector: number | null,
  universe: number | null,
  w: BlendWeights,
): number | null {
  const parts: { v: number; wt: number }[] = [];
  if (peer != null) parts.push({ v: peer, wt: w.peer });
  if (sector != null) parts.push({ v: sector, wt: w.sector });
  if (universe != null) parts.push({ v: universe, wt: w.universe });
  if (parts.length === 0) return null;
  const tw = parts.reduce((s, p) => s + p.wt, 0);
  if (tw <= 0) return null;
  return parts.reduce((s, p) => s + p.v * p.wt, 0) / tw;
}

export type PostAdjustInput = {
  totalScore: number | null;
  qualityScore: number | null;
  safetyScore: number | null;
  safetyCoverage: number;
  style: StyleBucket;
  row: GuardRow;
};

export type PostAdjustResult = {
  totalScore: number | null;
  safetyScore: number | null;
  ranked: boolean;
  adjustments: string[];
};

/**
 * Post cross-section adjustments: require safety (or adverse prior), speculative cap,
 * China haircut, megacap quality floor.
 */
export function applyPostScoreAdjustments(input: PostAdjustInput): PostAdjustResult {
  const adj: string[] = [];
  let { totalScore, safetyScore } = input;
  const { qualityScore, safetyCoverage, row } = input;

  // Safety: too thin → adverse prior so totals never omit risk; very thin → unrank
  if (safetyScore == null) {
    if (safetyCoverage < 0.15) {
      adj.push("unranked:safety_coverage<0.15");
      return { totalScore: null, safetyScore: null, ranked: false, adjustments: adj };
    }
    safetyScore = MISSING_SAFETY_PRIOR;
    adj.push(`safety_prior=${MISSING_SAFETY_PRIOR}`);
    if (totalScore != null) {
      totalScore = totalScore * 0.80 + safetyScore * 0.20;
      adj.push("total_blend_missing_safety");
    }
  }

  if (totalScore == null) {
    return { totalScore: null, safetyScore, ranked: false, adjustments: adj };
  }

  if (isSpeculativeThin(row)) {
    if (totalScore > SPECULATIVE_SCORE_CAP) {
      totalScore = SPECULATIVE_SCORE_CAP;
      adj.push(`speculative_cap=${SPECULATIVE_SCORE_CAP}`);
    }
  }

  if (row.scoringMode === "chinese" || (row.peerGroupId && /chinese/i.test(row.peerGroupId))) {
    totalScore = totalScore * CHINA_TOTAL_MULT;
    adj.push(`china_mult=${CHINA_TOTAL_MULT}`);
  }

  // Hyper-expensive growth (P/S) — optional; mult=1.0 disables (P/S already in value family)
  const ps = row.priceToSales;
  if (
    EXPENSIVE_GROWTH_MULT < 1 &&
    ps != null &&
    ps >= EXPENSIVE_GROWTH_PS &&
    (input.style === "growth" || input.style === "garp")
  ) {
    totalScore = totalScore * EXPENSIVE_GROWTH_MULT;
    adj.push(`expensive_growth_ps_mult=${EXPENSIVE_GROWTH_MULT}`);
  }

  // Megacap absolute-quality floor: peer-expensive multiples bury franchise quality.
  // Stronger blend than v1 (was 0.82/0.18 @ Q≥55) — still a floor, not a free pass.
  if (isMegacap(row) && qualityScore != null && qualityScore >= MEGACAP_QUALITY_MIN) {
    const lifted = totalScore * MEGACAP_TOTAL_WEIGHT + qualityScore * MEGACAP_QUALITY_WEIGHT;
    if (lifted > totalScore) {
      totalScore = lifted;
      adj.push("megacap_quality_floor");
    }
  }

  totalScore = parseFloat(totalScore.toFixed(2));
  return { totalScore, safetyScore, ranked: true, adjustments: adj };
}

/** Semis / memory / steel behave cyclically for margin peaks. */
export function isExtendedCyclical(r: GuardRow): boolean {
  if (r.scoringMode && ["energy", "mining"].includes(r.scoringMode)) return true;
  return !!(
    r.peerGroupId &&
    /(energy|oil|gas|mining|metals|materials|steel|semiconductor|memory)/i.test(r.peerGroupId)
  );
}
