/**
 * UT Bot Alerts (QuantNomad) and SuperTrend (TradingView built-in) on Pine-style ATR. Moved from the stock-compare
 * tv-intraday.ts so the charts and the nightly track-record grader share one copy (Jamie 11-04).
 */
export type OHLC = { time: number; open: number; high: number; low: number; close: number };

/** Wilder ATR (Pine ta.atr): RMA of true range, seeded with the SMA of the first n. */
export function atr(bars: OHLC[], n: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let sum = 0;
  let prev = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const pc = i ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (i < n) {
      sum += tr;
      if (i === n - 1) prev = out[i] = sum / n;
    } else {
      prev = out[i] = (prev * (n - 1) + tr) / n;
    }
  }
  return out;
}

export type UtSignal = { time: number; side: "buy" | "sell"; price: number };

export function utBot(bars: OHLC[], key = 1, n = 10): { trail: number[]; signals: UtSignal[] } {
  const a = atr(bars, n);
  const trail: number[] = new Array(bars.length).fill(NaN);
  const signals: UtSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const c = bars[i].close, pc = bars[i - 1].close, loss = key * a[i];
    const p = Number.isFinite(trail[i - 1]) ? trail[i - 1] : c - loss;
    trail[i] = c > p && pc > p ? Math.max(p, c - loss)
      : c < p && pc < p ? Math.min(p, c + loss)
      : c > p ? c - loss : c + loss;
    if (!Number.isFinite(trail[i - 1])) continue;
    if (c > trail[i] && pc <= trail[i - 1]) signals.push({ time: bars[i].time, side: "buy", price: bars[i].low });
    else if (c < trail[i] && pc >= trail[i - 1]) signals.push({ time: bars[i].time, side: "sell", price: bars[i].high });
  }
  return { trail, signals };
}

/** Pine ta.supertrend(factor, atrPeriod): dir 1 = up (line = lower band), -1 = down (line = upper band). */
export function superTrend(bars: OHLC[], factor = 3, n = 10): { line: number[]; dir: number[] } {
  const a = atr(bars, n);
  const line: number[] = new Array(bars.length).fill(NaN);
  const dir: number[] = new Array(bars.length).fill(0);
  let ub = NaN, lb = NaN, d = 1;
  for (let i = 0; i < bars.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const b = bars[i], hl2 = (b.high + b.low) / 2, pc = i ? bars[i - 1].close : b.close;
    let u = hl2 + factor * a[i], l = hl2 - factor * a[i];
    if (Number.isFinite(ub)) {
      u = u < ub || pc > ub ? u : ub;
      l = l > lb || pc < lb ? l : lb;
      // Pine: compare the close to this bar's ratcheted band on the side the line was on.
      d = d < 0 ? (b.close > u ? 1 : -1) : (b.close < l ? -1 : 1);
    }
    ub = u; lb = l;
    dir[i] = d;
    line[i] = d > 0 ? l : u;
  }
  return { line, dir };
}
