import YahooFinanceClass from "yahoo-finance2";
import { RSI, MFI, ATR, MACD, Stochastic } from "technicalindicators";
import { eq, and, gte, inArray } from "drizzle-orm";
import { db, pricesHistorical, indicatorCache } from "@workspace/db";
import { RSI_THRESHOLDS, MFI_THRESHOLD, getTier } from "./constants.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  // Core
  rsi: number;
  rsiYesterday: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  // Extended
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

interface SeedContext {
  spyRows?: OHLCVRow[];
  high52w?: number;
  low52w?: number;
  earningsDate?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function cutoffStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 290);
  return d.toISOString().slice(0, 10);
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

// ── Compute all indicators from OHLCV ────────────────────────────────────────

function computeIndicators(key: string, rows: OHLCVRow[], ctx: SeedContext = {}): IndicatorResult {
  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  // Core
  const rsiValues = RSI.calculate({ period: 14, values: closes });
  const mfiValues = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });
  const rsi = round2(lastOf(rsiValues));
  const rsiYesterday = round2(rsiValues.length >= 2 ? rsiValues[rsiValues.length - 2] : rsi);
  const mfi = round2(lastOf(mfiValues));

  // ATR
  let atr: number | null = null;
  try {
    const vals = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    atr = round2(lastOf(vals));
  } catch {}

  // MACD cross
  let macdCross: IndicatorResult["macdCross"] = null;
  try {
    const vals = MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      values: closes, SimpleMAOscillator: false, SimpleMASignal: false,
    });
    if (vals.length >= 2) {
      const prev = vals[vals.length - 2];
      const curr = vals[vals.length - 1];
      if (curr.MACD != null && curr.signal != null && prev.MACD != null && prev.signal != null) {
        const crossUp   = prev.MACD <= prev.signal && curr.MACD > curr.signal;
        const crossDown = prev.MACD >= prev.signal && curr.MACD < curr.signal;
        if (crossUp)        macdCross = "BULLISH_CROSS";
        else if (crossDown) macdCross = "BEARISH_CROSS";
        else if (curr.MACD > curr.signal) macdCross = "BULLISH";
        else                              macdCross = "BEARISH";
      }
    }
  } catch {}

  // Stochastic %K
  let stoch: number | null = null;
  try {
    const vals = Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: closes });
    if (vals.length > 0) stoch = round2(vals[vals.length - 1].k);
  } catch {}

  // 5-day return
  let return5d: number | null = null;
  if (rows.length >= 6) {
    return5d = round2((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] * 100);
  }

  // 52w position — use yfinance-supplied range if available, else 90d range as proxy
  let position52w: number | null = null;
  const hi = ctx.high52w ?? Math.max(...highs);
  const lo = ctx.low52w  ?? Math.min(...lows);
  if (hi > lo) {
    position52w = round2((closes[closes.length - 1] - lo) / (hi - lo) * 100);
  }

  // vs SPY 20d
  let vsSpy20d: number | null = null;
  if (ctx.spyRows && ctx.spyRows.length >= 21 && closes.length >= 21) {
    const spyCloses = ctx.spyRows.map(r => r.close);
    const spyReturn   = (spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 21]) / spyCloses[spyCloses.length - 21] * 100;
    const stockReturn = (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100;
    vsSpy20d = round2(stockReturn - spyReturn);
  }

  // Last close price
  const price = closes[closes.length - 1];

  // 30d realized volatility (annualized %)
  let ivCurrent = 0;
  const vol30Slice = closes.slice(-31);
  if (vol30Slice.length >= 2) {
    const lr = vol30Slice.slice(1).map((c, i) => Math.log(c / vol30Slice[i]));
    const mean = lr.reduce((s, v) => s + v, 0) / lr.length;
    const variance = lr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (lr.length - 1);
    ivCurrent = round2(Math.sqrt(variance * 252) * 100);
  }

  // IV percentile — ivCurrent's rank within rolling 30d vols over trailing 90 data points
  let ivPercentile = 50;
  const rollingVols: number[] = [];
  for (let end = Math.max(30, closes.length - 90); end < closes.length; end++) {
    const sl = closes.slice(end - 30, end + 1);
    const lr2 = sl.slice(1).map((c, i) => Math.log(c / sl[i]));
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

  // 200d simple moving average
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

// ── DB helpers ────────────────────────────────────────────────────────────────

function rowToResult(r: typeof indicatorCache.$inferSelect): IndicatorResult {
  const rsiThreshold = Number(r.rsiThreshold);
  const rsi = Number(r.rsi);
  const mfi = Number(r.mfi);
  return {
    ticker:       r.ticker,
    scoredDate:   r.scoredDate,
    rsi,
    mfi,
    rsiThreshold,
    mfiThreshold: MFI_THRESHOLD,
    rsiOk:        rsi < rsiThreshold,
    mfiOk:        mfi < MFI_THRESHOLD,
    signal:       r.signal as IndicatorResult["signal"],
    tier:         getTier(r.ticker),
    atr:          r.atr          != null ? Number(r.atr)         : null,
    macdCross:    r.macdCross    as IndicatorResult["macdCross"] ?? null,
    stoch:        r.stoch        != null ? Number(r.stoch)       : null,
    return5d:     r.return5d     != null ? Number(r.return5d)    : null,
    position52w:  r.position52w  != null ? Number(r.position52w) : null,
    vsSpy20d:     r.vsSpy20d     != null ? Number(r.vsSpy20d)    : null,
    earningsDate: r.earningsDate ?? null,
    rsiYesterday: 0,
    price:        0,
    ivCurrent:    0,
    ivPercentile: 50,
    ma200:        null,
  };
}

async function readFromCache(key: string): Promise<IndicatorResult | null> {
  const rows = await db.select()
    .from(indicatorCache)
    .where(and(eq(indicatorCache.ticker, key), eq(indicatorCache.scoredDate, todayStr())))
    .limit(1);
  return rows.length ? rowToResult(rows[0]) : null;
}

async function writeToCache(key: string, result: IndicatorResult): Promise<void> {
  await db.insert(indicatorCache)
    .values({
      ticker:       key,
      scoredDate:   result.scoredDate,
      rsi:          String(result.rsi),
      mfi:          String(result.mfi),
      rsiThreshold: String(result.rsiThreshold),
      signal:       result.signal,
      atr:          result.atr          != null ? String(result.atr)         : null,
      macdCross:    result.macdCross    ?? null,
      stoch:        result.stoch        != null ? String(result.stoch)       : null,
      return5d:     result.return5d     != null ? String(result.return5d)    : null,
      position52w:  result.position52w  != null ? String(result.position52w) : null,
      vsSpy20d:     result.vsSpy20d     != null ? String(result.vsSpy20d)    : null,
      earningsDate: result.earningsDate ?? null,
    })
    .onConflictDoUpdate({
      target: [indicatorCache.ticker, indicatorCache.scoredDate],
      set: {
        rsi:          String(result.rsi),
        mfi:          String(result.mfi),
        rsiThreshold: String(result.rsiThreshold),
        signal:       result.signal,
        atr:          result.atr          != null ? String(result.atr)         : null,
        macdCross:    result.macdCross    ?? null,
        stoch:        result.stoch        != null ? String(result.stoch)       : null,
        return5d:     result.return5d     != null ? String(result.return5d)    : null,
        position52w:  result.position52w  != null ? String(result.position52w) : null,
        vsSpy20d:     result.vsSpy20d     != null ? String(result.vsSpy20d)    : null,
        earningsDate: result.earningsDate ?? null,
      },
    });
}

export async function readOHLCVFromDB(key: string): Promise<OHLCVRow[]> {
  const rows = await db.select()
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, key), gte(pricesHistorical.date, cutoffStr())))
    .orderBy(pricesHistorical.date);
  return rows.map(r => ({
    close:  parseFloat(r.close  as string),
    high:   parseFloat(r.high   as string),
    low:    parseFloat(r.low    as string),
    volume: Number(r.volume ?? 0),
  }));
}

export async function fetchAndStoreOHLCV(key: string): Promise<OHLCVRow[]> {
  const period1 = cutoffStr();
  const period2 = todayStr();

  const raw = await yahooFinance.historical(key, { period1, period2, interval: "1d" }, { validateResult: false }) as Array<{
    date: Date; open: number; high: number; low: number; close: number; volume: number;
  }>;

  if (raw.length < 15) throw new Error(`Insufficient history for ${key}: ${raw.length} rows`);

  await db.insert(pricesHistorical)
    .values(raw.map(r => ({
      ticker: key,
      date:   r.date.toISOString().slice(0, 10),
      open:   String(r.open),
      high:   String(r.high),
      low:    String(r.low),
      close:  String(r.close),
      volume: r.volume,
    })))
    .onConflictDoNothing();

  return raw.map(r => ({ close: r.close, high: r.high, low: r.low, volume: r.volume }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getIndicators(ticker: string, refresh = false, ctx: SeedContext = {}): Promise<IndicatorResult> {
  const key = ticker.toUpperCase();

  if (!refresh) {
    const cached = await readFromCache(key);
    if (cached) return cached;
  }

  let rows = await readOHLCVFromDB(key);
  if (rows.length < 60) {
    rows = await fetchAndStoreOHLCV(key);
  }

  const result = computeIndicators(key, rows, ctx);
  await writeToCache(key, result);
  return result;
}

export async function getIndicatorsBatch(
  tickers: string[],
  refresh = false,
  ctx: SeedContext = {},
): Promise<Record<string, IndicatorResult | { error: string }>> {
  const results: Record<string, IndicatorResult | { error: string }> = {};
  const queue = [...tickers];

  async function worker() {
    while (queue.length > 0) {
      const ticker = queue.shift()!;
      try {
        results[ticker] = await getIndicators(ticker, refresh, ctx);
      } catch (err: any) {
        results[ticker] = { error: String(err?.message ?? err) };
      }
    }
  }

  await Promise.all(Array.from({ length: 3 }, worker));
  return results;
}

// Enrich an IndicatorResult with fields computed from stored OHLCV rows
function enrichWithOHLCV(base: IndicatorResult, ohlcv: OHLCVRow[]): IndicatorResult {
  const closes = ohlcv.map(r => r.close);
  const price  = closes[closes.length - 1];

  let rsiYesterday = base.rsi;
  try {
    const rsiVals = RSI.calculate({ period: 14, values: closes });
    if (rsiVals.length >= 2) rsiYesterday = round2(rsiVals[rsiVals.length - 2]);
  } catch {}

  let ivCurrent = 0;
  const vol30 = closes.slice(-31);
  if (vol30.length >= 2) {
    const lr  = vol30.slice(1).map((c, i) => Math.log(c / vol30[i]));
    const avg = lr.reduce((s, v) => s + v, 0) / lr.length;
    const vr  = lr.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (lr.length - 1);
    ivCurrent = round2(Math.sqrt(vr * 252) * 100);
  }

  let ivPercentile = 50;
  const rollingVols: number[] = [];
  for (let end = Math.max(30, closes.length - 90); end < closes.length; end++) {
    const sl  = closes.slice(end - 30, end + 1);
    const lr2 = sl.slice(1).map((c, i) => Math.log(c / sl[i]));
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

// Read cached indicators for today, enriched with OHLCV-computed fields.
// On a new day (empty cache), falls back to yesterday's tickers and recomputes
// fresh from stored OHLCV — no Yahoo Finance calls needed.
export async function getAllCachedIndicators(): Promise<IndicatorResult[]> {
  let cachedRows = await db.select()
    .from(indicatorCache)
    .where(eq(indicatorCache.scoredDate, todayStr()));

  let tickers: string[];
  let useStoredCache = cachedRows.length > 0;

  if (!useStoredCache) {
    // New day — get tickers from yesterday's cache
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const prev = await db.select({ ticker: indicatorCache.ticker })
      .from(indicatorCache)
      .where(eq(indicatorCache.scoredDate, yesterday.toISOString().slice(0, 10)));
    if (prev.length === 0) return [];
    tickers = prev.map(r => r.ticker);
  } else {
    tickers = cachedRows.map(r => r.ticker);
  }

  // Batch-fetch stored OHLCV — one query, no Yahoo Finance
  const priceRows = await db.select()
    .from(pricesHistorical)
    .where(and(
      inArray(pricesHistorical.ticker, tickers),
      gte(pricesHistorical.date, cutoffStr()),
    ))
    .orderBy(pricesHistorical.ticker, pricesHistorical.date);

  const ohlcvByTicker = new Map<string, OHLCVRow[]>();
  for (const r of priceRows) {
    if (!ohlcvByTicker.has(r.ticker)) ohlcvByTicker.set(r.ticker, []);
    ohlcvByTicker.get(r.ticker)!.push({
      close:  parseFloat(r.close  as string),
      high:   parseFloat(r.high   as string),
      low:    parseFloat(r.low    as string),
      volume: Number(r.volume ?? 0),
    });
  }

  if (useStoredCache) {
    // Enrich today's cached rows with new fields
    return cachedRows.map(r => {
      const base  = rowToResult(r);
      const ohlcv = ohlcvByTicker.get(r.ticker);
      if (!ohlcv || ohlcv.length < 15) return base;
      return enrichWithOHLCV(base, ohlcv);
    });
  } else {
    // New day: recompute everything from stored OHLCV (RSI/MFI/signal included)
    return tickers
      .map(ticker => {
        const ohlcv = ohlcvByTicker.get(ticker);
        if (!ohlcv || ohlcv.length < 15) return null;
        return computeIndicators(ticker, ohlcv);
      })
      .filter((r): r is IndicatorResult => r !== null);
  }
}
