/** Pure trend-fall rule (A314 family 4 / S146) — no DB imports (testable without DATABASE_URL).
 * EMA12 of completed 5-min closes (Ehlers IT proxy) falling > 0.15 % over 3 bars on SPY or QQQ.
 * S146 rest-of-day drop odds with / without, both halves: normal 29/15 · 31/8 %, elevated 28/15 · 34/17 %, stormy 44/35 · 46/20 %.
 * The study EMA ran through prior sessions; live seeds on today's first bar, so it is held back until bar 12. */
export const TREND_FALL_PCT = 0.0015;
export const TREND_FALL_MIN_BARS = 12;

export function ema(values: number[], span = 12): number[] {
  const k = 2 / (span + 1);
  const out: number[] = [];
  for (const v of values) out.push(out.length ? out[out.length - 1] + k * (v - out[out.length - 1]) : v);
  return out;
}

export function isTrendFall(closes: number[]): boolean {
  if (closes.length < TREND_FALL_MIN_BARS) return false;
  const e = ema(closes);
  const a = e[e.length - 4], b = e[e.length - 1];
  return (b - a) / Math.abs(a) < -TREND_FALL_PCT;
}
