import { highest, linreg, lowest, nz, sma, stdev, tr, type Series } from "./pine.ts";
import type { IndicatorDef, IndEvent, TvBar } from "./types.ts";

/** LazyBear "Squeeze Momentum Indicator" v1 defaults. */
export type SqueezeOptions = { bbLength: number; bbMult: number; kcLength: number; kcMult: number; useTrueRange: boolean };
export const SQUEEZE_DEFAULTS: SqueezeOptions = { bbLength: 20, bbMult: 2.0, kcLength: 20, kcMult: 1.5, useTrueRange: true };

export type SqueezeBarColor = "lime" | "green" | "red" | "maroon";
/** On = squeeze on (black cross), off = squeeze released (gray), none = neither (blue). */
export type SqueezeState = "on" | "off" | "none";

export type SqueezeResult = {
  val: Series;
  barColor: (SqueezeBarColor | null)[];
  state: (SqueezeState | null)[];
  /** Bars where the squeeze turned on / off (state change), for event lists. */
  events: { i: number; time: number; kind: "squeeze-on" | "squeeze-off" }[];
};

/**
 * Line-by-line port of LazyBear SQZMOM_LB. Quirk kept on purpose: the Bollinger deviation uses multKC (1.5), not `mult`
 * (2.0) — `dev = multKC * stdev(source, length)` in the original source.
 */
export function squeeze(bars: TvBar[], opt: Partial<SqueezeOptions> = {}): SqueezeResult {
  const o = { ...SQUEEZE_DEFAULTS, ...opt };
  const n = bars.length;
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  // Calculate BB
  const basis = sma(close, o.bbLength);
  const sd = stdev(close, o.bbLength);
  // Calculate KC
  const ma = sma(close, o.kcLength);
  const range = o.useTrueRange ? tr(high, low, close) : high.map((h, i) => h - low[i]!);
  const rangema = sma(range, o.kcLength);
  const hh = highest(high, o.kcLength);
  const ll = lowest(low, o.kcLength);
  const smaClose = sma(close, o.kcLength);
  const src = close.map((c, i) => c - ((hh[i]! + ll[i]!) / 2 + smaClose[i]!) / 2);
  const val = linreg(src, o.kcLength, 0);

  const barColor: (SqueezeBarColor | null)[] = new Array(n).fill(null);
  const state: (SqueezeState | null)[] = new Array(n).fill(null);
  const events: SqueezeResult["events"] = [];
  for (let i = 0; i < n; i++) {
    const dev = o.kcMult * sd[i]!; // LazyBear: multKC here, not mult
    const upperBB = basis[i]! + dev, lowerBB = basis[i]! - dev;
    const upperKC = ma[i]! + rangema[i]! * o.kcMult, lowerKC = ma[i]! - rangema[i]! * o.kcMult;
    const sqzOn = lowerBB > lowerKC && upperBB < upperKC;
    const sqzOff = lowerBB < lowerKC && upperBB > upperKC;
    const valid = Number.isFinite(upperBB) && Number.isFinite(upperKC);
    if (valid) {
      state[i] = sqzOn ? "on" : sqzOff ? "off" : "none";
      if (i && state[i - 1] && ((state[i] === "on") !== (state[i - 1] === "on"))) {
        events.push({ i, time: bars[i]!.time, kind: state[i] === "on" ? "squeeze-on" : "squeeze-off" });
      }
    }
    const v = val[i]!;
    if (Number.isFinite(v)) {
      const prev = i ? nz(val[i - 1]!) : 0;
      barColor[i] = v > 0 ? (v > prev ? "lime" : "green") : v < prev ? "red" : "maroon";
    }
  }
  return { val, barColor, state, events };
}

const SQZ_BAR: Record<string, string> = { lime: "#00e600", green: "#007a00", red: "#ff2020", maroon: "#7a0000" };
const SQZ_STATE: Record<string, string> = { on: "#e5e7eb", off: "#6b7280", none: "#2962ff" };

export const def: IndicatorDef<SqueezeOptions> = {
  id: "squeeze",
  label: "Squeeze",
  version: 1,
  source: { url: "https://www.tradingview.com/script/nqQ1DT5a-Squeeze-Momentum-Indicator-LazyBear/", author: "LazyBear", license: "open source (TradingView)", pinePath: "research/sources/tradingview/squeeze-momentum-lazybear.pine" },
  defaults: SQUEEZE_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "sub",
  title: "LazyBear momentum bars; cross: white squeeze on, gray off, blue none.",
  chartKinds: [], // the state cross already shows squeeze on/off
  compute(bars, opts) {
    const r = squeeze(bars, opts);
    // Release = squeeze turns off; direction = sign of the momentum bar that bar (the script's own colouring).
    const events: IndEvent[] = r.events
      .filter((e) => e.kind === "squeeze-off")
      .map((e) => {
        const v = r.val[e.i]!;
        return { time: e.time, side: !Number.isFinite(v) ? "neutral" : v > 0 ? "buy" : "sell", kind: "Release", price: bars[e.i]!.close, note: [`squeeze released, momentum ${Number.isFinite(v) ? v.toFixed(3) : "n/a"}`] } satisfies IndEvent;
      });
    return {
      series: { val: r.val, state: r.val.map((v) => (Number.isNaN(v) ? NaN : 0)) },
      events,
      view: {
        lines: [{ key: "state", color: "#6b7280", dots: true, colors: r.state.map((s) => (s ? SQZ_STATE[s]! : null)) }],
        hist: { key: "val", colors: r.barColor.map((c) => (c ? SQZ_BAR[c]! : "transparent")) },
      },
    };
  },
};
