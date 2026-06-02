import YahooFinanceClass from "yahoo-finance2";
import { eq } from "drizzle-orm";
import { db, indicatorCache, tickerConfig } from "@workspace/db";
import { WATCHLIST, RSI_THRESHOLDS, getTier } from "./constants.js";
import { getIndicators, fetchAndStoreOHLCV, readOHLCVFromDB, type OHLCVRow } from "./indicators.js";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Seed ticker_config from constants if the table is empty.
async function seedTickerConfig(): Promise<void> {
  const existing = await db.select().from(tickerConfig).limit(1);
  if (existing.length > 0) return;

  await db.insert(tickerConfig)
    .values(WATCHLIST.map(ticker => ({
      ticker,
      tier:         getTier(ticker),
      rsiThreshold: String(RSI_THRESHOLDS[ticker] ?? 40),
    })))
    .onConflictDoNothing();

  logger.info({ count: WATCHLIST.length }, "seeder: ticker_config populated");
}

// Return tickers not yet in today's indicator_cache.
async function getMissingTickers(): Promise<string[]> {
  const today = todayStr();
  const done  = await db.select({ ticker: indicatorCache.ticker })
    .from(indicatorCache)
    .where(eq(indicatorCache.scoredDate, today));
  const doneSet = new Set(done.map(r => r.ticker));
  return WATCHLIST.filter(t => !doneSet.has(t));
}

// Fetch SPY OHLCV (needed for vs_spy_20d calculation).
async function getSpyRows(): Promise<OHLCVRow[]> {
  try {
    const rows = await readOHLCVFromDB("SPY");
    if (rows.length >= 21) return rows;
    return await fetchAndStoreOHLCV("SPY");
  } catch (err) {
    logger.warn({ err }, "seeder: could not fetch SPY rows — vsSpy20d will be null");
    return [];
  }
}

// Fetch 52w range + earnings date for one ticker via quoteSummary.
async function fetchContext(ticker: string): Promise<{ high52w?: number; low52w?: number; earningsDate?: string | null }> {
  try {
    const s = await yahooFinance.quoteSummary(
      ticker,
      { modules: ["summaryDetail", "calendarEvents"] },
      { validateResult: false },
    ) as any;

    const high52w = s?.summaryDetail?.fiftyTwoWeekHigh ?? undefined;
    const low52w  = s?.summaryDetail?.fiftyTwoWeekLow  ?? undefined;

    let earningsDate: string | null = null;
    const dates = s?.calendarEvents?.earnings?.earningsDate;
    if (Array.isArray(dates) && dates.length > 0) {
      const d = dates[0];
      earningsDate = d instanceof Date ? d.toISOString().slice(0, 10) : null;
    }

    return { high52w, low52w, earningsDate };
  } catch {
    return {};
  }
}

// Run the full seed — call fire-and-forget from index.ts.
export async function runSeed(): Promise<void> {
  try {
    await seedTickerConfig();

    const missing = await getMissingTickers();
    if (missing.length === 0) {
      logger.info("seeder: all tickers up to date");
      return;
    }

    logger.info({ count: missing.length }, "seeder: starting background fill");

    const spyRows = await getSpyRows();

    const queue = [...missing];

    async function worker() {
      while (queue.length > 0) {
        const ticker = queue.shift()!;
        try {
          const ctx = await fetchContext(ticker);
          await getIndicators(ticker, true, { spyRows: spyRows.length ? spyRows : undefined, ...ctx });
          logger.debug({ ticker }, "seeder: ticker done");
        } catch (err: any) {
          logger.warn({ ticker, err: String(err?.message ?? err) }, "seeder: ticker failed");
        }
      }
    }

    await Promise.all(Array.from({ length: 3 }, worker));
    logger.info({ count: missing.length }, "seeder: finished");
  } catch (err) {
    logger.error({ err }, "seeder: top-level failure");
  }
}
