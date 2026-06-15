// Pure option-level scorer (Layer 2).
// Every function depends only on its own inputs — no cross-strike or cross-ticker state.
// Null inputs drop the component and renormalize remaining weights (invariance guarantee).

import {
  type MacroRegime,
  INCOME_FLOOR, INCOME_TARGET, INCOME_DECAY_FLOOR,
  REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR,
  DELTA_SWEET_LOW, DELTA_SWEET_HIGH, DELTA_MAX,
  SD_BUFFER_TARGET, SD_BUFFER_MAX, BUFFER_WEIGHT_DELTA, BUFFER_WEIGHT_SD,
  IV_VS_REALIZED_BONUS, IV_SKEW_BONUS, IV_ABSOLUTE_CAP,
  W_INCOME, W_BUFFER, W_IV_RELATIVE, W_IV_ABSOLUTE,
  W_STOCK_QUALITY, W_SUPPORT, W_DTE,
  MIN_OI, MAX_SPREAD_PCT, MIN_VOL, LIQUIDITY_GATE_HARD,
  MIN_SCORED_COMPONENTS,
} from "./option-scorer-constants.ts";

// ── Input types ───────────────────────────────────────────────────────────────

export interface OptionCandidate {
  weeklyIncome: number;      // (incomePct / exactDte) * 7 — corrected %/wk
  delta: number | null;      // put delta from bsGreeks (negative — scorer uses |delta|)
  strikeIV: number | null;   // per-strike implied vol (OptionRow.iv)
  dte: number;               // exact calendar days to expiry
  otmPct: number;            // (spot - strike) / spot, e.g. 0.10 = 10% OTM
  openInterest: number | null;
  spreadPct: number | null;
  volume: number | null;
  strike: number;
  spot: number;
}

export interface StockContext {
  ivRank: number | null;
  ivPercentile: number | null;
  ivVsRealizedVol: number | null;
  basicSkew: number | null;
  swingLow20d: number | null;
  swingLow50d: number | null;
  pivotS1: number | null;
  nearestSupportDistPct: number | null;
  techTotalScore: number | null;   // [0, 100]
  fundTotalScore: number | null;   // [0, 100]
}

export interface LiquidityResult {
  pass: boolean;
  warn: boolean;
  reason: string | null;
}

export interface OptionScoreResult {
  optionScore: number;              // [0, 100]
  weeklyIncome: number;
  componentScores: Record<string, { score: number | null; weight: number }>;
  dataQuality: number;             // 0–1: fraction of max possible weight covered
  dataQualityFlags: string[];
  liquidity: LiquidityResult;
  availableComponents: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function c01(v: number): number { return Math.max(0, Math.min(1, v)); }

function pf(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

// ── Component: Income adequacy ────────────────────────────────────────────────
// Soft target — penalizes both too low (income gate) and too high (assignment risk proxy).

export function scoreIncomeAdequacy(
  weeklyIncome: number,
  floor: number = INCOME_FLOOR,
  target: number = INCOME_TARGET,
): number {
  if (!Number.isFinite(weeklyIncome) || weeklyIncome < floor) return 0;
  if (weeklyIncome <= target) return (weeklyIncome - floor) / (target - floor);
  // Gentle decay above target: approaches INCOME_DECAY_FLOOR as yield → ∞
  return c01(INCOME_DECAY_FLOOR + (1 - INCOME_DECAY_FLOOR) * (target / weeklyIncome));
}

// ── Component: Delta band score ────────────────────────────────────────────────

export function scoreDeltaBand(absDelta: number, regime: MacroRegime): number {
  const lo = DELTA_SWEET_LOW[regime];
  const hi = DELTA_SWEET_HIGH[regime];
  if (absDelta >= DELTA_MAX) return 0;
  if (absDelta >= lo && absDelta <= hi) return 1.0;
  if (absDelta < lo) {
    // Too far OTM — mild penalty (income component already penalizes low yield)
    return c01(0.3 + 0.7 * (absDelta / lo));
  }
  // Too close — steeper penalty
  return c01(1 - (absDelta - hi) / (DELTA_MAX - hi));
}

// ── Component: SD buffer (expected-move based) ────────────────────────────────

export function scoreSdBuffer(otmPct: number, strikeIV: number, dte: number): number {
  if (strikeIV <= 0 || dte <= 0) return 0;
  const em = strikeIV * Math.sqrt(dte / 365);
  if (em <= 0) return 0;
  const sds = otmPct / em;
  if (sds <= 0) return 0;
  if (sds >= SD_BUFFER_MAX) return c01(INCOME_DECAY_FLOOR + (1 - INCOME_DECAY_FLOOR) * (SD_BUFFER_TARGET / sds));
  return c01(sds / SD_BUFFER_TARGET);
}

// ── Component: Buffer (blends delta band + SD buffer) ─────────────────────────

export function scoreBuffer(
  delta: number | null,
  strikeIV: number | null,
  dte: number,
  otmPct: number,
  regime: MacroRegime,
): number | null {
  const absDelta = delta !== null ? Math.abs(pf(delta) ?? 0) : null;
  const iv = pf(strikeIV);

  const deltaBandScore = absDelta !== null ? scoreDeltaBand(absDelta, regime) : null;
  const sdScore = iv !== null && iv > 0 ? scoreSdBuffer(otmPct, iv, dte) : null;

  if (deltaBandScore === null && sdScore === null) return null;
  if (deltaBandScore === null) return sdScore;
  if (sdScore === null) return deltaBandScore;

  return c01(deltaBandScore * BUFFER_WEIGHT_DELTA + sdScore * BUFFER_WEIGHT_SD);
}

// ── Component: IV relative (self-relative — uses own history via tickerTechnicals) ─

export function scoreIvRelative(
  ivRank: number | null,
  ivPercentile: number | null,
  ivVsRealizedVol: number | null,
  basicSkew: number | null,
): number | null {
  const rank = pf(ivRank);
  const pct  = pf(ivPercentile);

  const parts: number[] = [];
  if (rank !== null) parts.push(c01(rank / 100));
  if (pct  !== null) parts.push(c01(pct  / 100));
  if (parts.length === 0) return null;

  let base = parts.reduce((s, v) => s + v, 0) / parts.length;

  // Optional nudges (capped so bonuses can't dominate)
  const vr = pf(ivVsRealizedVol);
  if (vr !== null && vr > 1.0) base = Math.min(1, base + IV_VS_REALIZED_BONUS);

  const sk = pf(basicSkew);
  if (sk !== null && sk > 0)   base = Math.min(1, base + IV_SKEW_BONUS);

  return c01(base);
}

// ── Component: IV absolute (cross-watchlist normalization) ─────────────────────

export function scoreIvAbsolute(
  strikeIV: number | null,
  allIVs: number[],
): number | null {
  const iv = pf(strikeIV);
  if (iv === null || iv <= 0 || allIVs.length === 0) return null;
  const below = allIVs.filter(v => v <= iv).length;
  const pctile = below / allIVs.length;
  return c01(Math.min(pctile, IV_ABSOLUTE_CAP));
}

// ── Component: Stock quality (consumes existing scorer outputs) ────────────────

export function scoreStockQuality(
  techScore: number | null,
  fundScore: number | null,
): number | null {
  const t = pf(techScore);
  const f = pf(fundScore);
  if (t === null && f === null) return null;
  if (t === null) return c01((f as number) / 100);
  if (f === null) return c01(t / 100);
  return c01(0.6 * (t / 100) + 0.4 * (f / 100));
}

// ── Component: Strike-specific support proximity ───────────────────────────────
// Scores how far the STRIKE is below known support levels.

export function scoreStrikeSupport(
  strike: number,
  spot: number,
  swingLow20d: number | null,
  swingLow50d: number | null,
  pivotS1: number | null,
): number | null {
  const levels = [pf(swingLow20d), pf(swingLow50d), pf(pivotS1)].filter((v): v is number => v !== null);
  if (levels.length === 0) return null;

  const bestSupport = Math.min(...levels);
  if (spot <= bestSupport) return 0.5; // degenerate: spot already below all support

  // Strike at or below the lowest support → max score (genuine safety buffer)
  if (strike <= bestSupport) return 1.0;

  // Linear: 0 at spot * 0.97 (just barely OTM), 1.0 at bestSupport
  const hi = spot * 0.97;
  if (strike >= hi) return 0;
  return c01((hi - strike) / (hi - bestSupport));
}

// ── Component: DTE / theta preference ────────────────────────────────────────

export function scoreDtePreference(dte: number): number {
  if (dte <= 7)  return 1.0;
  if (dte <= 14) return 0.8;
  if (dte <= 21) return 0.6;
  return 0.4;
}

// ── Liquidity gate ────────────────────────────────────────────────────────────

export function liquidityGate(
  openInterest: number | null,
  spreadPct: number | null,
  volume: number | null,
): LiquidityResult {
  const reasons: string[] = [];
  let hard = false;

  if (openInterest !== null && openInterest < MIN_OI)  { reasons.push(`OI ${openInterest} < ${MIN_OI}`);   hard = LIQUIDITY_GATE_HARD; }
  if (spreadPct    !== null && spreadPct > MAX_SPREAD_PCT) { reasons.push(`spread ${(spreadPct*100).toFixed(0)}% > ${MAX_SPREAD_PCT*100}%`); hard = LIQUIDITY_GATE_HARD; }
  if (volume       !== null && volume < MIN_VOL)       { reasons.push(`vol ${volume} < ${MIN_VOL}`);        hard = LIQUIDITY_GATE_HARD; }

  if (reasons.length === 0) return { pass: true, warn: false, reason: null };
  return { pass: !hard, warn: true, reason: reasons.join(", ") };
}

// ── Main: computeOptionScore ──────────────────────────────────────────────────

export function computeOptionScore(
  candidate: OptionCandidate,
  stock: StockContext,
  regime: MacroRegime,
  allWatchlistIVs: number[],
): OptionScoreResult {
  if (candidate.dte <= 0 || candidate.strike <= 0 || candidate.spot <= 0) {
    return {
      optionScore: 0, weeklyIncome: candidate.weeklyIncome,
      componentScores: {}, dataQuality: 0,
      dataQualityFlags: ["DTE or strike invalid"],
      liquidity: { pass: false, warn: false, reason: "ineligible" },
      availableComponents: 0,
    };
  }

  const floor  = REGIME_INCOME_FLOOR[regime];
  const target = REGIME_INCOME_TARGET[regime];

  const components: Array<{ key: string; weight: number; score: number | null }> = [
    { key: "income",      weight: W_INCOME,        score: scoreIncomeAdequacy(candidate.weeklyIncome, floor, target) },
    { key: "buffer",      weight: W_BUFFER,        score: scoreBuffer(candidate.delta, candidate.strikeIV, candidate.dte, candidate.otmPct, regime) },
    { key: "ivRelative",  weight: W_IV_RELATIVE,   score: scoreIvRelative(stock.ivRank, stock.ivPercentile, stock.ivVsRealizedVol, stock.basicSkew) },
    { key: "ivAbsolute",  weight: W_IV_ABSOLUTE,   score: scoreIvAbsolute(candidate.strikeIV, allWatchlistIVs) },
    { key: "stockQuality",weight: W_STOCK_QUALITY, score: scoreStockQuality(stock.techTotalScore, stock.fundTotalScore) },
    { key: "support",     weight: W_SUPPORT,       score: scoreStrikeSupport(candidate.strike, candidate.spot, stock.swingLow20d, stock.swingLow50d, stock.pivotS1) },
    { key: "dte",         weight: W_DTE,           score: scoreDtePreference(candidate.dte) },
  ];

  const available = components.filter(c => c.score !== null);
  const totalWeight = available.reduce((s, c) => s + c.weight, 0);
  const maxWeight   = components.reduce((s, c) => s + c.weight, 0);

  const optionScore = totalWeight > 0
    ? (available.reduce((s, c) => s + c.weight * (c.score as number), 0) / totalWeight) * 100
    : 0;

  const componentScores: Record<string, { score: number | null; weight: number }> = {};
  for (const c of components) componentScores[c.key] = { score: c.score, weight: c.weight };

  const dataQualityFlags: string[] = [];
  if (candidate.delta === null)                                     dataQualityFlags.push("delta missing (IV null)");
  if (stock.ivRank === null && stock.ivPercentile === null)         dataQualityFlags.push("IV rank missing");
  if (stock.swingLow20d === null && stock.pivotS1 === null)         dataQualityFlags.push("support levels missing");
  if (stock.techTotalScore === null && stock.fundTotalScore === null) dataQualityFlags.push("both scorers missing");

  const liq = liquidityGate(candidate.openInterest, candidate.spreadPct, candidate.volume);

  return {
    optionScore: Math.round(optionScore * 10) / 10,
    weeklyIncome: candidate.weeklyIncome,
    componentScores,
    dataQuality: totalWeight / maxWeight,
    dataQualityFlags,
    liquidity: liq,
    availableComponents: available.length,
  };
}

// ── Convenience: build candidate from raw chain data ─────────────────────────

export function buildCandidate(
  put: { strike: number; bid: number; ask: number; iv: number; volume: number | null; openInterest: number | null; delta: number | null; spreadPct: number | null; incomePct: number },
  chain: { spot: number; exactDte: number },
): OptionCandidate {
  const exactDte = Math.max(0.01, chain.exactDte);
  return {
    strike:       put.strike,
    spot:         chain.spot,
    dte:          exactDte,
    weeklyIncome: put.incomePct / (exactDte / 7),
    delta:        put.delta,
    strikeIV:     put.iv > 0 ? put.iv : null,
    otmPct:       chain.spot > 0 ? (chain.spot - put.strike) / chain.spot : 0,
    openInterest: put.openInterest,
    spreadPct:    put.spreadPct,
    volume:       put.volume,
  };
}

// ── Convenience: pick the BEST strike across all chains for a stock ───────────

export function pickBestStrike(
  chains: Array<{ spot: number; exactDte: number; puts: Array<{ strike: number; bid: number; ask: number; iv: number; volume: number | null; openInterest: number | null; delta: number | null; spreadPct: number | null; incomePct: number }> }>,
  stock: StockContext,
  regime: MacroRegime,
  allWatchlistIVs: number[],
  minScoredComponents: number = MIN_SCORED_COMPONENTS,
): { chain: (typeof chains)[0]; put: (typeof chains)[0]["puts"][0]; result: OptionScoreResult } | null {
  let best: { chain: (typeof chains)[0]; put: (typeof chains)[0]["puts"][0]; result: OptionScoreResult } | null = null;

  for (const chain of chains) {
    for (const put of chain.puts) {
      if (put.bid <= 0) continue;
      const candidate = buildCandidate(put, chain);
      const result = computeOptionScore(candidate, stock, regime, allWatchlistIVs);
      if (result.availableComponents < minScoredComponents) continue;
      if (!best || result.optionScore > best.result.optionScore) {
        best = { chain, put, result };
      }
    }
  }

  return best;
}
