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
  /** ISO timestamp from ticker_technicals.technicals_last_fetched (API enrichment). */
  technicalsLastFetched?: string | null;
  /** Optional enrichment from gold + registry (API /technicals/all). */
  peerGroupId?: string | null;
  /** (analystTarget − price) / price from gold TP + last close. */
  analystUpside?: number | null;
  /** 20d return vs SPY (pp). Negative = relative weakness. */
  vsSpy20d?: number | null;
  /**
   * Preferred IV rank [0,1]: hist ATM IV percentile when ≥10 snapshots,
   * else cross-sectional ATM IV percentile among scored universe (set at score time).
   */
  ivRankEffective?: number | null;
  /** Yahoo shortRatio (days-to-cover). High = crowded short. */
  shortRatio?: number | null;
}

// ── Named weight constants (total = 1.00) — A155: 6-comp champion (tech-1.0.0)
// relativePressure / analystUpside stay in the metric list at weight 0 (display-only; S042/S042b).
const W_OVERSOLD_DEPTH   = 0.25;
const W_REVERSAL_SIGNAL  = 0.20;
const W_VOLATILITY_STATE = 0.22;
const W_TREND_CONTEXT    = 0.18;
const W_OPTIONS_FLOW     = 0.10;
const W_VOLUME_CONFIRM   = 0.05;
const W_RELATIVE_PRESSURE = 0; // display-only (A155 / S042b)
const W_ANALYST_UPSIDE   = 0; // display-only (A155 / S042)

/** Keys that appear on the scorecard but do not enter totalScore. */
export const TECHNICAL_DISPLAY_ONLY_KEYS = ["relativePressure", "analystUpside"] as const;

export const TECHNICAL_SCORECARD_METRICS_V2 = [
  { key: "oversoldDepth",   label: "Oversold Depth",   weight: W_OVERSOLD_DEPTH,   description: "RSI/MFI/Stoch vs own trailing history (sector-dampened)" },
  { key: "reversalSignal",  label: "Reversal Signal",  weight: W_REVERSAL_SIGNAL,  description: "MACD direction, RSI velocity, proximity to own support" },
  { key: "volatilityState", label: "Volatility State", weight: W_VOLATILITY_STATE, description: "Hist/cross ATM IV rank + IV/RV premium + BB squeeze" },
  { key: "trendContext",    label: "Trend Context",    weight: W_TREND_CONTEXT,    description: "Regime, price vs MA50 in own ATR units, vs VWAP" },
  { key: "optionsFlow",     label: "Options Flow",     weight: W_OPTIONS_FLOW,     description: "Put/call volume ratio, put skew, IV term structure" },
  { key: "volumeConfirm",   label: "Volume Confirm",   weight: W_VOLUME_CONFIRM,   description: "Volume ratio vs own 20d average history" },
  { key: "relativePressure",label: "Relative Pressure",weight: W_RELATIVE_PRESSURE, description: "Display only (A155) — price z + 20d vs SPY; not in total" },
  { key: "analystUpside",   label: "Analyst Upside",   weight: W_ANALYST_UPSIDE,   description: "Display only (A155) — consensus target vs spot; not in total" },
] as const;

// Call-side ("sell calls into strength") variant. SAME component keys as the put
// metadata above — keys are the stable contract for weight overrides, componentScores,
// and explainers; only the scoring direction and display labels flip by side.
export type ScoreSide = "put" | "call";

export const TECHNICAL_SCORECARD_METRICS_V2_CALL = [
  { key: "oversoldDepth",   label: "Overbought Depth",   weight: W_OVERSOLD_DEPTH,   description: "RSI/MFI/Stoch high vs own trailing history (sell calls into strength)" },
  { key: "reversalSignal",  label: "Exhaustion Signal",  weight: W_REVERSAL_SIGNAL,  description: "MACD rolling over, RSI velocity fading, proximity to own resistance" },
  { key: "volatilityState", label: "Volatility State",   weight: W_VOLATILITY_STATE, description: "Hist/cross ATM IV rank + IV/RV premium + BB squeeze" },
  { key: "trendContext",    label: "Trend Extension",    weight: W_TREND_CONTEXT,    description: "Regime, price stretched above MA50 in own ATR units, above VWAP" },
  { key: "optionsFlow",     label: "Call-Side Flow",     weight: W_OPTIONS_FLOW,     description: "Call-heavy volume, call wing richness (negative skew), IV term structure" },
  { key: "volumeConfirm",   label: "Volume Confirm",     weight: W_VOLUME_CONFIRM,   description: "Volume ratio vs own 20d average history" },
  { key: "relativePressure",label: "Relative Extension", weight: W_RELATIVE_PRESSURE, description: "Display only (A155) — price z + 20d vs SPY; not in total" },
  { key: "analystUpside",   label: "Above Target",       weight: W_ANALYST_UPSIDE,   description: "Display only (A155) — price vs consensus target; not in total" },
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
  // Prefer hist/cross ATM IV rank when available; fall back to absolute ATM IV level.
  const ivRankEff = r.ivRankEffective != null && Number.isFinite(r.ivRankEffective)
    ? r.ivRankEffective
    : null;
  if (ivRankEff != null) {
    parts.push(c01(ivRankEff));
  } else {
    const atmIv = pf(r.atmPutIv);
    if (atmIv != null && atmIv > 0) {
      parts.push(c01((atmIv - 10) / 50)); // 10%→0, 60%→1
    }
  }
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push(c01((ivVsRv - 0.5) / 1.0));    // 0.5→0, 1.0→0.5, 1.5→1.0
  // A25 O2: BB squeeze dropped — lab found no edge on VRP / breaches.
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

/** Put lens: consensus upside supports selling puts. Call lens: price above target favors overwriting. */
function scoreAnalystUpside(r: TechnicalRow, side: ScoreSide): number | null {
  const u = r.analystUpside;
  if (u == null || !Number.isFinite(u)) return null;
  // Reject absurd targets. Soft curve so 30% upside ≈ 0.75, 50% ≈ 0.90 — not a binary crown.
  if (Math.abs(u) > 0.75) return null;
  const clipped = Math.max(-0.5, Math.min(0.5, u));
  // tanh-ish soft: score = 0.5 + 0.5 * tanh(clipped / 0.28)
  const soft = 0.5 + 0.5 * Math.tanh(clipped / 0.28);
  if (side === "call") return c01(1 - soft);
  return c01(soft);
}

/** Relative weakness (put) / extension (call): price z-score + 20d vs SPY. */
function scoreRelativePressure(r: TechnicalRow, side: ScoreSide): number | null {
  const parts: number[] = [];
  const z = pf(r.priceZScore);
  const vs = r.vsSpy20d != null && Number.isFinite(r.vsSpy20d) ? r.vsSpy20d : null;
  if (side === "call") {
    if (z != null) parts.push(c01((z + 0.5) / 2.5));
    if (vs != null) parts.push(c01((vs + 2) / 10));
  } else {
    if (z != null) parts.push(c01((-z + 0.5) / 2.5));
    if (vs != null) parts.push(c01((-vs + 2) / 10));
  }
  return parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

/**
 * Short-interest haircut on total score (both sides).
 * Days-to-cover: ≤4d → 0%, 9d → 20% (p90≈6.2, p95≈7.9). Crowded shorts = risk.
 */
export function shortInterestHaircut(shortRatio: number | null | undefined): number {
  if (shortRatio == null || !Number.isFinite(shortRatio) || shortRatio <= 4) return 0;
  return Math.min(0.20, ((shortRatio - 4) / 5) * 0.20);
}

/**
 * Speculative peer-group haircut. Extra when consensus TP is missing/rejected —
 * stops biotech/spec names climbing boards on oversold alone.
 */
export function speculativeHaircut(
  peerGroupId: string | null | undefined,
  analystUpside: number | null | undefined,
): number {
  if (!peerGroupId) return 0;
  const speculative =
    peerGroupId.includes("speculative") ||
    peerGroupId.includes("crypto_") ||
    peerGroupId.endsWith(".space_aerospace_tech");
  if (!speculative) return 0;
  const tpMissing =
    analystUpside == null ||
    !Number.isFinite(analystUpside) ||
    Math.abs(analystUpside) > 0.75;
  return tpMissing ? 0.12 : 0.06;
}

/** Mild haircut when gold TP is missing or rejected as absurd — all peer groups. */
export function missingTpHaircut(analystUpside: number | null | undefined): number {
  if (analystUpside == null || !Number.isFinite(analystUpside)) return 0.04;
  if (Math.abs(analystUpside) > 0.75) return 0.04;
  return 0;
}

function scoreVolumeConfirm(r: TechnicalRow): number | null {
  return pf(r.volumeRatioPct);
}

/**
 * Soft sector dampening: when a peer group's median oversold/overbought depth is
 * extreme, haircut members that are also extreme — stops one sector dump from
 * owning the entire leaderboard. Intentionally cross-sectional (breaks pure
 * invariance when peerGroupId is present).
 * v4: tighter — med 0.65→0%, 0.90→45% haircut; applies from depth ≥0.55.
 */
export function dampenDepthByPeerGroup(
  depthScores: (number | null)[],
  peerGroupIds: (string | null | undefined)[],
): (number | null)[] {
  const byGroup = new Map<string, number[]>();
  peerGroupIds.forEach((gid, i) => {
    const s = depthScores[i];
    if (!gid || s == null) return;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(s);
  });
  const medianOf = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const haircutByGroup = new Map<string, number>();
  for (const [gid, vals] of byGroup) {
    if (vals.length < 3) continue;
    const med = medianOf(vals);
    if (med <= 0.65) continue;
    // med 0.65→0% haircut, 0.90→45% haircut
    const h = Math.min(0.45, ((med - 0.65) / 0.25) * 0.45);
    haircutByGroup.set(gid, h);
  }
  if (haircutByGroup.size === 0) return depthScores;
  return depthScores.map((s, i) => {
    if (s == null || s < 0.55) return s;
    const gid = peerGroupIds[i];
    if (!gid || !haircutByGroup.has(gid)) return s;
    return s * (1 - haircutByGroup.get(gid)!);
  });
}

/**
 * Soft-cap finals by sector prefix AND by full peer group:
 * - sector ≤25% of top-N
 * - single peer group ≤15% of top-N (stops midstream triplet etc.)
 */
export function softCapPeerGroupInTopN(
  scores: { peerGroupId: string | null | undefined; totalScore: number }[],
  topN = 20,
  maxShare = 0.25,
): number[] {
  const sectorOf = (gid: string | null | undefined) =>
    gid ? gid.split(".")[0]! : null;
  const indexed = scores.map((s, i) => ({
    sector: sectorOf(s.peerGroupId),
    peerGroupId: s.peerGroupId ?? null,
    totalScore: s.totalScore,
    i,
  }));
  const sorted = [...indexed].sort((a, b) => b.totalScore - a.totalScore);
  const top = sorted.slice(0, topN);

  const maxSector = Math.max(1, Math.floor(topN * maxShare));
  const maxPeer = Math.max(1, Math.floor(topN * 0.15)); // ≤3 of 20

  const countSector = new Map<string, number>();
  const countPeer = new Map<string, number>();
  for (const t of top) {
    if (t.sector) countSector.set(t.sector, (countSector.get(t.sector) ?? 0) + 1);
    if (t.peerGroupId) countPeer.set(t.peerGroupId, (countPeer.get(t.peerGroupId) ?? 0) + 1);
  }
  const overSectors = new Set<string>();
  for (const [sec, n] of countSector) if (n > maxSector) overSectors.add(sec);
  const overPeers = new Set<string>();
  for (const [gid, n] of countPeer) if (n > maxPeer) overPeers.add(gid);
  if (overSectors.size === 0 && overPeers.size === 0) {
    return scores.map((s) => s.totalScore);
  }

  const out = scores.map((s) => s.totalScore);
  for (const sec of overSectors) {
    const members = sorted.filter((s) => s.sector === sec);
    members.forEach((m, rankInSector) => {
      if (rankInSector < maxSector) return;
      const h = Math.min(0.25, 0.05 * (rankInSector - maxSector + 1));
      out[m.i] = Math.min(out[m.i]!, m.totalScore * (1 - h));
    });
  }
  for (const gid of overPeers) {
    const members = sorted.filter((s) => s.peerGroupId === gid);
    members.forEach((m, rankInGroup) => {
      if (rankInGroup < maxPeer) return;
      const h = Math.min(0.20, 0.06 * (rankInGroup - maxPeer + 1));
      out[m.i] = Math.min(out[m.i]!, m.totalScore * (1 - h));
    });
  }
  return out;
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

  const displayOnly = new Set<string>(TECHNICAL_DISPLAY_ONLY_KEYS);
  const w = (key: string, def: number) =>
    displayOnly.has(key) ? 0 : (technicalWeights?.[key] ?? def);

  // Raw depth before peer dampening
  const rawDepth = rows.map((row) =>
    side === "call" ? scoreOverboughtDepth(row) : scoreOversoldDepth(row),
  );
  const depthScores = dampenDepthByPeerGroup(
    rawDepth,
    rows.map((r) => r.peerGroupId ?? null),
  );

  // Cross-sectional ATM IV percentile fallback when hist IV rank unavailable
  const atmIvs = rows.map((r) => pf(r.atmPutIv));
  const finiteAtm = atmIvs.filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const crossIvRank = (iv: number | null): number | null => {
    if (iv == null || iv <= 0 || finiteAtm.length < 20) return null;
    let below = 0;
    for (const v of finiteAtm) if (v < iv) below++;
    return below / finiteAtm.length;
  };
  const enrichedRows = rows.map((r) => {
    if (r.ivRankEffective != null && Number.isFinite(r.ivRankEffective)) return r;
    const cross = crossIvRank(pf(r.atmPutIv));
    return cross != null ? { ...r, ivRankEffective: cross } : r;
  });

  const perTicker = enrichedRows.map((row, i) => {
    const compScores: { key: string; weight: number; score: number | null }[] = [
      { key: "oversoldDepth",    weight: w("oversoldDepth", W_OVERSOLD_DEPTH),     score: depthScores[i]! },
      { key: "reversalSignal",   weight: w("reversalSignal", W_REVERSAL_SIGNAL),   score: side === "call" ? scoreExhaustionSignal(row) : scoreReversalSignal(row) },
      { key: "volatilityState",  weight: w("volatilityState", W_VOLATILITY_STATE), score: scoreVolatilityState(row) },
      { key: "trendContext",     weight: w("trendContext", W_TREND_CONTEXT),       score: side === "call" ? scoreTrendExtension(row) : scoreTrendContext(row) },
      { key: "relativePressure", weight: w("relativePressure", W_RELATIVE_PRESSURE), score: scoreRelativePressure(row, side) },
      { key: "optionsFlow",      weight: w("optionsFlow", W_OPTIONS_FLOW),        score: side === "call" ? scoreCallFlow(row) : scoreOptionsFlow(row) },
      { key: "analystUpside",    weight: w("analystUpside", W_ANALYST_UPSIDE),    score: scoreAnalystUpside(row, side) },
      { key: "volumeConfirm",    weight: w("volumeConfirm", W_VOLUME_CONFIRM),    score: scoreVolumeConfirm(row) },
    ];
    // A155: only positive-weight comps enter the total (extras stay in compScores for display)
    const available = compScores.filter((c) => c.score !== null && c.weight > 0) as { key: string; weight: number; score: number }[];

    let totalScore = 0;
    if (available.length > 0) {
      const availWeight = available.reduce((s, c) => s + c.weight, 0);
      const weightedSum = available.reduce((s, c) => s + c.score * c.weight, 0);
      totalScore = (weightedSum / availWeight) * 100;
    }

    // Short-interest haircut only (A155: drop analystUpside / speculative haircuts — extras are display-only)
    const siH = shortInterestHaircut(row.shortRatio);
    if (siH > 0) totalScore *= 1 - Math.min(0.30, siH);

    return {
      row,
      compScores,
      totalScore,
      peerGroupId: row.peerGroupId ?? null,
      signal: side === "call" ? computeGateV2Call(row) : computeGateV2(row),
      tier: tierMap[row.ticker.toUpperCase()] ?? (1 as 1 | 2 | 3),
      regime: (row.regime ?? "NEUTRAL") as "BULLISH" | "NEUTRAL" | "BEARISH",
      coverage: pf(row.technicalsCoverage),
    };
  });

  // Soft-cap peer over-representation in the top of the board
  const capped = softCapPeerGroupInTopN(
    perTicker.map((p) => ({ peerGroupId: p.peerGroupId, totalScore: p.totalScore })),
    20,
    0.25,
  );
  perTicker.forEach((p, i) => { p.totalScore = capped[i]!; });

  const sorted = [...perTicker].sort((a, b) => b.totalScore - a.totalScore);

  return sorted.map(({ row, compScores, totalScore, signal, tier, regime, coverage }, rankIdx) => {
    const rank = rankIdx + 1;
    const ms: TechnicalScore["metricScores"] = {};
    const repValue: Record<string, number | null> = {
      oversoldDepth:    pf(row.rsi14),
      reversalSignal:   pf(row.rsiVelocity),
      volatilityState:  row.ivRankEffective ?? pf(row.atmPutIv) ?? pf(row.ivVsRealizedVol),
      trendContext:     pf(row.priceVsMa50Atr),
      relativePressure: row.vsSpy20d ?? pf(row.priceZScore),
      optionsFlow:      pf(row.putCallVolumeRatio),
      analystUpside:    row.analystUpside ?? null,
      volumeConfirm:    pf(row.volumeRatioPct),
    };
    for (const c of compScores) {
      ms[c.key] = {
        value:         repValue[c.key] ?? null,
        weightedScore: c.score != null ? parseFloat((c.score * c.weight).toFixed(4)) : 0,
        rank,
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
  if (r.ivRankEffective != null && Number.isFinite(r.ivRankEffective)) {
    parts.push({ label: "ATM IV rank (hist or cross-sectional)", raw: fmtPct01(r.ivRankEffective), score: c01(r.ivRankEffective) });
  } else {
    const atmIv = pf(r.atmPutIv);
    if (atmIv != null && atmIv > 0) {
      parts.push({ label: "ATM put IV (elevated = better for premium)", raw: `${atmIv.toFixed(1)}%`, score: c01((atmIv - 10) / 50) });
    }
  }
  const ivVsRv = pf(r.ivVsRealizedVol);
  if (ivVsRv != null) parts.push({ label: "IV vs realized vol", raw: `${ivVsRv.toFixed(2)}x`, score: c01((ivVsRv - 0.5) / 1.0) });
  return parts;
}

export function explainAnalystUpsidePut(r: TechnicalRow): ComponentPart[] {
  const u = r.analystUpside;
  if (u == null || !Number.isFinite(u) || Math.abs(u) > 0.75) return [];
  const clipped = Math.max(-0.5, Math.min(0.5, u));
  const soft = 0.5 + 0.5 * Math.tanh(clipped / 0.28);
  return [{
    label: "Consensus target upside (gold Yahoo/FMP)",
    raw: `${(u * 100).toFixed(1)}%`,
    score: c01(soft),
  }];
}

export function explainAnalystUpsideCall(r: TechnicalRow): ComponentPart[] {
  const u = r.analystUpside;
  if (u == null || !Number.isFinite(u) || Math.abs(u) > 0.75) return [];
  const clipped = Math.max(-0.5, Math.min(0.5, u));
  const soft = 0.5 + 0.5 * Math.tanh(clipped / 0.28);
  return [{
    label: "Price vs consensus target (above target = good for calls)",
    raw: `${(u * 100).toFixed(1)}% upside`,
    score: c01(1 - soft),
  }];
}

export function explainRelativePressurePut(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const z = pf(r.priceZScore);
  if (z != null) parts.push({ label: "Price z-score (20d)", raw: z.toFixed(2), score: c01((-z + 0.5) / 2.5) });
  if (r.vsSpy20d != null && Number.isFinite(r.vsSpy20d)) {
    parts.push({ label: "20d return vs SPY (pp)", raw: `${r.vsSpy20d.toFixed(1)}pp`, score: c01((-r.vsSpy20d + 2) / 10) });
  }
  const siH = shortInterestHaircut(r.shortRatio);
  if (siH > 0 && r.shortRatio != null) {
    parts.push({
      label: `Short DTC haircut (−${(siH * 100).toFixed(0)}% total)`,
      raw: `${r.shortRatio.toFixed(1)}d`,
      score: 1 - siH,
    });
  }
  const spH = speculativeHaircut(r.peerGroupId, r.analystUpside);
  if (spH > 0) {
    parts.push({
      label: `Speculative peer haircut (−${(spH * 100).toFixed(0)}% total)`,
      raw: r.peerGroupId ?? "speculative",
      score: 1 - spH,
    });
  }
  return parts;
}

export function explainRelativePressureCall(r: TechnicalRow): ComponentPart[] {
  const parts: ComponentPart[] = [];
  const z = pf(r.priceZScore);
  if (z != null) parts.push({ label: "Price z-score (20d)", raw: z.toFixed(2), score: c01((z + 0.5) / 2.5) });
  if (r.vsSpy20d != null && Number.isFinite(r.vsSpy20d)) {
    parts.push({ label: "20d return vs SPY (pp)", raw: `${r.vsSpy20d.toFixed(1)}pp`, score: c01((r.vsSpy20d + 2) / 10) });
  }
  const siH = shortInterestHaircut(r.shortRatio);
  if (siH > 0 && r.shortRatio != null) {
    parts.push({
      label: `Short DTC haircut (−${(siH * 100).toFixed(0)}% total)`,
      raw: `${r.shortRatio.toFixed(1)}d`,
      score: 1 - siH,
    });
  }
  const spH = speculativeHaircut(r.peerGroupId, r.analystUpside);
  if (spH > 0) {
    parts.push({
      label: `Speculative peer haircut (−${(spH * 100).toFixed(0)}% total)`,
      raw: r.peerGroupId ?? "speculative",
      score: 1 - spH,
    });
  }
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
  oversoldDepth:    explainOversoldDepth,
  reversalSignal:   explainReversalSignal,
  volatilityState:  explainVolatilityState,
  trendContext:     explainTrendContext,
  relativePressure: explainRelativePressurePut,
  optionsFlow:      explainOptionsFlow,
  analystUpside:    explainAnalystUpsidePut,
  volumeConfirm:    explainVolumeConfirm,
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
  oversoldDepth:    explainOverboughtDepth,
  reversalSignal:   explainExhaustionSignal,
  volatilityState:  explainVolatilityState,
  trendContext:     explainTrendExtension,
  relativePressure: explainRelativePressureCall,
  optionsFlow:      explainCallFlow,
  analystUpside:    explainAnalystUpsideCall,
  volumeConfirm:    explainVolumeConfirm,
};

export function getComponentExplainers(side: ScoreSide) {
  return side === "call" ? COMPONENT_EXPLAINERS_CALL : COMPONENT_EXPLAINERS;
}

