import { rsi } from "./pine.ts";
import type { IndicatorDef } from "./types.ts";

export const RSI_DEFAULTS = { length: 14 };

export const def: IndicatorDef<typeof RSI_DEFAULTS> = {
  id: "rsi",
  label: "RSI",
  version: 1,
  source: { url: "https://www.tradingview.com/scripts/search/relative+strength+index/", author: "TradingView built-in", license: "built-in" },
  defaults: RSI_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "sub",
  title: "RSI(14) with 30/70 lines.",
  compute(bars, opts) {
    const o = { ...RSI_DEFAULTS, ...opts };
    return { series: { rsi: rsi(bars.map((b) => b.close), o.length) }, events: [], view: { lines: [{ key: "rsi", color: "#a78bfa" }], hlines: [30, 70] } };
  },
};
