/**
 * @workspace/indicators — one home for the TradingView indicator ports (Pine-exact primitives, resample, each indicator).
 * Adding an indicator = one file exporting `def` (see ADDING.md) + one line in INDICATORS below. Both charts and the
 * nightly track-record grader read this registry; nothing else lists indicators.
 */
import { def as ichimoku } from "./ichimoku.ts";
import { def as lsh } from "./lsh.ts";
import { def as macd } from "./macd.ts";
import { def as mso } from "./mso.ts";
import { def as rsi } from "./rsi.ts";
import { def as squeeze } from "./squeeze.ts";
import { def as st } from "./st.ts";
import { def as ut } from "./ut.ts";
import type { IndEvent, IndOutput, IndLineView, IndicatorDef, MarkerStyle, TvBar } from "./types.ts";
import type { Series } from "./pine.ts";

export type { TvBar, TvTimeframe, IndEvent, IndOutput, IndicatorDef, IndView, IndLineView, IndHistView, MarkerStyle } from "./types.ts";
export { resample, etClock, TF_MINUTES, type ResampledBar } from "./resample.ts";
export { atr, superTrend, utBot, type OHLC, type UtSignal } from "./ut-st.ts";
export type { Series } from "./pine.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const INDICATORS: IndicatorDef<any>[] = [ut, st, ichimoku, lsh, squeeze, mso, rsi, macd];
export type TvIndicatorId = "ut" | "st" | "ichimoku" | "squeeze" | "mso" | "lsh" | "rsi" | "macd";
export const INDICATOR_BY_ID: Record<string, IndicatorDef<any>> = Object.fromEntries(INDICATORS.map((d) => [d.id, d])); // eslint-disable-line @typescript-eslint/no-explicit-any

// ── Chart adapter: the shape the shared chart layer draws ──────────────────────────────────────────────────────────

export type IndLine = Omit<IndLineView, "key"> & { key: string; values: Series };
export type IndHist = { key: string; values: Series; colors: string[]; base?: number };
export type IndMarker = {
  i: number;
  side: "up" | "down";
  text: string;
  color: string;
  shape?: "arrow" | "circle" | "square";
  /** The event's own facts, shown on hover. */
  detail: string;
};
export type IndResult = { lines: IndLine[]; hist?: IndHist; hlines?: number[]; markers: IndMarker[] };

const GREEN = "#22c55e", RED = "#ef4444";

function markerFor(def: IndicatorDef<any>, e: IndEvent, i: number): IndMarker { // eslint-disable-line @typescript-eslint/no-explicit-any
  const s: MarkerStyle = def.marker ? def.marker(e) : { text: e.kind, color: e.side === "buy" ? GREEN : RED };
  return { i, side: e.side === "sell" ? "down" : "up", text: s.text, color: s.color, shape: s.shape, detail: (e.note ?? [e.kind]).join(" · ") };
}

/** Series + events → what the chart layer draws. Events with side "neutral" and kinds outside `chartKinds` are not marked. */
export function toIndResult(def: IndicatorDef<any>, bars: TvBar[], out: IndOutput): IndResult { // eslint-disable-line @typescript-eslint/no-explicit-any
  const idx = new Map(bars.map((b, i) => [b.time, i]));
  const kinds = def.chartKinds;
  const markers: IndMarker[] = [];
  for (const e of out.events) {
    if (e.side === "neutral" || (kinds && !kinds.includes(e.kind))) continue;
    const i = idx.get(e.time);
    if (i != null) markers.push(markerFor(def, e, i));
  }
  const v = out.view;
  return {
    lines: v.lines.map((l) => ({ ...l, values: out.series[l.key] ?? [] })),
    hist: v.hist ? { key: v.hist.key, base: v.hist.base, colors: v.hist.colors, values: out.series[v.hist.key] ?? [] } : undefined,
    hlines: v.hlines,
    markers,
  };
}

/** Back-compat shape for the charts: `compute(bars)` returns drawable arrays + markers at the script defaults. */
export type TvIndicator = {
  id: TvIndicatorId;
  label: string;
  pane: "price" | "sub";
  title: string;
  compute: (bars: TvBar[]) => IndResult;
};
export const TV_INDICATORS: TvIndicator[] = INDICATORS.map((d) => ({
  id: d.id as TvIndicatorId,
  label: d.label,
  pane: d.pane,
  title: d.title,
  compute: (bars: TvBar[]) => toIndResult(d, bars, d.compute(bars)),
}));
export const TV_INDICATOR_BY_ID: Record<TvIndicatorId, TvIndicator> = Object.fromEntries(TV_INDICATORS.map((x) => [x.id, x])) as Record<TvIndicatorId, TvIndicator>;
