import YahooFinanceClass from "yahoo-finance2";
import { RSI, MFI, ATR, MACD, Stochastic } from "technicalindicators";
import { eq, and, gte } from "drizzle-orm";
import { db, pricesHistorical, indicatorCache } from "@workspace/db";
import { RSI_THRESHOLDS, MFI_THRESHOLD, getTier } from "./constants.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  // Core
  rsi: number;
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
  d.setDate(d.getDate() - 90);
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

  const rsiThreshold = RSI_THRESHOLDS[key] ?? 40;
  const rsiOk = rsi < rsiThreshold;
  const mfiOk = mfi < MFI_THRESHOLD;

  return {
    ticker:       key,
    scoredDate:   todayStr(),
    rsi, mfi,
    rsiThreshold,
    mfiThreshold: MFI_THRESHOLD,
    rsiOk, mfiOk,
    signal:       toSignal(rsiOk, mfiOk),
    tier:         getTier(key),
    atr, macdCross, stoch, return5d, position52w, vsSpy20d,
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

// Read all cached rows for today (used by the technical scorecard endpoint)
export async function getAllCachedIndicators(): Promise<IndicatorResult[]> {
  const rows = await db.select()
    .from(indicatorCache)
    .where(eq(indicatorCache.scoredDate, todayStr()));
  return rows.map(rowToResult);
}
