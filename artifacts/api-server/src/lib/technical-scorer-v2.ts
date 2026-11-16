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
  // A25: do not use RV-proxy ivRank (wrong-signed for option richness). Prefer IV/RV;
  // fall back to ATM IV level. BB squeeze dropped (lab: no edge).
  const parts: number[] = [];
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push(c01((ivVsRv - 0.5) / 1.0));
  const atmIv = pf(r.atmPutIv);
  if (atmIv != null && atmIv > 0) parts.push(c01((atmIv - 10) / 50));
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreTrendContext(r: TickerTechnicalsRow): number | null {
  // FACTOR_MAP T3: Trend health = regime + price vs MA200 (ATR units) + MA50 slope.
  // Previously used -priceVsMa50Atr and -vwapPct (mean-reversion dip parts that inverted BULLISH regime!).
  const parts: number[] = [];
  if (r.regime != null) {
    parts.push(r.regime === "BULLISH" ? 1.0 : r.regime === "BEARISH" ? 0.25 : 0.5);
  }
  const ma200Atr = pf(r.priceVsMa200Atr);
  if (ma200Atr != null) parts.push(c01(0.5 + ma200Atr / 8)); // -4 ATR -> 0, 0 -> 0.5, +4 ATR -> 1.0
  const slope = pf(r.ma50Slope10d);
  if (slope != null) parts.push(c01(0.5 + slope / 4));       // positive 10d MA50 slope confirms trend
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

const COMPONENT_FNS = [
  { key: "oversoldDepth",   defaultWeight: W_OVERSOLD_DEPTH,   scoreFn: scoreOversoldDepth },
  { key: "reversalSignal",  defaultWeight: W_REVERSAL_SIGNAL,  scoreFn: scoreReversalSignal },
  { key: "volatilityState", defaultWeight: W_VOLATILITY_STATE, scoreFn: scoreVolatilityState },
  { key: "trendContext",    defaultWeight: W_TREND_CONTEXT,    scoreFn: scoreTrendContext },
  { key: "optionsFlow",     defaultWeight: W_OPTIONS_FLOW,     scoreFn: scoreOptionsFlow },
  { key: "volumeConfirm",   defaultWeight: W_VOLUME_CONFIRM,   scoreFn: scoreVolumeConfirm },
] as const;

export type TechScoreWeights = Partial<Record<(typeof COMPONENT_FNS)[number]["key"], number>>;

/** Self-relative V2 technical score [0,100] from a DB row.
 *  Optional `weights` from scorecard_params champion (tech-1.0.0 seeds match defaults). */
export function scoreTechnicalRowV2(
  row: TickerTechnicalsRow,
  weights?: TechScoreWeights,
): number | null {
  const compScores = COMPONENT_FNS.map((c) => ({
    weight: weights?.[c.key] ?? c.defaultWeight,
    score: c.scoreFn(row),
  }));
  const available = compScores.filter(c => c.score !== null) as { weight: number; score: number }[];
  if (available.length === 0) return null;
  const availWeight = available.reduce((s, c) => s + c.weight, 0);
  const weightedSum = available.reduce((s, c) => s + c.score * c.weight, 0);
  return parseFloat(((weightedSum / availWeight) * 100).toFixed(2));
}
