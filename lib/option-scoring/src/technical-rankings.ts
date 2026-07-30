export interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  rsi: number;
  rsiYesterday?: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  atr: number | null;
  macdCross: "BULLISH_CROSS" | "BEARISH_CROSS" | "BULLISH" | "BEARISH" | null;
  stoch: number | null;
  return5d: number | null;
  position52w: number | null;
  vsSpy20d: number | null;
  earningsDate: string | null;
  price?: number;
  ivCurrent?: number;
  ivPercentile?: number;
  ma200?: number | null;
  stale?: boolean;
}

export type TechnicalScore = {
  ticker: string;
  totalScore: number;
  maxPossible: number;
  rank: number;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  metricScores: Record<string, { value: number | null; weightedScore: number; rank: number }>;
  reason: string;
  // V2 optional fields — never present on V1 output, backward-compatible
  gateStatus?: "GO" | "WATCH" | "NO";
  regime?: "BULLISH" | "NEUTRAL" | "BEARISH" | null;
  componentScores?: Record<string, { score: number | null; weight: number }>;
  dataQuality?: number | null;
};

// ── Technical Scorer V2 ──────────────────────────────────────────────────────
// Self-relative: every component scored from that ticker's own DB row only.
// INVARIANCE GUARANTEE: adding/removing peers never changes any ticker's score.
// The ONLY cross-sectional operations are rank assignment and metricScores.rank
// (display-only). They are clearly separated below and do NOT touch totalScore.

// JSON shape returned by GET /api/technicals/all (Drizzle numeric → string in JSON)
type Num = string | null;
export interface TechnicalRow {
  ticker: string;
  technicalsCoverage: Num;
  rsi14: Num; rsi14Pct: Num;
  mfi14Pct: Num;
  stoch: Num; stochPct: Num;
  macdHist: Num; macdDirection: string | null;
  rsiVelocity: Num;
  volumeRatioPct: Num;
  realizedVol20d: Num;
  ivRank: Num; ivPercentile: Num;
  ivVsRealizedVol: Num;
  bbWidthPct: Num;
  priceZScore: Num;
  ma50: Num; ma200: Num;
  priceVsMa50Atr: Num; priceVsMa200Atr: Num;
  nearestSupportDistPct: Num;
  nearestResistDistPct: Num;
  priceVsVwapPct: Num;
  regime: string | null;
  fallingKnife: number | null;
  atmPutIv: Num;
  putCallVolumeRatio: Num;
  basicSkew: Num;
  ivTermStructure: Num;
  earningsDaysOut: number | null;
  // Additional fields returned by /api/technicals/all (used by Option Scorer)
  swingLow20d: Num; swingHigh20d: Num;
  swingLow50d: Num; swingHigh50d: Num;
  pivotS1: Num;
  pivotR1: Num;
  atr14: Num;
  impliedMoveWeekly: Num;
}

// ── Named weight constants (total = 1.00) ────────────────────────────────────
const W_OVERSOLD_DEPTH   = 0.25;
const W_REVERSAL_SIGNAL  = 0.20;
const W_VOLATILITY_STATE = 0.22;
const W_TREND_CONTEXT    = 0.18;
const W_OPTIONS_FLOW     = 0.10;
const W_VOLUME_CONFIRM   = 0.05;

export const TECHNICAL_SCORECARD_METRICS_V2 = [
  { key: "oversoldDepth",   label: "Oversold Depth",   weight: W_OVERSOLD_DEPTH,   description: "RSI/MFI/Stoch vs own trailing history" },
  { key: "reversalSignal",  label: "Reversal Signal",  weight: W_REVERSAL_SIGNAL,  description: "MACD direction, RSI velocity, proximity to own support" },
  { key: "volatilityState", label: "Volatility State", weight: W_VOLATILITY_STATE, description: "IV rank vs own history, IV/realized spread, BB squeeze" },
  { key: "trendContext",    label: "Trend Context",    weight: W_TREND_CONTEXT,    description: "Regime, price vs MA50 in own ATR units, vs VWAP" },
  { key: "optionsFlow",     label: "Options Flow",     weight: W_OPTIONS_FLOW,     description: "Put/call volume ratio, put skew, IV term structure" },
  { key: "volumeConfirm",   label: "Volume Confirm",   weight: W_VOLUME_CONFIRM,   description: "Volume ratio vs own 20d average history" },
] as const;

// Call-side ("sell calls into strength") variant. SAME component keys as the put
// metadata above — keys are the stable contract for weight overrides, componentScores,
// and explainers; only the scoring direction and display labels flip by side.
export type ScoreSide = "put" | "call";

export const TECHNICAL_SCORECARD_METRICS_V2_CALL = [
  { key: "oversoldDepth",   label: "Overbought Depth",   weight: W_OVERSOLD_DEPTH,   description: "RSI/MFI/Stoch high vs own trailing history (sell calls into strength)" },
  { key: "reversalSignal",  label: "Exhaustion Signal",  weight: W_REVERSAL_SIGNAL,  description: "MACD rolling over, RSI velocity fading, proximity to own resistance" },
  { key: "volatilityState", label: "Volatility State",   weight: W_VOLATILITY_STATE, description: "IV rank vs own history, IV/realized spread, BB squeeze" },
  { key: "trendContext",    label: "Trend Extension",    weight: W_TREND_CONTEXT,    description: "Regime, price stretched above MA50 in own ATR units, above VWAP" },
  { key: "optionsFlow",     label: "Call-Side Flow",     weight: W_OPTIONS_FLOW,     description: "Call-heavy volume, call wing richness (negative skew), IV term structure" },
  { key: "volumeConfirm",   label: "Volume Confirm",     weight: W_VOLUME_CONFIRM,   description: "Volume ratio vs own 20d average history" },
] as const;

export function getTechnicalScorecardMetrics(side: ScoreSide) {
  return side === "call" ? TECHNICAL_SCORECARD_METRICS_V2_CALL : TECHNICAL_SCORECARD_METRICS_V2;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pf(v: Num | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function c01(v: number): number { return Math.max(0, Math.min(1, v)); }

// ── Component scorers (self-relative, [0,1], null = excluded) ─────────────────

function scoreOversoldDepth(r: TechnicalRow): number | null {
  const parts: number[] = [];
  const rsiPct = pf(r.rsi14Pct);
  const mfiPct = pf(r.mfi14Pct);
  const stochPct = pf(r.stochPct);
  if (rsiPct != null)   parts.push(1 - rsiPct);   // lower percentile = more oversold FOR THIS STOCK
  if (mfiPct != null)   parts.push(1 - mfiPct);
  if (stochPct != null) parts.push(1 - stochPct);
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreReversalSignal(r: TechnicalRow): number | null {
  const parts: number[] = [];
  if (r.macdDirection != null) {
    parts.push(r.macdDirection === "UP" ? 1.0 : r.macdDirection === "FLAT" ? 0.5 : 0.0);
  }
  const vel = pf(r.rsiVelocity);
  if (vel != null) parts.push(c01(0.5 + vel / 10)); // ±5 RSI pts maps to [0,1]
  const dist = pf(r.nearestSupportDistPct);
  if (dist != null) parts.push(c01(1 - Math.max(0, dist - 2) / 8)); // 0-2%→1.0, ≥10%→0.0
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreVolatilityState(r: TechnicalRow): number | null {
  const parts: number[] = [];
  const ivRank = pf(r.ivRank);
  if (ivRank != null) parts.push(ivRank);                         // already [0,1] self-relative
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push(c01((ivVsRv - 0.5) / 1.0));    // 0.5→0, 1.0→0.5, 1.5→1.0
  const bbPct = pf(r.bbWidthPct);
  if (bbPct != null) parts.push(1 - bbPct);                       // squeeze = coiling = higher score
  // impliedMoveWeekly skipped: no self-relative history stored yet (see roadmap in phase report)
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreTrendContext(r: TechnicalRow): number | null {
  const parts: number[] = [];
  if (r.regime != null) {
    // BEARISH reduces to 0.3 — does NOT zero out. Regime is informational, never blocks.
    parts.push(r.regime === "BULLISH" ? 1.0 : r.regime === "BEARISH" ? 0.3 : 0.5);
  }
  const ma50Atr = pf(r.priceVsMa50Atr);
  // ATR-normalized distance is already self-relative (own volatility as unit)
  if (ma50Atr != null) parts.push(c01(-ma50Atr / 3));             // 0→0, -3→1.0
  const vwapPct = pf(r.priceVsVwapPct);
  if (vwapPct != null) parts.push(c01(0.5 - vwapPct / 10));      // -5%→1.0, 0%→0.5, +5%→0.0
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreOptionsFlow(r: TechnicalRow): number | null {
  const parts: number[] = [];
  const pc = pf(r.putCallVolumeRatio);
  if (pc != null) parts.push(c01((pc - 0.5) / 1.5));             // 0.5→0, 2.0→1.0
  const skew = pf(r.basicSkew);
  if (skew != null) parts.push(c01(skew / 15));                   // 0→0, 15% pts→1.0
  const term = pf(r.ivTermStructure);
  if (term != null) parts.push(c01((term - 0.8) / 0.4));         // 0.8→0, 1.2→1.0
  // putCallVolumeRatio and basicSkew use absolute mappings (self-relative history not yet stored)
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreVolumeConfirm(r: TechnicalRow): number | null {
  return pf(r.volumeRatioPct); // already [0,1] self-relative percentile from DB
}

// ── Call-side component scorers (mirror of the put scorers above) ─────────────
// "Sell calls into strength": overbought + momentum fading + extended above trend
// + call wing bid = ideal overwriting setup. volatilityState/volumeConfirm are
// side-neutral and shared as-is.

function scoreOverboughtDepth(r: TechnicalRow): number | null {
  const parts: number[] = [];
  const rsiPct = pf(r.rsi14Pct);
  const mfiPct = pf(r.mfi14Pct);
  const stochPct = pf(r.stochPct);
  if (rsiPct != null)   parts.push(rsiPct);   // higher percentile = more overbought FOR THIS STOCK
  if (mfiPct != null)   parts.push(mfiPct);
  if (stochPct != null) parts.push(stochPct);
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreExhaustionSignal(r: TechnicalRow): number | null {
  const parts: number[] = [];
  if (r.macdDirection != null) {
    parts.push(r.macdDirection === "DOWN" ? 1.0 : r.macdDirection === "FLAT" ? 0.5 : 0.0);
  }
  const vel = pf(r.rsiVelocity);
  if (vel != null) parts.push(c01(0.5 - vel / 10)); // momentum fading (negative velocity) = good
  const dist = pf(r.nearestResistDistPct);
  if (dist != null) parts.push(c01(1 - Math.max(0, dist - 2) / 8)); // 0-2%→1.0, ≥10%→0.0
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreTrendExtension(r: TechnicalRow): number | null {
  const parts: number[] = [];
  if (r.regime != null) {
    // BULLISH reduces to 0.3 — "don't cap a winner": strong bull regime is the worst
    // time to sell calls (AQR overwriting research). Informational, never blocks.
    parts.push(r.regime === "BEARISH" ? 1.0 : r.regime === "BULLISH" ? 0.3 : 0.5);
  }
  const ma50Atr = pf(r.priceVsMa50Atr);
  if (ma50Atr != null) parts.push(c01(ma50Atr / 3));              // 0→0, +3 ATRs above→1.0
  const vwapPct = pf(r.priceVsVwapPct);
  if (vwapPct != null) parts.push(c01(0.5 + vwapPct / 10));      // +5%→1.0, 0%→0.5, -5%→0.0
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function scoreCallFlow(r: TechnicalRow): number | null {
  const parts: number[] = [];
  const pc = pf(r.putCallVolumeRatio);
  if (pc != null) parts.push(c01(1 - (pc - 0.5) / 1.5));         // 0.5→1.0 (call-heavy), 2.0→0
  const skew = pf(r.basicSkew);
  if (skew != null) parts.push(c01(-skew / 15));                  // call wing rich (negative skew) = good
  const term = pf(r.ivTermStructure);
  if (term != null) parts.push(c01((term - 0.8) / 0.4));         // same as put side: near-dated IV rich
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

// ── Gate (per-ticker, self-relative, no macro view) ──────────────────────────
// regime=BEARISH is NEVER a gate condition — it only affects trendContext score.

function computeGateV2(r: TechnicalRow): "GO" | "WATCH" | "NO" {
  const cov = pf(r.technicalsCoverage);
  if (cov != null && cov < 0.5) return "NO";

  const rsiPct  = pf(r.rsi14Pct);
  const mfiPct  = pf(r.mfi14Pct);
  const stochPct = pf(r.stochPct);
  const vel     = pf(r.rsiVelocity);
  const zScore  = pf(r.priceZScore);
  const knife   = r.fallingKnife === 1;
  const earningsDays = r.earningsDaysOut;
  const earningsImminent = earningsDays != null && earningsDays <= 7;

  // GO: all five conditions must hold
  const goRsi        = rsiPct != null && rsiPct < 0.30;
  const goMomentum   = (mfiPct != null && mfiPct < 0.35) || (stochPct != null && stochPct < 0.35);
  const goStabilize  = r.macdDirection === "UP" || (vel != null && vel > 0);
  const goNoKnife    = !knife;
  const goNoEarnings = !earningsImminent;

  if (goRsi && goMomentum && goStabilize && goNoKnife && goNoEarnings) return "GO";

  // Would-be GO blocked by knife or earnings → WATCH (not NO)
  if (goRsi && goMomentum && goStabilize && (knife || earningsImminent)) return "WATCH";

  // WATCH: any of these approaching-signal conditions
  const watchRsi    = rsiPct != null && rsiPct < 0.40;
  const watchMacd   = r.macdDirection === "UP";
  const watchZScore = zScore != null && zScore < -1.5;
  if (watchRsi || watchMacd || watchZScore || earningsImminent) return "WATCH";

  return "NO";
}

// ── Call-side gate (mirror of computeGateV2) ─────────────────────────────────
// GO = overbought + momentum fading + no earnings + not a "rocket ship"
// (still-accelerating extreme extension — the call-side analog of fallingKnife:
// selling calls into a stock going vertical risks capping a runaway winner).

function computeGateV2Call(r: TechnicalRow): "GO" | "WATCH" | "NO" {
  const cov = pf(r.technicalsCoverage);
  if (cov != null && cov < 0.5) return "NO";

  const rsiPct  = pf(r.rsi14Pct);
  const mfiPct  = pf(r.mfi14Pct);
  const stochPct = pf(r.stochPct);
  const vel     = pf(r.rsiVelocity);
  const zScore  = pf(r.priceZScore);
  const rocket  = zScore != null && zScore > 2 && vel != null && vel > 0;
  const earningsDays = r.earningsDaysOut;
  const earningsImminent = earningsDays != null && earningsDays <= 7;

  // GO: all five conditions must hold
  const goRsi        = rsiPct != null && rsiPct > 0.70;
  const goMomentum   = (mfiPct != null && mfiPct > 0.65) || (stochPct != null && stochPct > 0.65);
  const goFading     = r.macdDirection === "DOWN" || (vel != null && vel < 0);
  const goNoRocket   = !rocket;
  const goNoEarnings = !earningsImminent;

  if (goRsi && goMomentum && goFading && goNoRocket && goNoEarnings) return "GO";

  // Would-be GO blocked by rocket or earnings → WATCH (not NO)
  if (goRsi && goMomentum && goFading && (rocket || earningsImminent)) return "WATCH";

  // WATCH: any of these approaching-signal conditions
  const watchRsi    = rsiPct != null && rsiPct > 0.60;
  const watchMacd   = r.macdDirection === "DOWN";
  const watchZScore = zScore != null && zScore > 1.5;
  if (watchRsi || watchMacd || watchZScore || earningsImminent) return "WATCH";

  return "NO";
}

// ── Reason string ─────────────────────────────────────────────────────────────

function generateReasonV2(r: TechnicalRow, signal: "GO" | "WATCH" | "NO"): string {
  const regime = r.regime ?? "NEUTRAL";
  const parts: string[] = [`${signal} · ${regime} regime`];

  const rsiPct = pf(r.rsi14Pct);
  const rsi14  = pf(r.rsi14);
  if (rsiPct != null) {
    const rsiStr = rsi14 != null ? `RSI ${rsi14.toFixed(1)} ` : "RSI ";
    parts.push(`${rsiStr}(pct ${(rsiPct * 100).toFixed(0)}%)`);
  }

  if (r.macdDirection === "UP")   parts.push("MACD turning UP");
  else if (r.macdDirection === "DOWN") parts.push("MACD DOWN");

  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null && ivVsRv > 1.1) parts.push(`IV ${ivVsRv.toFixed(1)}x realized`);

  const supportDist = pf(r.nearestSupportDistPct);
  if (supportDist != null && supportDist < 5) parts.push(`near support (${supportDist.toFixed(1)}%)`);

  if (r.fallingKnife === 1) parts.push("⚠ falling knife");

  if (r.earningsDaysOut != null && r.earningsDaysOut <= 14) {
    parts.push(`earnings ${r.earningsDaysOut}d`);
  }

  return parts.join(" · ");
}

// Call-side reason string (mirror of generateReasonV2)
function generateReasonV2Call(r: TechnicalRow, signal: "GO" | "WATCH" | "NO"): string {
  const regime = r.regime ?? "NEUTRAL";
  const parts: string[] = [`${signal} · ${regime} regime`];

  const rsiPct = pf(r.rsi14Pct);
  const rsi14  = pf(r.rsi14);
  if (rsiPct != null) {
    const rsiStr = rsi14 != null ? `RSI ${rsi14.toFixed(1)} ` : "RSI ";
    parts.push(`${rsiStr}(pct ${(rsiPct * 100).toFixed(0)}%)`);
  }

  if (r.macdDirection === "DOWN")   parts.push("MACD rolling over");
  else if (r.macdDirection === "UP") parts.push("MACD still UP");

  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null && ivVsRv > 1.1) parts.push(`IV ${ivVsRv.toFixed(1)}x realized`);

  const resistDist = pf(r.nearestResistDistPct);
  if (resistDist != null && resistDist < 5) parts.push(`near resistance (${resistDist.toFixed(1)}%)`);

  const zScore = pf(r.priceZScore);
  const vel    = pf(r.rsiVelocity);
  if (zScore != null && zScore > 2 && vel != null && vel > 0) parts.push("⚠ still accelerating");

  if (r.earningsDaysOut != null && r.earningsDaysOut <= 14) {
    parts.push(`earnings ${r.earningsDaysOut}d`);
  }

  return parts.join(" · ");
}

// ── Main V2 scorer ────────────────────────────────────────────────────────────

export function computeTechnicalRankingsV2(
  rows: TechnicalRow[],
  tierMap: Record<string, 1 | 2 | 3> = {},
  technicalWeights?: Record<string, number>,
  side: ScoreSide = "put",
): TechnicalScore[] {
  if (rows.length === 0) return [];

  // Component keys are identical across sides (stable contract for weight
  // overrides / componentScores / explainers); only scoreFn direction flips.
  const defaultComponents = side === "call"
    ? ([
        { key: "oversoldDepth",   weight: W_OVERSOLD_DEPTH,   scoreFn: scoreOverboughtDepth },
        { key: "reversalSignal",  weight: W_REVERSAL_SIGNAL,  scoreFn: scoreExhaustionSignal },
        { key: "volatilityState", weight: W_VOLATILITY_STATE, scoreFn: scoreVolatilityState },
        { key: "trendContext",    weight: W_TREND_CONTEXT,    scoreFn: scoreTrendExtension },
        { key: "optionsFlow",     weight: W_OPTIONS_FLOW,     scoreFn: scoreCallFlow },
        { key: "volumeConfirm",   weight: W_VOLUME_CONFIRM,   scoreFn: scoreVolumeConfirm },
      ] as const)
    : ([
        { key: "oversoldDepth",   weight: W_OVERSOLD_DEPTH,   scoreFn: scoreOversoldDepth },
        { key: "reversalSignal",  weight: W_REVERSAL_SIGNAL,  scoreFn: scoreReversalSignal },
        { key: "volatilityState", weight: W_VOLATILITY_STATE, scoreFn: scoreVolatilityState },
        { key: "trendContext",    weight: W_TREND_CONTEXT,    scoreFn: scoreTrendContext },
        { key: "optionsFlow",     weight: W_OPTIONS_FLOW,     scoreFn: scoreOptionsFlow },
        { key: "volumeConfirm",   weight: W_VOLUME_CONFIRM,   scoreFn: scoreVolumeConfirm },
      ] as const);

  const COMPONENTS = defaultComponents.map(c => ({
    ...c,
    weight: technicalWeights?.[c.key] ?? c.weight,
  }));

  // ── SELF-RELATIVE SCORE COMPUTATION ────────────────────────────────────────
  // Each ticker's score depends ONLY on its own row. No cross-ticker data used here.
  const perTicker = rows.map(row => {
    const compScores = COMPONENTS.map(c => ({ key: c.key, weight: c.weight, score: c.scoreFn(row) }));
    const available  = compScores.filter(c => c.score !== null) as { key: string; weight: number; score: number }[];

    let totalScore = 0;
    if (available.length > 0) {
      const availWeight  = available.reduce((s, c) => s + c.weight, 0);
      const weightedSum  = available.reduce((s, c) => s + c.score * c.weight, 0);
      // Renormalize over available weights → score ∈ [0,100]. maxPossible = 100 always.
      totalScore = (weightedSum / availWeight) * 100;
    }

    return {
      row,
      compScores,
      available,
      totalScore,
      signal:  side === "call" ? computeGateV2Call(row) : computeGateV2(row),
      tier:    tierMap[row.ticker.toUpperCase()] ?? (1 as 1 | 2 | 3),
      regime:  (row.regime ?? "NEUTRAL") as "BULLISH" | "NEUTRAL" | "BEARISH",
      coverage: pf(row.technicalsCoverage),
    };
  });

  // ── DISPLAY-ONLY: rank assignment (does not affect any score) ──────────────
  const sorted = [...perTicker].sort((a, b) => b.totalScore - a.totalScore);

  return sorted.map(({ row, compScores, totalScore, signal, tier, regime, coverage }, rankIdx) => {
    const rank = rankIdx + 1;
    const ms: TechnicalScore["metricScores"] = {};
    const repValue: Record<string, number | null> = {
      oversoldDepth:   pf(row.rsi14),
      reversalSignal:  pf(row.rsiVelocity),
      volatilityState: pf(row.ivVsRealizedVol),
      trendContext:    pf(row.priceVsMa50Atr),
      optionsFlow:     pf(row.putCallVolumeRatio),
      volumeConfirm:   pf(row.volumeRatioPct),
    };
    for (const c of compScores) {
      ms[c.key] = {
        value:         repValue[c.key] ?? null,
        weightedScore: c.score != null ? parseFloat((c.score * c.weight).toFixed(4)) : 0,
        rank,          // overall rank — component-level rank is display-only in V2
      };
    }
    return {
      ticker:      row.ticker,
      totalScore:  parseFloat(totalScore.toFixed(2)),
      maxPossible: 100,
      rank,
      signal,
      tier,
      metricScores: ms,
      reason:       side === "call" ? generateReasonV2Call(row, signal) : generateReasonV2(row, signal),
      // V2 optional fields
      gateStatus:   signal,
      regime,
      componentScores: Object.fromEntries(
        compScores.map(c => [c.key, { score: c.score, weight: c.weight }])
      ),
      dataQuality: coverage,
    };
  });
}

// ── Component breakdowns for the "Why" panel ─────────────────────────────────
// Mirrors each scoreXxx() function above exactly, but returns the intermediate
// [0,1] sub-scores instead of just the averaged result, so the UI can show the
// literal inputs that produced the component score rather than a black box.

export interface ComponentPart { label: string; raw: string; score: number; }

function fmtPct01(v: number): string { return `${(v * 100).toFixed(0)}%`; }

export function explainOversoldDepth(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const rsiPct = pf(r.rsi14Pct), mfiPct = pf(r.mfi14Pct), stochPct = pf(r.stochPct);
  if (rsiPct != null)   parts.push({ label: "RSI percentile (own history)",   raw: fmtPct01(rsiPct),   score: 1 - rsiPct });
  if (mfiPct != null)   parts.push({ label: "MFI percentile (own history)",   raw: fmtPct01(mfiPct),   score: 1 - mfiPct });
  if (stochPct != null) parts.push({ label: "Stochastic percentile (own history)", raw: fmtPct01(stochPct), score: 1 - stochPct });
  return parts;
}

export function explainReversalSignal(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  if (r.macdDirection != null) {
    const s = r.macdDirection === "UP" ? 1.0 : r.macdDirection === "FLAT" ? 0.5 : 0.0;
    parts.push({ label: "MACD direction", raw: r.macdDirection, score: s });
  }
  const vel = pf(r.rsiVelocity);
  if (vel != null) parts.push({ label: "RSI velocity (5d Δ)", raw: vel.toFixed(1), score: c01(0.5 + vel / 10) });
  const dist = pf(r.nearestSupportDistPct);
  if (dist != null) parts.push({ label: "Distance to nearest support", raw: `${dist.toFixed(1)}%`, score: c01(1 - Math.max(0, dist - 2) / 8) });
  return parts;
}

export function explainVolatilityState(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const ivRank = pf(r.ivRank);
  if (ivRank != null) parts.push({ label: "IV rank (own history)", raw: fmtPct01(ivRank), score: ivRank });
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push({ label: "IV vs realized vol", raw: `${ivVsRv.toFixed(2)}x`, score: c01((ivVsRv - 0.5) / 1.0) });
  const bbPct = pf(r.bbWidthPct);
  if (bbPct != null) parts.push({ label: "Bollinger Band width percentile", raw: fmtPct01(bbPct), score: 1 - bbPct });
  return parts;
}

export function explainTrendContext(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  if (r.regime != null) {
    const s = r.regime === "BULLISH" ? 1.0 : r.regime === "BEARISH" ? 0.3 : 0.5;
    parts.push({ label: "Macro regime", raw: r.regime, score: s });
  }
  const ma50Atr = pf(r.priceVsMa50Atr);
  if (ma50Atr != null) parts.push({ label: "Price vs MA50 (ATR units)", raw: `${ma50Atr.toFixed(2)} ATR`, score: c01(-ma50Atr / 3) });
  const vwapPct = pf(r.priceVsVwapPct);
  if (vwapPct != null) parts.push({ label: "Price vs VWAP", raw: `${vwapPct.toFixed(1)}%`, score: c01(0.5 - vwapPct / 10) });
  return parts;
}

export function explainOptionsFlow(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const pc = pf(r.putCallVolumeRatio);
  if (pc != null) parts.push({ label: "Put/Call volume ratio", raw: pc.toFixed(2), score: c01((pc - 0.5) / 1.5) });
  const skew = pf(r.basicSkew);
  if (skew != null) parts.push({ label: "Put skew", raw: `${skew.toFixed(1)}pts`, score: c01(skew / 15) });
  const term = pf(r.ivTermStructure);
  if (term != null) parts.push({ label: "IV term structure", raw: term.toFixed(2), score: c01((term - 0.8) / 0.4) });
  return parts;
}

export function explainVolumeConfirm(r: TechnicalRow): ComponentPart[] {
  const v = pf(r.volumeRatioPct);
  return v != null ? [{ label: "Volume ratio percentile (own history)", raw: fmtPct01(v), score: v }] : [];
}

export const COMPONENT_EXPLAINERS: Record<string, (r: TechnicalRow) => ComponentPart[]> = {
  oversoldDepth:   explainOversoldDepth,
  reversalSignal:  explainReversalSignal,
  volatilityState: explainVolatilityState,
  trendContext:    explainTrendContext,
  optionsFlow:     explainOptionsFlow,
  volumeConfirm:   explainVolumeConfirm,
};

// ── Call-side explainers (mirror the call scorers exactly) ───────────────────

export function explainOverboughtDepth(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const rsiPct = pf(r.rsi14Pct), mfiPct = pf(r.mfi14Pct), stochPct = pf(r.stochPct);
  if (rsiPct != null)   parts.push({ label: "RSI percentile (own history)",   raw: fmtPct01(rsiPct),   score: rsiPct });
  if (mfiPct != null)   parts.push({ label: "MFI percentile (own history)",   raw: fmtPct01(mfiPct),   score: mfiPct });
  if (stochPct != null) parts.push({ label: "Stochastic percentile (own history)", raw: fmtPct01(stochPct), score: stochPct });
  return parts;
}

export function explainExhaustionSignal(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  if (r.macdDirection != null) {
    const s = r.macdDirection === "DOWN" ? 1.0 : r.macdDirection === "FLAT" ? 0.5 : 0.0;
    parts.push({ label: "MACD direction (rolling over = good)", raw: r.macdDirection, score: s });
  }
  const vel = pf(r.rsiVelocity);
  if (vel != null) parts.push({ label: "RSI velocity (5d Δ, fading = good)", raw: vel.toFixed(1), score: c01(0.5 - vel / 10) });
  const dist = pf(r.nearestResistDistPct);
  if (dist != null) parts.push({ label: "Distance to nearest resistance", raw: `${dist.toFixed(1)}%`, score: c01(1 - Math.max(0, dist - 2) / 8) });
  return parts;
}

export function explainTrendExtension(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  if (r.regime != null) {
    const s = r.regime === "BEARISH" ? 1.0 : r.regime === "BULLISH" ? 0.3 : 0.5;
    parts.push({ label: "Macro regime (bull = don't cap a winner)", raw: r.regime, score: s });
  }
  const ma50Atr = pf(r.priceVsMa50Atr);
  if (ma50Atr != null) parts.push({ label: "Price vs MA50 (ATR units, extended = good)", raw: `${ma50Atr.toFixed(2)} ATR`, score: c01(ma50Atr / 3) });
  const vwapPct = pf(r.priceVsVwapPct);
  if (vwapPct != null) parts.push({ label: "Price vs VWAP (above = good)", raw: `${vwapPct.toFixed(1)}%`, score: c01(0.5 + vwapPct / 10) });
  return parts;
}

export function explainCallFlow(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const pc = pf(r.putCallVolumeRatio);
  if (pc != null) parts.push({ label: "Put/Call volume ratio (call-heavy = good)", raw: pc.toFixed(2), score: c01(1 - (pc - 0.5) / 1.5) });
  const skew = pf(r.basicSkew);
  if (skew != null) parts.push({ label: "Skew (call wing rich = good)", raw: `${skew.toFixed(1)}pts`, score: c01(-skew / 15) });
  const term = pf(r.ivTermStructure);
  if (term != null) parts.push({ label: "IV term structure", raw: term.toFixed(2), score: c01((term - 0.8) / 0.4) });
  return parts;
}

export const COMPONENT_EXPLAINERS_CALL: Record<string, (r: TechnicalRow) => ComponentPart[]> = {
  oversoldDepth:   explainOverboughtDepth,
  reversalSignal:  explainExhaustionSignal,
  volatilityState: explainVolatilityState,
  trendContext:    explainTrendExtension,
  optionsFlow:     explainCallFlow,
  volumeConfirm:   explainVolumeConfirm,
};

export function getComponentExplainers(side: ScoreSide) {
  return side === "call" ? COMPONENT_EXPLAINERS_CALL : COMPONENT_EXPLAINERS;
}

