import { utBot } from "./ut-st.ts";
import type { IndicatorDef } from "./types.ts";

export const UT_DEFAULTS = { key: 1, atrLength: 10 };

export const def: IndicatorDef<typeof UT_DEFAULTS> = {
  id: "ut",
  label: "UT Bot",
  version: 1,
  source: { url: "https://www.tradingview.com/script/n8ss8BID-UT-Bot-Alerts/", author: "QuantNomad", license: "open source (TradingView)" },
  defaults: UT_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "price",
  title: "Buy/Sell arrows when the close crosses the ATR(10)x1 trailing stop.",
  compute(bars, opts) {
    const o = { ...UT_DEFAULTS, ...opts };
    const { signals } = utBot(bars, o.key, o.atrLength);
    const close = new Map(bars.map((b) => [b.time, b.close]));
    return {
      series: {},
      events: signals.map((s) => ({
        time: s.time, side: s.side, kind: s.side === "buy" ? "Buy" : "Sell", price: close.get(s.time)!,
        note: [`UT Bot ${s.side}: close crossed ${s.side === "buy" ? "above" : "below"} the ATR(${o.atrLength})x${o.key} trail`],
      })),
      view: { lines: [] },
    };
  },
};
