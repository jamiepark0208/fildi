import { highest, lowest, type Series } from "./pine.ts";
import type { TvBar } from "./types.ts";

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
