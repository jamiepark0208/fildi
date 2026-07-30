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
  winRate: number | null;   // [0,1] over the trailing window
  avgPnlPct: number | null; // mean pnlPct of graded recs (informational)
  n: number;                // graded recs in the trailing window
  updatedAt: string | null; // ISO timestamp of last recompute
}

export interface TiltState {
  put: SideTiltStats;
  call: SideTiltStats;
}

export const TILT_MIN_N = 8;             // below this → no tilt
export const TILT_ANCHOR_WIN_RATE = 0.70; // design target win rate for a premium seller
export const TILT_SPAN = 0.20;            // winRate ± span maps to factor ±1
export const TILT_MAX_SHIFT = 0.25;       // max relative change to income/buffer weights

export const EMPTY_SIDE_STATS: SideTiltStats = { winRate: null, avgPnlPct: null, n: 0, updatedAt: null };
export const EMPTY_TILT_STATE: TiltState = { put: EMPTY_SIDE_STATS, call: EMPTY_SIDE_STATS };

/** Aggressiveness factor in [-1, 1]. Positive = winning above anchor → lean into income. */
export function tiltFactor(stats: SideTiltStats | null | undefined): number {
  if (!stats || stats.n < TILT_MIN_N || stats.winRate == null) return 0;
  const a = (stats.winRate - TILT_ANCHOR_WIN_RATE) / TILT_SPAN;
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
