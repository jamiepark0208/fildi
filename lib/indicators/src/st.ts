import { superTrend } from "./ut-st.ts";
import type { IndEvent, IndicatorDef } from "./types.ts";

export const ST_DEFAULTS = { factor: 3, atrLength: 10 };
const GREEN = "#22c55e", RED = "#ef4444";

export const def: IndicatorDef<typeof ST_DEFAULTS> = {
  id: "st",
  label: "SuperTrend",
  version: 1,
  source: { url: "https://www.tradingview.com/scripts/search/supertrend/", author: "TradingView built-in", license: "built-in" },
  defaults: ST_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "price",
  title: "ATR(10)x3 line: green under price = up, red over = down.",
  chartKinds: [], // the coloured line shows flips; the events feed the track record
  compute(bars, opts) {
    const o = { ...ST_DEFAULTS, ...opts };
    const { line, dir } = superTrend(bars, o.factor, o.atrLength);
    const events: IndEvent[] = [];
    for (let i = 1; i < bars.length; i++) {
      if (dir[i - 1] !== 0 && dir[i] !== 0 && dir[i] !== dir[i - 1]) {
        events.push({ time: bars[i]!.time, side: dir[i]! > 0 ? "buy" : "sell", kind: "Flip", price: bars[i]!.close, note: [`SuperTrend flipped ${dir[i]! > 0 ? "up" : "down"}`] });
      }
    }
    return { series: { st: line }, events, view: { lines: [{ key: "st", color: GREEN, width: 2, colors: dir.map((d) => (d > 0 ? GREEN : RED)) }] } };
  },
};
