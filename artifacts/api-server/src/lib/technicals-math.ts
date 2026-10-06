/** Trailing window for percentile inputs — fixed so backfills don't rewrite live scores (A25 T1). */
export const PCT_WINDOW = 252;

/**
 * Fraction of trailing `series` values strictly below `current` ([0,1]).
 * Uses the last `window` finite points (default 252 trading days). `minN` is the
 * minimum sample size — not a lookback (call sites historically misread this).
 */
export function percentileRank(
  current: number,
  series: number[],
  minN = 60,
  window = PCT_WINDOW,
): number | null {
  const finite = series.filter((v) => Number.isFinite(v));
  const sample = finite.length > window ? finite.slice(-window) : finite;
  if (sample.length < minN) return null;
  let below = 0;
  for (const v of sample) if (v < current) below++;
  return below / sample.length;
}
