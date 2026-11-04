/**
 * TradingView-style intraday overlays for the Live session chart (Jamie 11-04).
 * Standard published logic, computed on the chart's own 5-min bars (prior-session bars warm the ATR so signals
 * exist from the open):
 *  - UT Bot Alerts (QuantNomad): trail = ATR(10) × key 1 ratchet; Buy = close crosses above trail, Sell = below.
 *  - SuperTrend (TradingView built-in): ATR(10) × 3 around hl2; green line under price = up, red over = down.
 * Display only: S108 (15-min UT turn for put-sale timing) and S124 (intraday direction) found no tested edge.
 * The nightly daily-bar versions live in scripts/watchlist_sync/indicators.py — keep the math in step.
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

// ── Regime odds (Jamie 11-04): 0–100 from this ticker's own past 5m bars, never later bars ──────────────────────────

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
export const FWD_BARS = 6; // 30 min ahead
const PRIOR = 20; // shrink toward the base rate: a 20-bar pseudo-sample, so n = 12 can't read 90 %

export type BarState = { ut: 1 | -1 | 0; st: number; age: number; runStart: number };
export type RegimeNow = {
  side: 1 | -1;
  age: number;
  sinceTime: number;
  stAgrees: boolean;
  /** P(close higher 30 min later) in past bars with the same UT side, SuperTrend side and run age — shrunk to base. */
  pUp: number;
  basePUp: number;
  n: number;
  /** P(this UT run lasts ≥ 6 more bars | it already lasted `age` bars), past completed runs of the same side. */
  pLast30: number;
  medianMoreBars: number | null;
  runsN: number;
};
export type SignalNote = {
  time: number;
  side: "buy" | "sell";
  lines: string[];
};

const ageBucket = (a: number) => (a <= 2 ? 0 : a <= 8 ? 1 : 2);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const hm = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

export function regimeOdds(bars: OHLC[], volumes?: number[]): { now: RegimeNow | null; notes: Map<number, SignalNote> } {
  const N = bars.length;
  const ut = utBot(bars), st = superTrend(bars), a = atr(bars, 10);
  const day = bars.map(b => etDay.format(new Date(b.time * 1000)));
  const state: BarState[] = [];
  for (let i = 0; i < N; i++) {
    const side = Number.isFinite(ut.trail[i]) ? (bars[i].close > ut.trail[i] ? 1 : -1) : 0;
    const prev = state[i - 1];
    const same = prev && prev.ut === side;
    state.push({ ut: side as 1 | -1 | 0, st: st.dir[i], age: same ? prev.age + 1 : 0, runStart: same ? prev.runStart : i });
  }
  // Completed UT runs: [start, length bars, side].
  const runs: { start: number; len: number; side: number }[] = [];
  for (let i = 1; i < N; i++) {
    if (state[i].ut !== 0 && (i === N - 1 || state[i + 1].ut !== state[i].ut) && i < N - 1) {
      runs.push({ start: state[i].runStart, len: state[i].age + 1, side: state[i].ut });
    }
  }
  // Up-in-30m outcome per bar, same session only, known only once the 30 min have passed.
  const fwdUp = (i: number) => (i + FWD_BARS < N && day[i + FWD_BARS] === day[i] ? (bars[i + FWD_BARS].close > bars[i].close ? 1 : 0) : null);

  const odds = (upto: number, side: number, stDir: number, age: number) => {
    let k = 0, n = 0, kb = 0, nb = 0;
    for (let j = 0; j + FWD_BARS < upto; j++) {
      const f = fwdUp(j);
      if (f == null || state[j].ut === 0) continue;
      kb += f; nb++;
      if (state[j].ut === side && state[j].st === stDir && ageBucket(state[j].age) === ageBucket(age)) { k += f; n++; }
    }
    const base = nb ? kb / nb : 0.5;
    return { p: (k + PRIOR * base) / (n + PRIOR), base, n };
  };
  const survival = (upto: number, side: number, age: number) => {
    const past = runs.filter(r => r.side === side && r.start + r.len < upto && r.len >= age + 1);
    const more = past.map(r => r.len - (age + 1));
    return { p: past.length ? more.filter(m => m >= FWD_BARS).length / past.length : NaN, med: median(more), n: past.length };
  };

  let now: RegimeNow | null = null;
  const last = N - 1;
  if (last >= 0 && state[last].ut !== 0) {
    const s = state[last];
    const o = odds(N, s.ut, s.st, s.age);
    const sv = survival(N, s.ut, s.age);
    now = { side: s.ut as 1 | -1, age: s.age + 1, sinceTime: bars[s.runStart].time, stAgrees: s.st === s.ut,
      pUp: o.p, basePUp: o.base, n: o.n, pLast30: sv.p, medianMoreBars: sv.med, runsN: sv.n };
  }

  // Per-signal notes — only facts specific to that signal.
  const notes = new Map<number, SignalNote>();
  const idx = new Map(bars.map((b, i) => [b.time, i]));
  for (const sig of ut.signals) {
    const i = idx.get(sig.time);
    if (i == null || !Number.isFinite(a[i])) continue;
    const dir = sig.side === "buy" ? 1 : -1;
    const lines: string[] = [];
    lines.push(`Close ${bars[i].close.toFixed(2)} crossed trail ${ut.trail[i - 1].toFixed(2)} by ${(Math.abs(bars[i].close - ut.trail[i - 1]) / a[i]).toFixed(1)} ATR`);
    const stSince = (() => { let j = i; while (j > 0 && st.dir[j - 1] === st.dir[i]) j--; return bars[j].time; })();
    lines.push(st.dir[i] === dir ? `SuperTrend agrees (${dir > 0 ? "up" : "down"} since ${hm(stSince)})` : `SuperTrend against — still ${dir > 0 ? "down" : "up"} since ${hm(stSince)}`);
    const prevStart = state[i - 1]?.runStart;
    if (prevStart != null && state[i - 1].ut !== 0) {
      lines.push(`Ends a ${state[i - 1].age + 1}-bar ${dir > 0 ? "sell" : "buy"} run (${pct(bars[i - 1].close / bars[prevStart].close - 1)})`);
    }
    if (volumes && i >= 20) {
      const avg = volumes.slice(i - 20, i).reduce((x, y) => x + y, 0) / 20;
      if (avg > 0) lines.push(`Volume ${(volumes[i] / avg).toFixed(1)}× the last 20 bars`);
    }
    const o = odds(i, dir, st.dir[i], 0);
    const sv = survival(i, dir, 0);
    const pSide = dir > 0 ? o.p : 1 - o.p;
    lines.push(`At signal: ${Math.round(pSide * 100)}% odds ${dir > 0 ? "higher" : "lower"} in 30m (n ${o.n})${sv.med != null ? ` · past ${sig.side}s ran a median ${sv.med + 1} bars` : ""}`);
    // Outcome (only bars already printed).
    let j = i;
    while (j + 1 < N && state[j + 1].ut === dir) j++;
    const len = j - i + 1, mv = bars[j].close / bars[i].close - 1;
    const best = dir > 0 ? Math.max(...bars.slice(i, j + 1).map(b => b.high)) / bars[i].close - 1 : Math.min(...bars.slice(i, j + 1).map(b => b.low)) / bars[i].close - 1;
    lines.push(`${j === N - 1 ? "So far" : "Result"}: ${len} bar${len > 1 ? "s" : ""}, ${pct(mv)} (best ${pct(best)})`);
    notes.set(sig.time, { time: sig.time, side: sig.side, lines });
  }
  return { now, notes };
}
