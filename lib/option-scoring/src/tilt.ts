// Auto-tilt: bounded feedback from the model's own graded track record into the
// strike-weight defaults. Pure — shared by api-server (weekly snapshot job) and
// stock-compare (options scanner) so both sides provably apply the same tilt.
//
// Design rails (do not loosen without revisiting the accountability plan):
// - Only W_INCOME and W_BUFFER move, in opposite directions, by at most ±TILT_MAX_SHIFT.
// - Below TILT_MIN_N graded recs the tilt is exactly 0 (no small-sample chasing).
// - DELTA_MAX, income floors, and every other constant stay untouched — the tilt can
//   shift preference within the scorer's safety rails, never past them.

import { W_INCOME, W_BUFFER } from "./option-scorer-constants.ts";

export interface SideTiltStats {
  winRate: number | null;   // [0,1] over the trailing window — DISPLAY ONLY, never drives the tilt
  avgPnlPct: number | null; // mean pnlPct (percent units) of graded recs — THIS drives the tilt
  n: number;                // graded recs in the trailing window
  updatedAt: string | null; // ISO timestamp of last recompute
}

export interface TiltState {
  put: SideTiltStats;
  call: SideTiltStats;
}

// Why this keys off average P&L and NOT win rate (changed 2026-08-27):
//
// Selling OTM premium wins ~85-90% of the time BY CONSTRUCTION — that is what a
// ~0.15 delta means. Win rate therefore measures the strike distance we chose, not
// whether the choice made money; the losses are the whole story and they are
// asymmetric. Under the old winRate/0.70-anchor rule both sides sat at ~0.89-0.90
// and pinned the factor at its +1 maximum. That included the CALL side, which was
// running avgPnlPct -0.068 (i.e. losing money) — the loop was leaning hardest into
// the one side that was bleeding, and shifting weight buffer -> income makes strikes
// closer to the money, which is exactly the wrong response to losses.
//
// avgPnlPct is in PERCENT units (pnlPerShare / basis * 100; see settleRec) and is
// signed, so 0 is the natural anchor: positive expectancy leans into income,
// negative expectancy backs off toward buffer. A mean of P&L is noisier than a
// win rate and one tail loss can swing it — that sensitivity is the point, but it
// is why TILT_MIN_N is higher here than the old win-rate rule needed.
export const TILT_MIN_N = 20;             // below this → no tilt (a P&L mean needs more n than a rate)
export const TILT_ANCHOR_PNL_PCT = 0;     // break-even expectancy is the neutral point
export const TILT_SPAN_PNL_PCT = 0.25;    // avgPnlPct ± this (percent) maps to factor ±1
export const TILT_MAX_SHIFT = 0.25;       // max relative change to income/buffer weights

export const EMPTY_SIDE_STATS: SideTiltStats = { winRate: null, avgPnlPct: null, n: 0, updatedAt: null };
export const EMPTY_TILT_STATE: TiltState = { put: EMPTY_SIDE_STATS, call: EMPTY_SIDE_STATS };

/** Aggressiveness factor in [-1, 1]. Positive = positive expectancy → lean into income.
 *  Negative = losing money → back off toward buffer (further-OTM strikes). */
export function tiltFactor(stats: SideTiltStats | null | undefined): number {
  if (!stats || stats.n < TILT_MIN_N || stats.avgPnlPct == null) return 0;
  const a = (stats.avgPnlPct - TILT_ANCHOR_PNL_PCT) / TILT_SPAN_PNL_PCT;
  return Math.max(-1, Math.min(1, a));
}

/**
 * Apply the tilt to a strike-weight record. `baseWeights` may omit income/buffer
 * (falls back to the put defaults W_INCOME/W_BUFFER — pass CALL_STRIKE_WEIGHTS-merged
 * values for calls). Returns the effective weights plus the factor used, so callers
 * can persist/display exactly what was applied.
 */
export function applyTilt(
  stats: SideTiltStats | null | undefined,
  baseWeights?: Record<string, number>,
): { weights: Record<string, number>; factor: number } {
  const factor = tiltFactor(stats);
  const income = baseWeights?.income ?? W_INCOME;
  const buffer = baseWeights?.buffer ?? W_BUFFER;
  return {
    factor,
    weights: {
      ...baseWeights,
      income: income * (1 + TILT_MAX_SHIFT * factor),
      buffer: buffer * (1 - TILT_MAX_SHIFT * factor),
    },
  };
}
