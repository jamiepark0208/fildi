/**
 * Market Structure Oscillator — port of "Market Structure Oscillator [BigBeluga]" (Pine v6, CC BY-NC-SA 4.0, © BigBeluga).
 * Drawing/label/colour inputs are dropped; the break logic, oscillator and divergence rules are ported line by line.
 */
import { change, ema, pivothigh, pivotlow, stdev, type Series } from "./pine.ts";
import type { TvBar } from "./types.ts";

export type MsoOptions = { momLength: number; smoothLength: number; msPivotLeft: number; msPivotRight: number; divPivotLeft: number; divPivotRight: number };
export const MSO_DEFAULTS: MsoOptions = { momLength: 14, smoothLength: 10, msPivotLeft: 5, msPivotRight: 5, divPivotLeft: 5, divPivotRight: 5 };

export type MsoBreak = {
  i: number; time: number;
  /** Pine label: bullBreakCount <= 1 ? "ChoCh" : "BoS". */
  kind: "CHoCH" | "BoS";
  dir: "bull" | "bear";
  /** Broken swing price and the bar it formed on. */
  price: number; swingBar: number;
  /** Consecutive breaks in this direction (the number printed on the chart). */
  count: number;
};
export type MsoDivergence = {
  i: number; time: number; dir: "bull" | "bear";
  /** Price of this pivot / previous pivot, oscillator at this pivot / previous pivot, and the pivot bars. */
  price: number; prevPrice: number; osc: number; prevOsc: number; pivotBar: number; prevPivotBar: number;
};

export type MsoResult = {
  /** smoothedOscillator = ema(sigmoid momentum, smooth). */
  osc: Series;
  /** Histogram around 50: 50 ± |osc - 50| by market-structure trend. */
  trendFilteredOsc: Series;
  /** isTrendUp at each bar (null until the first break). */
  trendUp: boolean[];
  breaks: MsoBreak[];
  divergences: MsoDivergence[];
};

export function mso(bars: TvBar[], opt: Partial<MsoOptions> = {}): MsoResult {
  const o = { ...MSO_DEFAULTS, ...opt };
  const n = bars.length;
  const high = bars.map((b) => b.high), low = bars.map((b) => b.low), close = bars.map((b) => b.close);

  const pivotHigh = pivothigh(high, o.msPivotLeft, o.msPivotRight);
  const pivotLow = pivotlow(low, o.msPivotLeft, o.msPivotRight);

  // Momentum chain.
  const rateOfChange = change(close, o.momLength);
  const priceVolatility = stdev(change(close), o.momLength);
  const raw = rateOfChange.map((r, i) => {
    const v = priceVolatility[i]!;
    // Pine: priceVolatility != 0 ? roc / vol : 0 — na != 0 holds, so na flows through during warm-up.
    return v !== 0 ? r / v : 0;
  });
  const sigmoid = raw.map((m) => 100 / (1 + Math.exp(-m)));
  const osc = ema(sigmoid, o.smoothLength);

  let isTrendUp = false;
  let bullCount = 0, bearCount = 0;
  let hiPrice = NaN, hiBar = NaN, loPrice = NaN, loBar = NaN;
  // ta.crossover(close, latestHighSwing.price) compares against the value that expression had on the previous bar at
  // call time (before that bar's `price := na`), so keep it.
  let prevHiCall = NaN, prevLoCall = NaN;
  const trendUp: boolean[] = new Array(n).fill(false);
  const tfo: Series = new Array(n).fill(NaN);
  const breaks: MsoBreak[] = [];

  const prevOscHi = { v: NaN, bar: NaN, price: NaN };
  const prevOscLo = { v: NaN, bar: NaN, price: NaN };
  const oscPivotHigh = pivothigh(osc, o.divPivotLeft, o.divPivotRight);
  const oscPivotLow = pivotlow(osc, o.divPivotLeft, o.divPivotRight);
  const divergences: MsoDivergence[] = [];

  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(pivotHigh[i]!)) { hiPrice = pivotHigh[i]!; hiBar = i - o.msPivotRight; }
    if (!Number.isNaN(pivotLow[i]!)) { loPrice = pivotLow[i]!; loBar = i - o.msPivotRight; }

    const hiNow = hiPrice;
    if (i > 0 && close[i]! > hiNow && close[i - 1]! <= prevHiCall && !Number.isNaN(hiNow)) {
      isTrendUp = true;
      bullCount += 1;
      bearCount = 0;
      breaks.push({ i, time: bars[i]!.time, kind: bullCount <= 1 ? "CHoCH" : "BoS", dir: "bull", price: hiNow, swingBar: hiBar, count: bullCount });
      hiPrice = NaN;
    }
    prevHiCall = hiNow;

    const loNow = loPrice;
    if (i > 0 && close[i]! < loNow && close[i - 1]! >= prevLoCall && !Number.isNaN(loNow)) {
      isTrendUp = false;
      bearCount += 1;
      bullCount = 0;
      breaks.push({ i, time: bars[i]!.time, kind: bearCount <= 1 ? "CHoCH" : "BoS", dir: "bear", price: loNow, swingBar: loBar, count: bearCount });
      loPrice = NaN;
    }
    prevLoCall = loNow;

    trendUp[i] = isTrendUp;
    const so = osc[i]!;
    if (!Number.isNaN(so)) {
      const off = Math.abs(so - 50);
      tfo[i] = isTrendUp ? 50 + off : 50 - off;
    }

    // Divergences on the smoothed oscillator pivots (confirmed bar assumed, as barstate.isconfirmed on history).
    if (!Number.isNaN(oscPivotHigh[i]!)) {
      const cur = oscPivotHigh[i]!, curBar = i - o.divPivotRight, curPrice = high[curBar]!;
      if (!Number.isNaN(prevOscHi.v) && curPrice > prevOscHi.price && cur < prevOscHi.v) {
        divergences.push({ i, time: bars[i]!.time, dir: "bear", price: curPrice, prevPrice: prevOscHi.price, osc: cur, prevOsc: prevOscHi.v, pivotBar: curBar, prevPivotBar: prevOscHi.bar });
      }
      prevOscHi.v = cur; prevOscHi.bar = curBar; prevOscHi.price = curPrice;
    }
    if (!Number.isNaN(oscPivotLow[i]!)) {
      const cur = oscPivotLow[i]!, curBar = i - o.divPivotRight, curPrice = low[curBar]!;
      if (!Number.isNaN(prevOscLo.v) && curPrice < prevOscLo.price && cur > prevOscLo.v) {
        divergences.push({ i, time: bars[i]!.time, dir: "bull", price: curPrice, prevPrice: prevOscLo.price, osc: cur, prevOsc: prevOscLo.v, pivotBar: curBar, prevPivotBar: prevOscLo.bar });
      }
      prevOscLo.v = cur; prevOscLo.bar = curBar; prevOscLo.price = curPrice;
    }
  }
  return { osc, trendFilteredOsc: tfo, trendUp, breaks, divergences };
}
