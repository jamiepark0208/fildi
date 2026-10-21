/**
 * A83 — pure indicator math from OHLCV (split from indicators.ts).
 */
import { RSI, MFI, ATR, MACD, Stochastic } from "technicalindicators";
import { RSI_THRESHOLDS, MFI_THRESHOLD, getTier } from "./constants.js";
import { etDateKey } from "./market-hours.js";

export interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  rsi: number;
  rsiYesterday: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  atr: number | null;
  macdCross: "BULLISH_CROSS" | "BEARISH_CROSS" | "BULLISH" | "BEARISH" | null;
  stoch: number | null;
  return5d: number | null;
  position52w: number | null;
  vsSpy20d: number | null;
  earningsDate: string | null;
  price: number;
  ivCurrent: number;
  ivPercentile: number;
  ma200: number | null;
}

export interface OHLCVRow { close: number; high: number; low: number; volume: number }

export interface SeedContext {
  spyRows?: OHLCVRow[];
  high52w?: number;
  low52w?: number;
  earningsDate?: string | null;
}

export function todayStr(): string {
  return etDateKey(); // ET market date (was UTC: rolled to tomorrow after 5 PM PT, 10-20)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lastOf(arr: (number | undefined)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== undefined) return arr[i] as number;
  }
  throw new Error("indicator produced no values");
}

function toSignal(rsiOk: boolean, mfiOk: boolean): "GO" | "WATCH" | "NO" {
  if (rsiOk && mfiOk) return "GO";
  if (rsiOk || mfiOk) return "WATCH";
  return "NO";
}

/** Compute all indicators from OHLCV. */
export function computeIndicators(key: string, rows: OHLCVRow[], ctx: SeedContext = {}): IndicatorResult {
  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  const rsiValues = RSI.calculate({ period: 14, values: closes });
  const mfiValues = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });
  const rsi = round2(lastOf(rsiValues));
  const rsiYesterday = round2(rsiValues.length >= 2 ? rsiValues[rsiValues.length - 2]! : rsi);
  const mfi = round2(lastOf(mfiValues));

  let atr: number | null = null;
  try {
    const vals = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    atr = round2(lastOf(vals));
  } catch { /* thin history */ }

  let macdCross: IndicatorResult["macdCross"] = null;
  try {
    const vals = MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      values: closes, SimpleMAOscillator: false, SimpleMASignal: false,
    });
    if (vals.length >= 2) {
      const prev = vals[vals.length - 2]!;
      const curr = vals[vals.length - 1]!;
      if (curr.MACD != null && curr.signal != null && prev.MACD != null && prev.signal != null) {
        const crossUp   = prev.MACD <= prev.signal && curr.MACD > curr.signal;
        const crossDown = prev.MACD >= prev.signal && curr.MACD < curr.signal;
        if (crossUp)        macdCross = "BULLISH_CROSS";
        else if (crossDown) macdCross = "BEARISH_CROSS";
        else if (curr.MACD > curr.signal) macdCross = "BULLISH";
        else                              macdCross = "BEARISH";
      }
    }
  } catch { /* thin history */ }

  let stoch: number | null = null;
  try {
    const vals = Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: closes });
    if (vals.length > 0) stoch = round2(vals[vals.length - 1]!.k);
  } catch { /* thin history */ }

  let return5d: number | null = null;
  if (rows.length >= 6) {
    return5d = round2((closes[closes.length - 1]! - closes[closes.length - 6]!) / closes[closes.length - 6]! * 100);
  }

  let position52w: number | null = null;
  const hi = ctx.high52w ?? Math.max(...highs);
  const lo = ctx.low52w  ?? Math.min(...lows);
  if (hi > lo) {
    position52w = round2((closes[closes.length - 1]! - lo) / (hi - lo) * 100);
  }

  let vsSpy20d: number | null = null;
  if (ctx.spyRows && ctx.spyRows.length >= 21 && closes.length >= 21) {
    const spyCloses = ctx.spyRows.map(r => r.close);
    const spyReturn   = (spyCloses[spyCloses.length - 1]! - spyCloses[spyCloses.length - 21]!) / spyCloses[spyCloses.length - 21]! * 100;
    const stockReturn = (closes[closes.length - 1]! - closes[closes.length - 21]!) / closes[closes.length - 21]! * 100;
    vsSpy20d = round2(stockReturn - spyReturn);
  }

  const price = closes[closes.length - 1]!;

  let ivCurrent = 0;
  const vol30Slice = closes.slice(-31);
  if (vol30Slice.length >= 2) {
    const lr = vol30Slice.slice(1).map((c, i) => Math.log(c / vol30Slice[i]!));
    const mean = lr.reduce((s, v) => s + v, 0) / lr.length;
    const variance = lr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (lr.length - 1);
    ivCurrent = round2(Math.sqrt(variance * 252) * 100);
  }

  let ivPercentile = 50;
  const rollingVols: number[] = [];
  for (let end = Math.max(30, closes.length - 90); end < closes.length; end++) {
    const sl = closes.slice(end - 30, end + 1);
    const lr2 = sl.slice(1).map((c, i) => Math.log(c / sl[i]!));
    const m2 = lr2.reduce((s, v) => s + v, 0) / lr2.length;
    const vr2 = lr2.reduce((s, v) => s + Math.pow(v - m2, 2), 0) / (lr2.length - 1);
    rollingVols.push(Math.sqrt(vr2 * 252) * 100);
  }
  if (rollingVols.length >= 2) {
    const min90d = Math.min(...rollingVols);
    const max90d = Math.max(...rollingVols);
    if (max90d > min90d) {
      ivPercentile = round2(Math.max(0, Math.min(100, (ivCurrent - min90d) / (max90d - min90d) * 100)));
    }
  }

  let ma200: number | null = null;
  if (closes.length >= 200) {
    ma200 = round2(closes.slice(-200).reduce((s, c) => s + c, 0) / 200);
  }

  const rsiThreshold = RSI_THRESHOLDS[key] ?? 40;
  const rsiOk = rsi < rsiThreshold;
  const mfiOk = mfi < MFI_THRESHOLD;

  return {
    ticker:       key,
    scoredDate:   todayStr(),
    rsi, mfi, rsiYesterday,
    rsiThreshold,
    mfiThreshold: MFI_THRESHOLD,
    rsiOk, mfiOk,
    signal:       toSignal(rsiOk, mfiOk),
    tier:         getTier(key),
    atr, macdCross, stoch, return5d, position52w, vsSpy20d,
    price, ivCurrent, ivPercentile, ma200,
    earningsDate: ctx.earningsDate ?? null,
  };
}

/** Enrich a cached IndicatorResult with fields derived from stored OHLCV. */
export function enrichWithOHLCV(base: IndicatorResult, ohlcv: OHLCVRow[]): IndicatorResult {
  const closes = ohlcv.map(r => r.close);
  const price  = closes[closes.length - 1]!;

  let rsiYesterday = base.rsi;
  try {
    const rsiVals = RSI.calculate({ period: 14, values: closes });
    if (rsiVals.length >= 2) rsiYesterday = round2(rsiVals[rsiVals.length - 2]!);
  } catch { /* thin history */ }

  let ivCurrent = 0;
  const vol30 = closes.slice(-31);
  if (vol30.length >= 2) {
    const lr  = vol30.slice(1).map((c, i) => Math.log(c / vol30[i]!));
    const avg = lr.reduce((s, v) => s + v, 0) / lr.length;
    const vr  = lr.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (lr.length - 1);
    ivCurrent = round2(Math.sqrt(vr * 252) * 100);
  }

  let ivPercentile = 50;
  const rollingVols: number[] = [];
  for (let end = Math.max(30, closes.length - 90); end < closes.length; end++) {
    const sl  = closes.slice(end - 30, end + 1);
    const lr2 = sl.slice(1).map((c, i) => Math.log(c / sl[i]!));
    const m2  = lr2.reduce((s, v) => s + v, 0) / lr2.length;
    const vr2 = lr2.reduce((s, v) => s + Math.pow(v - m2, 2), 0) / (lr2.length - 1);
    rollingVols.push(Math.sqrt(vr2 * 252) * 100);
  }
  if (rollingVols.length >= 2) {
    const lo = Math.min(...rollingVols);
    const hi = Math.max(...rollingVols);
    if (hi > lo) ivPercentile = round2(Math.max(0, Math.min(100, (ivCurrent - lo) / (hi - lo) * 100)));
  }

  let ma200: number | null = null;
  if (closes.length >= 200) {
    ma200 = round2(closes.slice(-200).reduce((s, c) => s + c, 0) / 200);
  }

  return { ...base, price, rsiYesterday, ivCurrent, ivPercentile, ma200 };
}
