import YahooFinanceClass from "yahoo-finance2";
import { RSI, MFI } from "technicalindicators";
import { eq, and, gte } from "drizzle-orm";
import { db, pricesHistorical, scorecardCache } from "@workspace/db";
import { RSI_THRESHOLDS, MFI_THRESHOLD, getTier } from "./constants.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndicatorResult {
  ticker: string;
  rsi: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: typeof MFI_THRESHOLD;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  scoredDate: string;
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

// ── Compute RSI + MFI from raw rows ──────────────────────────────────────────

interface OHLCVRow { close: number; high: number; low: number; volume: number }

function computeIndicators(key: string, rows: OHLCVRow[]): IndicatorResult {
  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  const rsiValues = RSI.calculate({ period: 14, values: closes });
  const mfiValues = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });

  const rsi = Math.round(lastOf(rsiValues) * 100) / 100;
  const mfi = Math.round(lastOf(mfiValues) * 100) / 100;

  const rsiThreshold = RSI_THRESHOLDS[key] ?? 40;
  const rsiOk = rsi < rsiThreshold;
  const mfiOk = mfi < MFI_THRESHOLD;

  return {
    ticker: key,
    rsi,
    mfi,
    rsiThreshold,
    mfiThreshold: MFI_THRESHOLD,
    rsiOk,
    mfiOk,
    signal: toSignal(rsiOk, mfiOk),
    tier: getTier(key),
    scoredDate: todayStr(),
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function readFromCache(key: string): Promise<IndicatorResult | null> {
  const rows = await db.select()
    .from(scorecardCache)
    .where(and(eq(scorecardCache.ticker, key), eq(scorecardCache.scoredDate, todayStr())))
    .limit(1);
  if (!rows.length) return null;
  return rows[0].scores as IndicatorResult;
}

async function writeToCache(key: string, result: IndicatorResult): Promise<void> {
  await db.insert(scorecardCache)
    .values({ ticker: key, scoredDate: todayStr(), scores: result })
    .onConflictDoUpdate({
      target: [scorecardCache.ticker, scorecardCache.scoredDate],
      set: { scores: result },
    });
}

async function readOHLCVFromDB(key: string): Promise<OHLCVRow[]> {
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

async function fetchAndStoreOHLCV(key: string): Promise<OHLCVRow[]> {
  const period1 = cutoffStr();
  const period2 = todayStr();

  const raw = await yahooFinance.historical(key, { period1, period2, interval: "1d" }, { validateResult: false }) as Array<{
    date: Date; open: number; high: number; low: number; close: number; volume: number;
  }>;

  if (raw.length < 15) throw new Error(`Insufficient history for ${key}: ${raw.length} rows`);

  // Persist new rows — conflict on (ticker, date) is silently ignored
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

export async function getIndicators(ticker: string, refresh = false): Promise<IndicatorResult> {
  const key = ticker.toUpperCase();

  if (!refresh) {
    const cached = await readFromCache(key);
    if (cached) return cached;
  }

  // Prefer DB rows; fall back to yfinance if we don't have enough history
  let rows = await readOHLCVFromDB(key);
  if (rows.length < 60) {
    rows = await fetchAndStoreOHLCV(key);
  }

  const result = computeIndicators(key, rows);
  await writeToCache(key, result);
  return result;
}

// Max 3 concurrent yfinance fetches — worker-pool pattern
export async function getIndicatorsBatch(
  tickers: string[],
  refresh = false,
): Promise<Record<string, IndicatorResult | { error: string }>> {
  const results: Record<string, IndicatorResult | { error: string }> = {};
  const queue = [...tickers];

  async function worker() {
    while (queue.length > 0) {
      const ticker = queue.shift()!;
      try {
        results[ticker] = await getIndicators(ticker, refresh);
      } catch (err: any) {
        results[ticker] = { error: String(err?.message ?? err) };
      }
    }
  }

  await Promise.all(Array.from({ length: 3 }, worker));
  return results;
}
