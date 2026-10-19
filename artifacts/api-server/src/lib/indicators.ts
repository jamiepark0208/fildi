import { yahooFinance } from "./yahoo-client.js";
import { eq, and, gte, inArray, desc } from "drizzle-orm";
import { db, pool, pricesHistorical, indicatorCache } from "@workspace/db";
import { MFI_THRESHOLD, getTier } from "./constants.js";
import {
  computeIndicators,
  enrichWithOHLCV,
  todayStr,
  type IndicatorResult,
  type OHLCVRow,
  type SeedContext,
} from "./indicator-compute.js";
export type { IndicatorResult, OHLCVRow, SeedContext } from "./indicator-compute.js";
import { logger } from "./logger.js";
import { getSchwabDailyBars } from "./schwab-client.js";
import { schwabSymbol, yahooSymbol } from "./vendor-ticker.js";
import { lastCompletedSessionYmd } from "./market-hours.js";
import { decidePriceReplace } from "./price-source-rank.js";
import {
  barYmd,
  mergeSchwabYahoo,
  mergeWithPolygon,
  mergeYahooLseg,
  type SourcedBar,
  type YahooBar,
} from "./indicator-bar-merge.js";
import { fetchPolygonDailyBars } from "./polygon-daily.js";
import { isOHLCVStale } from "./ohlcv-freshness.js";
export { mergeSchwabYahoo } from "./indicator-bar-merge.js";
export { etDateKey, etTradingDaysBehind, isOHLCVStale } from "./ohlcv-freshness.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function cutoffStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 420); // 420 calendar days ≈ 300 trading days; supports MA200 + 100d warmup
  return d.toISOString().slice(0, 10);
}

/** Yahoo chart/historical treats period2 as an exclusive end date — pass the day after the last session we need. */
function yahooPeriod2Exclusive(): string {
  const d = new Date(`${lastCompletedSessionYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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

/** Per-ticker cooldown so a failed/empty Yahoo refresh cannot stampede vendor APIs. */
const OHLCV_FETCH_COOLDOWN_MS = 15 * 60 * 1000;
const ohlcvFetchAttemptAt = new Map<string, number>();

export async function latestOHLCVDate(key: string): Promise<string | null> {
  const rows = await db.select({ date: pricesHistorical.date })
    .from(pricesHistorical)
    .where(eq(pricesHistorical.ticker, key))
    .orderBy(desc(pricesHistorical.date))
    .limit(1);
  return rows[0]?.date ?? null;
}

/** Ensure prices_historical has a fresh window; used by indicators + technicals. */
export async function ensureFreshOHLCV(key: string): Promise<OHLCVRow[]> {
  let rows = await readOHLCVFromDB(key);
  const latest = await latestOHLCVDate(key);
  if (rows.length < 60 || isOHLCVStale(latest)) {
    const upper = key.toUpperCase();
    const lastTry = ohlcvFetchAttemptAt.get(upper) ?? 0;
    if (Date.now() - lastTry < OHLCV_FETCH_COOLDOWN_MS && rows.length >= 60) {
      return rows; // cooldown — do not re-hammer vendors
    }
    rows = await fetchAndStoreOHLCV(key);
  }
  return rows;
}

/**
 * LSEG daily_history fallback when Yahoo returns empty/thin history (A19/A21).
 * Close-only series — synthesize OHLC as close, volume 0 (enough for price freshness
 * + basic technicals; not a full vendor OHLC substitute).
 */
async function fetchOHLCVFromLseg(key: string, period1: string): Promise<YahooBar[]> {
  const { rows } = await pool.query<{
    date: string;
    close: number | null;
  }>(
    `SELECT date::text AS date, close
     FROM lseg_research.daily_history
     WHERE ticker = $1 AND date >= $2::date AND close IS NOT NULL
     ORDER BY date`,
    [key.toUpperCase(), period1],
  );
  return rows.map((r) => {
    const c = Number(r.close);
    return {
      date: new Date(`${r.date}T16:00:00.000Z`),
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 0,
    };
  });
}

export async function fetchAndStoreOHLCV(key: string): Promise<OHLCVRow[]> {
  const upper = key.toUpperCase();
  const lastTry = ohlcvFetchAttemptAt.get(upper) ?? 0;
  if (Date.now() - lastTry < OHLCV_FETCH_COOLDOWN_MS) {
    const cached = await readOHLCVFromDB(upper);
    if (cached.length >= 15) return cached;
  }
  ohlcvFetchAttemptAt.set(upper, Date.now());
  const period1 = cutoffStr();
  const period2 = yahooPeriod2Exclusive();
  // A87: fetch under vendor symbol; upsert still uses registry ticker (`upper`).
  const schwabSym = schwabSymbol(upper);
  const yahooSym = yahooSymbol(upper);

  // Source rank: Schwab (broker, same feed as live quotes/chains) → Yahoo → LSEG soft fill.
  // Yahoo is only called when Schwab is down, unknown symbol, thin or stale.
  let schwab: YahooBar[] = [];
  try {
    const bars = await getSchwabDailyBars(schwabSym, period1);
    schwab = (bars ?? []).map((b) => ({
      date: new Date(`${b.date}T16:00:00.000Z`), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
  } catch (err) {
    logger.warn({ err, ticker: key, schwabSym }, "fetchAndStoreOHLCV: Schwab pricehistory failed");
  }
  const schwabOk = schwab.length >= 15 && !isOHLCVStale(barYmd(schwab[schwab.length - 1]!));

  let yahoo: YahooBar[] = [];
  if (!schwabOk) {
    try {
      yahoo = await yahooFinance.historical(
        yahooSym,
        { period1, period2, interval: "1d" },
        { validateResult: false },
      ) as YahooBar[];
    } catch (err) {
      logger.warn({ err, ticker: key, yahooSym }, "fetchAndStoreOHLCV: Yahoo historical failed");
    }
  }

  let sourced: SourcedBar[] = mergeSchwabYahoo(schwab, yahoo);
  const primaryLatest = sourced.length ? barYmd(sourced[sourced.length - 1]!) : null;
  // Soft LSEG fill when Yahoo is thin/stale *or* LSEG has a newer date. Never required —
  // entitlement / Workspace down / missing schema must not break Yahoo-only names.
  let lseg: YahooBar[] = [];
  try {
    lseg = await fetchOHLCVFromLseg(key, period1);
  } catch (err) {
    logger.warn({ err, ticker: key }, "fetchAndStoreOHLCV: LSEG daily_history fallback skipped");
  }
  if (lseg.length >= 15) {
    const lsegLatest = barYmd(lseg[lseg.length - 1]!);
    const lsegAhead = !primaryLatest || lsegLatest > primaryLatest;
    if (sourced.length < 15 || isOHLCVStale(primaryLatest) || lsegAhead) {
      sourced = sourced.length ? mergeYahooLseg(sourced, lseg) : lseg.map((b) => ({ ...b, source: "lseg" as const }));
      logger.info(
        {
          ticker: key,
          schwabRows: schwab.length,
          yahooRows: yahoo.length,
          primaryLatest,
          lsegRows: lseg.length,
          lsegLatest,
          merged: sourced.length,
          lsegOnly: sourced.filter((b) => b.source === "lseg").length,
        },
        "fetchAndStoreOHLCV: merged/filled from LSEG daily_history",
      );
    }
  }

  // A87: Polygon soft fill when Schwab/Yahoo/LSEG still thin (BK/MMC-class holes).
  if (sourced.length < 15 || isOHLCVStale(sourced.length ? barYmd(sourced[sourced.length - 1]!) : null)) {
    try {
      const poly = await fetchPolygonDailyBars(upper, period1);
      if (poly.length >= 15) {
        sourced = sourced.length
          ? mergeWithPolygon(sourced, poly)
          : poly.map((b) => ({ ...b, source: "polygon" as const }));
        logger.info(
          { ticker: key, polyRows: poly.length, merged: sourced.length },
          "fetchAndStoreOHLCV: filled from Polygon daily aggs",
        );
      }
    } catch (err) {
      logger.warn({ err, ticker: key }, "fetchAndStoreOHLCV: Polygon daily fallback skipped");
    }
  }

  if (sourced.length < 15) throw new Error(`Insufficient history for ${key}: ${sourced.length} rows`);

  // A63: upsert honoring source rank (Schwab > … > Yahoo). Jump ≥ 2% keeps old bar.
  const dates = sourced.map((r) => barYmd(r));
  const existing = dates.length
    ? await db.select({
      date: pricesHistorical.date,
      close: pricesHistorical.close,
      source: pricesHistorical.source,
    }).from(pricesHistorical).where(and(
      eq(pricesHistorical.ticker, key),
      inArray(pricesHistorical.date, dates),
    ))
    : [];
  const byDate = new Map(existing.map((r) => [String(r.date).slice(0, 10), r]));
  const toInsert: typeof sourced = [];
  const toReplace: typeof sourced = [];
  let jumps = 0;
  for (const r of sourced) {
    const d = barYmd(r);
    const ex = byDate.get(d);
    const decision = decidePriceReplace({
      existingClose: ex?.close != null ? Number(ex.close) : null,
      existingSource: ex?.source,
      incomingClose: r.close,
      incomingSource: r.source,
    });
    if (decision.action === "insert") toInsert.push(r);
    else if (decision.action === "replace") toReplace.push(r);
    else if (decision.reason === "jump") jumps += 1;
  }
  if (toInsert.length) {
    await db.insert(pricesHistorical)
      .values(toInsert.map((r) => ({
        ticker: key,
        date: barYmd(r),
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: r.volume,
        source: r.source,
      })))
      .onConflictDoNothing();
  }
  for (const r of toReplace) {
    await db.update(pricesHistorical)
      .set({
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: r.volume,
        source: r.source,
      })
      .where(and(eq(pricesHistorical.ticker, key), eq(pricesHistorical.date, barYmd(r))));
  }
  if (jumps > 0 || toReplace.length > 0) {
    logger.info({ ticker: key, inserted: toInsert.length, replaced: toReplace.length, jumps },
      "fetchAndStoreOHLCV: A63 source-ranked upsert");
  }

  return sourced.map(r => ({ close: r.close, high: r.high, low: r.low, volume: r.volume }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getIndicators(ticker: string, refresh = false, ctx: SeedContext = {}): Promise<IndicatorResult> {
  const key = ticker.toUpperCase();

  if (!refresh) {
    const cached = await readFromCache(key);
    if (cached) return cached;
  }

  let rows = await ensureFreshOHLCV(key);

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

// ── Live overlay → indicator-live-overlay.ts (A83) ───────────────────────────
export { getLiveIndicatorOverlay } from "./indicator-live-overlay.js";

