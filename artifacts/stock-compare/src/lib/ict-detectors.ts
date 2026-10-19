/**
 * A139 — ICT-style detectors for chart overlays (display only; no scoring).
 * Daily bars: FVG (3-candle gap) + liquidity sweep (pierce prior N-day extreme, close back).
 */

export type IctBar = {
  date: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
};

export type IctFvg = {
  date: string;
  side: "bull" | "bear";
  top: number;
  bottom: number;
};

export type IctSweep = {
  date: string;
  side: "bull" | "bear";
  price: number;
};

function hi(b: IctBar): number {
  return b.high ?? b.close;
}
function lo(b: IctBar): number {
  return b.low ?? b.close;
}

/** Fair value gaps: bull when candle i low > candle i-2 high; bear when i high < i-2 low. */
export function detectFvg(bars: IctBar[], lookback = 80): IctFvg[] {
  const out: IctFvg[] = [];
  const start = Math.max(2, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const a = bars[i - 2]!;
    const c = bars[i]!;
    if (lo(c) > hi(a)) {
      out.push({ date: c.date, side: "bull", top: lo(c), bottom: hi(a) });
    } else if (hi(c) < lo(a)) {
      out.push({ date: c.date, side: "bear", top: lo(a), bottom: hi(c) });
    }
  }
  return out;
}

/** Liquidity sweep: pierce prior `window` day low/high, close back inside. */
export function detectSweeps(bars: IctBar[], window = 20, lookback = 80): IctSweep[] {
  const out: IctSweep[] = [];
  const start = Math.max(window, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const prior = bars.slice(i - window, i);
    const priorLow = Math.min(...prior.map(lo));
    const priorHigh = Math.max(...prior.map(hi));
    const b = bars[i]!;
    if (lo(b) < priorLow && b.close > priorLow) {
      out.push({ date: b.date, side: "bull", price: lo(b) });
    } else if (hi(b) > priorHigh && b.close < priorHigh) {
      out.push({ date: b.date, side: "bear", price: hi(b) });
    }
  }
  return out;
}

export type IctBos = {
  date: string;
  side: "bull" | "bear";
  price: number;
};

/** Break of structure: close beyond prior `window` swing high/low. */
export function detectBos(bars: IctBar[], window = 10, lookback = 80): IctBos[] {
  const out: IctBos[] = [];
  const start = Math.max(window, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const prior = bars.slice(i - window, i);
    const priorHigh = Math.max(...prior.map(hi));
    const priorLow = Math.min(...prior.map(lo));
    const b = bars[i]!;
    if (b.close > priorHigh) out.push({ date: b.date, side: "bull", price: priorHigh });
    else if (b.close < priorLow) out.push({ date: b.date, side: "bear", price: priorLow });
  }
  return out;
}

export type IctZone = {
  date: string;
  side: "demand" | "supply";
  top: number;
  bottom: number;
};

/**
 * Crude supply/demand: base candle before an impulsive move (≥1.5× median range).
 * Demand = bullish impulse after a down/base; supply = bearish impulse after up/base.
 */
export function detectSupplyDemand(bars: IctBar[], lookback = 60): IctZone[] {
  const out: IctZone[] = [];
  if (bars.length < 5) return out;
  const start = Math.max(2, bars.length - lookback);
  const ranges = bars.slice(Math.max(0, start - 20), bars.length).map((b) => hi(b) - lo(b)).filter((r) => r > 0);
  const med = ranges.length ? [...ranges].sort((a, b) => a - b)[Math.floor(ranges.length / 2)]! : 0;
  if (!(med > 0)) return out;
  for (let i = start; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const b = bars[i]!;
    const impulse = hi(b) - lo(b);
    if (impulse < 1.5 * med) continue;
    const baseRange = hi(prev) - lo(prev);
    if (baseRange > med) continue; // base should be quiet
    if (b.close > prev.close && b.close > hi(prev)) {
      out.push({ date: prev.date, side: "demand", top: hi(prev), bottom: lo(prev) });
    } else if (b.close < prev.close && b.close < lo(prev)) {
      out.push({ date: prev.date, side: "supply", top: hi(prev), bottom: lo(prev) });
    }
  }
  return out.slice(-12);
}
