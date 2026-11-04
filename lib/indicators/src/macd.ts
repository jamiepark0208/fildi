import { ema } from "./pine.ts";
import type { IndicatorDef } from "./types.ts";

export const MACD_DEFAULTS = { fast: 12, slow: 26, signal: 9 };

export const def: IndicatorDef<typeof MACD_DEFAULTS> = {
  id: "macd",
  label: "MACD",
  version: 1,
  source: { url: "https://www.tradingview.com/scripts/search/macd/", author: "TradingView built-in", license: "built-in" },
  defaults: MACD_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "sub",
  title: "MACD(12,26,9) line, signal, histogram.",
  compute(bars, opts) {
    const o = { ...MACD_DEFAULTS, ...opts };
    const c = bars.map((b) => b.close);
    const f = ema(c, o.fast), s = ema(c, o.slow);
    const m = f.map((x, i) => x - s[i]!);
    const sig = ema(m, o.signal);
    const h = m.map((x, i) => x - sig[i]!);
    return {
      series: { macd: m, sig, hist: h },
      events: [],
      view: {
        lines: [{ key: "macd", color: "#38bdf8" }, { key: "sig", color: "#fbbf24" }],
        hist: { key: "hist", colors: h.map((v) => (v >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)")) },
      },
    };
  },
};
