import type { TickerTechnicalsRow } from "@workspace/db";

type Num = string | null | undefined;

const W_OVERSOLD_DEPTH   = 0.25;
const W_REVERSAL_SIGNAL  = 0.20;
const W_VOLATILITY_STATE = 0.22;
const W_TREND_CONTEXT    = 0.18;
const W_OPTIONS_FLOW     = 0.10;
const W_VOLUME_CONFIRM   = 0.05;

function pf(v: Num): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}

function c01(v: number): number { return Math.max(0, Math.min(1, v)); }

function scoreOversoldDepth(r: TickerTechnicalsRow): number | null {
  const parts: number[] = [];
  const rsiPct = pf(r.rsi14Pct);
  const mfiPct = pf(r.mfi14Pct);
  const stochPct = pf(r.stochPct);
  if (rsiPct != null)   parts.push(1 - rsiPct);
  if (mfiPct != null)   parts.push(1 - mfiPct);
  if (stochPct != null) parts.push(1 - stochPct);
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreReversalSignal(r: TickerTechnicalsRow): number | null {
  const parts: number[] = [];
  if (r.macdDirection != null) {
    parts.push(r.macdDirection === "UP" ? 1.0 : r.macdDirection === "FLAT" ? 0.5 : 0.0);
  }
  const vel = pf(r.rsiVelocity);
  if (vel != null) parts.push(c01(0.5 + vel / 10));
  const dist = pf(r.nearestSupportDistPct);
  if (dist != null) parts.push(c01(1 - Math.max(0, dist - 2) / 8));
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreVolatilityState(r: TickerTechnicalsRow): number | null {
  const parts: number[] = [];
  const ivRank = pf(r.ivRank);
  if (ivRank != null) parts.push(ivRank);
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push(c01((ivVsRv - 0.5) / 1.0));
  const bbPct = pf(r.bbWidthPct);
  if (bbPct != null) parts.push(1 - bbPct);
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreTrendContext(r: TickerTechnicalsRow): number | null {
  const parts: number[] = [];
  if (r.regime != null) {
    parts.push(r.regime === "BULLISH" ? 1.0 : r.regime === "BEARISH" ? 0.3 : 0.5);
  }
  const ma50Atr = pf(r.priceVsMa50Atr);
  if (ma50Atr != null) parts.push(c01(-ma50Atr / 3));
  const vwapPct = pf(r.priceVsVwapPct);
  if (vwapPct != null) parts.push(c01(0.5 - vwapPct / 10));
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreOptionsFlow(r: TickerTechnicalsRow): number | null {
  const parts: number[] = [];
  const pc = pf(r.putCallVolumeRatio);
  if (pc != null) parts.push(c01((pc - 0.5) / 1.5));
  const skew = pf(r.basicSkew);
  if (skew != null) parts.push(c01(skew / 15));
  const term = pf(r.ivTermStructure);
  if (term != null) parts.push(c01((term - 0.8) / 0.4));
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreVolumeConfirm(r: TickerTechnicalsRow): number | null {
  return pf(r.volumeRatioPct);
}

const COMPONENTS = [
  { weight: W_OVERSOLD_DEPTH,   scoreFn: scoreOversoldDepth },
  { weight: W_REVERSAL_SIGNAL,  scoreFn: scoreReversalSignal },
  { weight: W_VOLATILITY_STATE, scoreFn: scoreVolatilityState },
  { weight: W_TREND_CONTEXT,    scoreFn: scoreTrendContext },
  { weight: W_OPTIONS_FLOW,     scoreFn: scoreOptionsFlow },
  { weight: W_VOLUME_CONFIRM,   scoreFn: scoreVolumeConfirm },
] as const;

/** Self-relative V2 technical score [0,100] from a DB row — matches client computeTechnicalRankingsV2. */
export function scoreTechnicalRowV2(row: TickerTechnicalsRow): number | null {
  const compScores = COMPONENTS.map(c => ({ weight: c.weight, score: c.scoreFn(row) }));
  const available = compScores.filter(c => c.score !== null) as { weight: number; score: number }[];
  if (available.length === 0) return null;
  const availWeight = available.reduce((s, c) => s + c.weight, 0);
  const weightedSum = available.reduce((s, c) => s + c.score * c.weight, 0);
  return parseFloat(((weightedSum / availWeight) * 100).toFixed(2));
}
