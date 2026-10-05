// Multi-knob bounded policy learned from graded track record.
// Extends the original income↔buffer tilt with SQ floor + earnings haircut.
// Pure — shared by api-server and stock-compare.

import { W_INCOME, W_BUFFER } from "./option-scorer-constants.ts";

export interface SideTiltStats {
  winRate: number | null;
  avgPnlPct: number | null;
  n: number;
  updatedAt: string | null;
  /** Optional regime-conditioned expectancy (macro regime name → avgPnlPct). */
  byRegime?: Record<string, { n: number; avgPnlPct: number }>;
  /** Per-ticker shrunk expectancy offsets (additive to global avgPnlPct). */
  byTicker?: Record<string, { n: number; avgPnlPct: number; shrunkDelta: number }>;
}

export interface TiltState {
  put: SideTiltStats;
  call: SideTiltStats;
}

export const TILT_MIN_N = 20;
export const TILT_ANCHOR_PNL_PCT = 0;
export const TILT_SPAN_PNL_PCT = 0.25;
export const TILT_MAX_SHIFT = 0.25;

/** Ownership soft floor — hard-exclude strikes below this stockQuality. */
export const SQ_FLOOR_BASE = 0.45;
/** When side expectancy is negative, raise floor toward this. */
export const SQ_FLOOR_STRICT = 0.50;
/** Earnings overall haircut multipliers (deep OTM vs near). Policy nudges these. */
export const EARNINGS_HAIRCUT_BASE = 0.90;
export const EARNINGS_HAIRCUT_STRICT = 0.80;

export const EMPTY_SIDE_STATS: SideTiltStats = { winRate: null, avgPnlPct: null, n: 0, updatedAt: null };
export const EMPTY_TILT_STATE: TiltState = { put: EMPTY_SIDE_STATS, call: EMPTY_SIDE_STATS };

export const POLICY_VERSION = 2;

export interface SidePolicy {
  factor: number;
  weights: Record<string, number>;
  sqFloor: number;
  earningsHaircut: number;
  version: number;
}

export function tiltFactor(stats: SideTiltStats | null | undefined): number {
  if (!stats || stats.n < TILT_MIN_N || stats.avgPnlPct == null) return 0;
  const a = (stats.avgPnlPct - TILT_ANCHOR_PNL_PCT) / TILT_SPAN_PNL_PCT;
  return Math.max(-1, Math.min(1, a));
}

/**
 * Empirical-Bayes shrink of ticker mean toward global mean.
 * priorStrength ≈ pseudo-counts of global; higher = more shrinkage.
 */
export function shrinkTickerExpectancy(
  tickerAvg: number,
  tickerN: number,
  globalAvg: number,
  priorStrength = 12,
): number {
  const w = tickerN / (tickerN + priorStrength);
  return w * tickerAvg + (1 - w) * globalAvg;
}

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

/** Full multi-knob policy from side stats (+ optional regime override). */
export function applyPolicy(
  stats: SideTiltStats | null | undefined,
  baseWeights?: Record<string, number>,
  opts?: { regime?: string | null; ticker?: string | null },
): SidePolicy {
  let effective: SideTiltStats | null | undefined = stats;
  if (stats && opts?.regime && stats.byRegime?.[opts.regime] && stats.byRegime[opts.regime]!.n >= TILT_MIN_N) {
    const r = stats.byRegime[opts.regime]!;
    effective = { ...stats, avgPnlPct: r.avgPnlPct, n: Math.max(stats.n, r.n) };
  }
  if (stats && opts?.ticker && stats.byTicker?.[opts.ticker] && stats.avgPnlPct != null) {
    const t = stats.byTicker[opts.ticker]!;
    const blended = stats.avgPnlPct + t.shrunkDelta;
    effective = { ...(effective ?? stats), avgPnlPct: blended };
  }

  const { weights, factor } = applyTilt(effective, baseWeights);
  // Negative expectancy → stricter ownership floor + sharper earnings haircut
  const sqFloor = factor < -0.25 ? SQ_FLOOR_STRICT : SQ_FLOOR_BASE;
  const earningsHaircut = factor < -0.25 ? EARNINGS_HAIRCUT_STRICT : EARNINGS_HAIRCUT_BASE;

  return { factor, weights, sqFloor, earningsHaircut, version: POLICY_VERSION };
}
