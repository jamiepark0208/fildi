// Pure option-level scorer (Layer 2).
// Every function depends only on its own inputs — no cross-strike or cross-ticker state.
// Null inputs drop the component and renormalize remaining weights (invariance guarantee).

import {
  type MacroRegime,
  INCOME_FLOOR, INCOME_TARGET, INCOME_DECAY_FLOOR,
  REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR,
  CALL_INCOME_FLOOR, CALL_INCOME_TARGET,
  DELTA_SWEET_HIGH, DELTA_MAX,
  SD_BUFFER_TARGET, BUFFER_WEIGHT_DELTA, BUFFER_WEIGHT_SD,
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
  swingHigh20d: number | null;
  swingHigh50d: number | null;
  pivotR1: number | null;
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
// Soft peak at target (~1%/wk after regime shift) — below target, income is the gate;
// above target, yield decays gently toward INCOME_DECAY_FLOOR. This is the ONLY component
// that penalizes distance from a target rather than rewarding a direction monotonically —
// deeper safety (lower delta, more buffer, higher IV) is handled by their own components
// below and should never be cross-gated by income or vice versa (each metric owns its own
// reward curve — no double-counting across components).

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
// Monotonic: lower |delta| (safer, more OTM, higher POP) always scores at least as well as
// a higher one — never penalized for being "too safe" the way a sweet-band design would.
// DELTA_SWEET_HIGH[regime] is kept as a soft reference point (still scores ~0.7 there) so
// regime still shifts how aggressively the falloff toward 0 kicks in by DELTA_MAX.

export function scoreDeltaBand(absDelta: number, regime: MacroRegime): number {
  const hi = DELTA_SWEET_HIGH[regime];
  if (absDelta >= DELTA_MAX) return 0;
  if (absDelta <= hi) return c01(1 - 0.3 * (absDelta / hi));
  return c01(0.7 * (1 - (absDelta - hi) / (DELTA_MAX - hi)));
}

// ── Component: SD buffer (expected-move based) ────────────────────────────────
// Monotonic: more buffer (in expected-move units) is always at least as good, capping at
// 1.0 once sds reaches SD_BUFFER_TARGET. No decay for "too much" buffer — a huge buffer from
// a safe delta is just safety; income's own target-decay already discourages chasing a strike
// so far OTM that the premium becomes negligible.

export function scoreSdBuffer(otmPct: number, strikeIV: number, dte: number): number {
  if (strikeIV <= 0 || dte <= 0) return 0;
  const em = strikeIV * Math.sqrt(dte / 365);
  if (em <= 0) return 0;
  const sds = otmPct / em;
  if (sds <= 0) return 0;
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
  isCall: boolean = false,
): number | null {
  const rank = pf(ivRank);
  const pct  = pf(ivPercentile);

  const parts: number[] = [];
  if (rank !== null) parts.push(c01(rank));        // ivRank is [0,1]
  if (pct  !== null) parts.push(c01(pct  / 100));  // ivPercentile is [0,100]
  if (parts.length === 0) return null;

  let base = parts.reduce((s, v) => s + v, 0) / parts.length;

  // Optional nudges (capped so bonuses can't dominate)
  const vr = pf(ivVsRealizedVol);
  if (vr !== null && vr > 1.0) base = Math.min(1, base + IV_VS_REALIZED_BONUS);

  // Side-specific: basicSkew = OTM put IV − OTM call IV. Put sellers harvest a rich
  // put wing (sk > 0); call sellers want the call wing bid (sk < 0).
  const sk = pf(basicSkew);
  if (sk !== null && (isCall ? sk < 0 : sk > 0)) base = Math.min(1, base + IV_SKEW_BONUS);

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

// ── Component: Strike-specific resistance proximity (calls) ───────────────────
// Mirror of scoreStrikeSupport — scores how far the STRIKE is above known resistance
// levels (safety from assignment, not downside safety).

export function scoreStrikeResistance(
  strike: number,
  spot: number,
  swingHigh20d: number | null,
  swingHigh50d: number | null,
  pivotR1: number | null,
): number | null {
  const levels = [pf(swingHigh20d), pf(swingHigh50d), pf(pivotR1)].filter((v): v is number => v !== null);
  if (levels.length === 0) return null;

  const bestResistance = Math.max(...levels);
  if (spot >= bestResistance) return 0.5; // degenerate: spot already above all resistance

  // Strike at or above the highest resistance → max score (safe from assignment)
  if (strike >= bestResistance) return 1.0;

  // Linear: 0 at spot * 1.03 (just barely OTM), 1.0 at bestResistance
  const lo = spot * 1.03;
  if (strike <= lo) return 0;
  return c01((strike - lo) / (bestResistance - lo));
}

// ── Component: DTE / theta preference ────────────────────────────────────────

export function scoreDtePreference(dte: number): number {
  if (dte <= 7)  return 1.0;
  if (dte <= 14) return 0.8;
  if (dte <= 21) return 0.6;
  return 0.4;
}

// ── Component: DTE preference for calls ────────────────────────────────────────
// Soft peak in the 25-50D "monthly" convention window pros use for covered/short calls —
// deliberately gentle (W_DTE is only ~0.04 of total weight) so 1W/2W can still win outright
// on income/buffer/IV merits (e.g. an elevated front-week IV), matching the "usually 1M,
// sometimes 1W" preference — this is a nudge, not a gate.
export function scoreDtePreferenceCall(dte: number): number {
  if (dte <= 10)              return 0.6;
  if (dte <= 21)              return 0.75;
  if (dte >= 25 && dte <= 50) return 1.0;
  if (dte > 50)                return 0.7;
  return 0.8; // 21 < dte < 25 transition zone
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
  strikeWeights?: Record<string, number>,
  isCall: boolean = false,
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

  const floor  = isCall ? CALL_INCOME_FLOOR  : REGIME_INCOME_FLOOR[regime];
  const target = isCall ? CALL_INCOME_TARGET : REGIME_INCOME_TARGET[regime];

  const w = (key: string, def: number) => strikeWeights?.[key] ?? def;

  const components: Array<{ key: string; weight: number; score: number | null }> = [
    { key: "income",      weight: w("income", W_INCOME),        score: scoreIncomeAdequacy(candidate.weeklyIncome, floor, target) },
    { key: "buffer",      weight: w("buffer", W_BUFFER),        score: scoreBuffer(candidate.delta, candidate.strikeIV, candidate.dte, candidate.otmPct, regime) },
    { key: "ivRelative",  weight: w("ivRelative", W_IV_RELATIVE),   score: scoreIvRelative(stock.ivRank, stock.ivPercentile, stock.ivVsRealizedVol, stock.basicSkew, isCall) },
    { key: "ivAbsolute",  weight: w("ivAbsolute", W_IV_ABSOLUTE),   score: scoreIvAbsolute(candidate.strikeIV, allWatchlistIVs) },
    { key: "stockQuality",weight: w("stockQuality", W_STOCK_QUALITY), score: scoreStockQuality(stock.techTotalScore, stock.fundTotalScore) },
    { key: "support",     weight: w("support", W_SUPPORT),
      score: isCall
        ? scoreStrikeResistance(candidate.strike, candidate.spot, stock.swingHigh20d, stock.swingHigh50d, stock.pivotR1)
        : scoreStrikeSupport(candidate.strike, candidate.spot, stock.swingLow20d, stock.swingLow50d, stock.pivotS1) },
    { key: "dte",         weight: w("dte", W_DTE),
      score: isCall ? scoreDtePreferenceCall(candidate.dte) : scoreDtePreference(candidate.dte) },
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
  option: { strike: number; bid: number; ask: number; iv: number; volume: number | null; openInterest: number | null; delta: number | null; spreadPct: number | null; incomePct: number },
  chain: { spot: number; exactDte: number; settlementDte?: number },
  isCall: boolean = false,
): OptionCandidate {
  const exactDte = Math.max(0.01, chain.exactDte);
  const settlementDte = Math.max(0.01, chain.settlementDte ?? exactDte);
  return {
    strike:       option.strike,
    spot:         chain.spot,
    dte:          exactDte,
    weeklyIncome: option.incomePct / (settlementDte / 7),
    delta:        option.delta,
    strikeIV:     option.iv > 0 ? option.iv : null,
    otmPct:       chain.spot > 0
      ? (isCall ? (option.strike - chain.spot) / chain.spot : (chain.spot - option.strike) / chain.spot)
      : 0,
    openInterest: option.openInterest,
    spreadPct:    option.spreadPct,
    volume:       option.volume,
  };
}

// ── Convenience: pick the BEST strike across all chains for a stock ───────────
// Chain-shape-agnostic: caller supplies the strike array to scan via `options`
// (e.g. `{ ...chain, options: chain.puts }` or `{ ...chain, options: chain.calls }`)
// so puts and calls share this one loop/liquidity-gate/runner-up implementation.

export function pickBestStrike<
  Opt extends { strike: number; bid: number; ask: number; iv: number; volume: number | null; openInterest: number | null; delta: number | null; spreadPct: number | null; incomePct: number },
  Chain extends { spot: number; exactDte: number; settlementDte?: number; options: Opt[] },
>(
  chains: Chain[],
  stock: StockContext,
  regime: MacroRegime,
  allWatchlistIVs: number[],
  minScoredComponents: number = MIN_SCORED_COMPONENTS,
  strikeWeights?: Record<string, number>,
  isCall: boolean = false,
): { chain: Chain; put: Opt; result: OptionScoreResult; runnerUp: { chain: Chain; put: Opt; result: OptionScoreResult } | null } | null {
  type Candidate = { chain: Chain; put: Opt; result: OptionScoreResult };
  let best: Candidate | null = null;
  let runnerUp: Candidate | null = null;

  for (const chain of chains) {
    for (const put of chain.options) {
      if (put.bid <= 0) continue;
      const candidate = buildCandidate(put, chain, isCall);
      const result = computeOptionScore(candidate, stock, regime, allWatchlistIVs, strikeWeights, isCall);
      if (result.availableComponents < minScoredComponents) continue;
      const entry: Candidate = { chain, put, result };
      if (!best || result.optionScore > best.result.optionScore) {
        runnerUp = best;
        best = entry;
      } else if (!runnerUp || result.optionScore > runnerUp.result.optionScore) {
        runnerUp = entry;
      }
    }
  }

  return best ? { ...best, runnerUp } : null;
}
