import { highest, lowest, type Series } from "./pine.ts";
import type { IndEvent, IndicatorDef, TvBar } from "./types.ts";

/** TradingView built-in "Ichimoku Cloud" defaults. */
export type IchimokuOptions = { conversion: number; base: number; spanB: number; displacement: number };
export const ICHIMOKU_DEFAULTS: IchimokuOptions = { conversion: 9, base: 26, spanB: 52, displacement: 26 };

export type IchimokuResult = {
  conversion: Series;
  base: Series;
  /** Leading span A / B at the bar they are computed on; draw them `shift` bars ahead. */
  spanA: Series;
  spanB: Series;
  /** Lagging span = close, drawn `-shift` bars back. */
  lagging: Series;
  /** TradingView plots with offset = displacement - 1 (leading +25, lagging -25 for displacement 26). */
  shift: number;
};

/** ta donchian(len) = avg(lowest(low, len), highest(high, len)). */
function donchian(high: Series, low: Series, len: number): Series {
  const lo = lowest(low, len);
  const hi = highest(high, len);
  return hi.map((h, i) => (h + lo[i]!) / 2);
}

export function ichimoku(bars: TvBar[], opt: Partial<IchimokuOptions> = {}): IchimokuResult {
  const o = { ...ICHIMOKU_DEFAULTS, ...opt };
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const conversion = donchian(high, low, o.conversion);
  const base = donchian(high, low, o.base);
  const spanA = conversion.map((c, i) => (c + base[i]!) / 2);
  const spanB = donchian(high, low, o.spanB);
  return { conversion, base, spanA, spanB, lagging: bars.map((b) => b.close), shift: o.displacement - 1 };
}

const f = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(3));

export const def: IndicatorDef<IchimokuOptions> = {
  id: "ichimoku",
  label: "Ichimoku",
  version: 1,
  source: { url: "https://www.tradingview.com/scripts/search/ichimoku+cloud/", author: "TradingView built-in", license: "built-in" },
  defaults: ICHIMOKU_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "price",
  title: "9/26/52 cloud: conversion blue, base red, spans 25 bars ahead, lagging green 25 back.",
  chartKinds: [],
  compute(bars, opts) {
    const r = ichimoku(bars, opts);
    const events: IndEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      const c = r.conversion[i]!, b = r.base[i]!, pc = r.conversion[i - 1]!, pb = r.base[i - 1]!;
      if (![c, b, pc, pb].every(Number.isFinite)) continue;
      const up = c > b && pc <= pb, dn = c < b && pc >= pb;
      if (up || dn) events.push({ time: bars[i]!.time, side: up ? "buy" : "sell", kind: "TK cross", price: bars[i]!.close, note: [`conversion ${up ? "above" : "below"} base ${f(b)}`] });
    }
    return {
      series: { conv: r.conversion, base: r.base, lag: r.lagging, spanA: r.spanA, spanB: r.spanB },
      events,
      view: {
        lines: [
          { key: "conv", color: "#2962ff" },
          { key: "base", color: "#b71c1c" },
          { key: "lag", color: "#43a047", shift: -r.shift },
          { key: "spanA", color: "rgba(67,160,71,0.9)", shift: r.shift },
          { key: "spanB", color: "rgba(244,67,54,0.9)", shift: r.shift },
        ],
      },
    };
  },
};
