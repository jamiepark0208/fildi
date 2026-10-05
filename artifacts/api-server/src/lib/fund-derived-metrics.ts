/**
 * Pure derived fundamental metrics for fund-score-v2.
 * No DB imports — unit-testable.
 */

export function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** (totalDebt - cash) / ebitda. Null if ebitda ≤ 0. Lower is better. */
export function netDebtToEbitda(
  totalDebt: number | null,
  cash: number | null,
  ebitda: number | null,
): number | null {
  if (totalDebt == null || ebitda == null || ebitda <= 0) return null;
  const c = cash ?? 0;
  return (totalDebt - c) / ebitda;
}

/** Gross profitability = grossProfit / totalAssets. */
export function grossProfitability(
  grossProfit: number | null,
  totalAssets: number | null,
): number | null {
  if (grossProfit == null || totalAssets == null || totalAssets <= 0) return null;
  return grossProfit / totalAssets;
}

/** Accruals = (netIncome - annualOcf) / totalAssets. Higher = worse earnings quality. */
export function accrualsRatio(
  netIncome: number | null,
  annualOcf: number | null,
  totalAssets: number | null,
): number | null {
  if (netIncome == null || annualOcf == null || totalAssets == null || totalAssets <= 0) return null;
  return (netIncome - annualOcf) / totalAssets;
}

/**
 * Mean of last N EPS surprise percentages, winsorized to ±50pp.
 * surprisePct values are already in percent units (e.g. 5.2 = +5.2%).
 */
export function avgEpsSurprise(
  surprisePcts: (number | null | undefined)[],
  maxN = 4,
  clipAbs = 50,
): number | null {
  const vals = surprisePcts
    .map((v) => (v == null || !Number.isFinite(v) ? null : Math.max(-clipAbs, Math.min(clipAbs, v))))
    .filter((v): v is number => v !== null)
    .slice(0, maxN);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export type FScoreInputs = {
  netIncome: number | null;
  annualOcf: number | null;
  accruals: number | null;
  roa: number | null; // current; prior optional via roaPrior
  roaPrior: number | null;
  grossMargin: number | null;
  grossMarginPrior: number | null;
  currentRatio: number | null;
  currentRatioPrior: number | null;
  debtToEquity: number | null;
  debtToEquityPrior: number | null;
  sharesOutstanding: number | null;
  sharesOutstandingPrior: number | null;
  assetTurnover: number | null; // revenue / assets
  assetTurnoverPrior: number | null;
};

export type FScoreResult = {
  score: number | null; // 0–9 scaled by answered components when partial
  rawPoints: number;
  answered: number;
  coverage: number; // answered / 9
};

/**
 * Piotroski-style F-Score (0–9). Missing components skipped; score is
 * rawPoints scaled to 0–9 by (raw/answered)*9 when partial, null if answered=0.
 */
export function piotroskiFScore(i: FScoreInputs): FScoreResult {
  const checks: (boolean | null)[] = [
    i.netIncome != null ? i.netIncome > 0 : null,
    i.annualOcf != null ? i.annualOcf > 0 : null,
    i.accruals != null ? i.accruals < 0 : null, // OCF > NI
    i.roa != null && i.roaPrior != null ? i.roa > i.roaPrior : null,
    i.grossMargin != null && i.grossMarginPrior != null ? i.grossMargin > i.grossMarginPrior : null,
    i.currentRatio != null && i.currentRatioPrior != null ? i.currentRatio > i.currentRatioPrior : null,
    i.debtToEquity != null && i.debtToEquityPrior != null ? i.debtToEquity < i.debtToEquityPrior : null,
    i.sharesOutstanding != null && i.sharesOutstandingPrior != null
      ? i.sharesOutstanding <= i.sharesOutstandingPrior
      : null,
    i.assetTurnover != null && i.assetTurnoverPrior != null
      ? i.assetTurnover > i.assetTurnoverPrior
      : null,
  ];
  let answered = 0;
  let rawPoints = 0;
  for (const c of checks) {
    if (c === null) continue;
    answered++;
    if (c) rawPoints++;
  }
  if (answered === 0) return { score: null, rawPoints: 0, answered: 0, coverage: 0 };
  const score = (rawPoints / answered) * 9;
  return { score, rawPoints, answered, coverage: answered / 9 };
}

/** Short-history own-score: n≥3 percentile; n=2 trend; else null (peer-only). */
export function ownHistoryNorm(
  current: number | null,
  history: number[],
  higherIsBetter: boolean,
): number | null {
  if (current == null || !Number.isFinite(current)) return null;
  const hist = history.filter((v) => Number.isFinite(v));
  if (hist.length >= 3) {
    const sorted = [...hist].sort((a, b) => a - b);
    let below = 0;
    for (const v of sorted) {
      if (v <= current) below++;
    }
    const pct = below / sorted.length;
    return higherIsBetter ? pct : 1 - pct;
  }
  if (hist.length === 2) {
    const baseline = hist[hist.length - 1]!; // most recent prior year (chronological)
    if (!Number.isFinite(baseline)) return 0.5;
    if (baseline === 0) {
      const delta = current - baseline;
      if (Math.abs(delta) < 1e-9) return 0.5;
      const better = higherIsBetter ? delta > 0 : delta < 0;
      return better ? 0.75 : 0.25;
    }
    const chg = (current - baseline) / Math.abs(baseline);
    if (Math.abs(chg) <= 0.05) return 0.5;
    const better = higherIsBetter ? chg > 0 : chg < 0;
    return better ? 0.75 : 0.25;
  }
  return null;
}

export function blendPeerHist(
  peerNorm: number | null,
  histNorm: number | null,
  peerW = 0.7,
  histW = 0.3,
): number | null {
  if (peerNorm == null && histNorm == null) return null;
  if (histNorm == null) return peerNorm;
  if (peerNorm == null) return histNorm;
  return peerNorm * peerW + histNorm * histW;
}
