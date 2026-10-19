import { yahooFinance } from "./yahoo-client.js";
import { RSI, MFI, ATR, MACD, Stochastic } from "technicalindicators";
import { eq, and, gte, inArray, desc } from "drizzle-orm";
import { db, pool, pricesHistorical, indicatorCache } from "@workspace/db";
import { RSI_THRESHOLDS, MFI_THRESHOLD, getTier } from "./constants.js";
import { getLivePrices } from "./live-quote.js";
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
export { mergeSchwabYahoo } from "./indicator-bar-merge.js";

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
  d.setDate(d.getDate() - 420); // 420 calendar days ≈ 300 trading days; supports MA200 + 100d warmup
  return d.toISOString().slice(0, 10);
}

/** Yahoo chart/historical treats period2 as an exclusive end date — pass the day after the last session we need. */
function yahooPeriod2Exclusive(): string {
  const d = new Date(`${lastCompletedSessionYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
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

const STALE_OHLCV_DAYS = 4; // calendar cushion; isOHLCVStale also uses ET trading-day lag
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

/** ET calendar YYYY-MM-DD (America/New_York). */
export function etDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Count Mon–Fri dates strictly after `fromYmd` through `toYmd` (inclusive of to if weekday). */
export function etTradingDaysBehind(fromYmd: string | null, toYmd?: string): number {
  if (!fromYmd) return 999;
  const to = toYmd ?? etDateKey();
  const [fy, fm, fd] = fromYmd.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = to.slice(0, 10).split("-").map(Number);
  const cur = new Date(Date.UTC(fy!, fm! - 1, fd!));
  const end = new Date(Date.UTC(ty!, tm! - 1, td!));
  if (cur >= end) return 0;
  let n = 0;
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // UTC date == ET calendar date for these ymd keys
    if (dow !== 0 && dow !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

/**
 * Stale if missing the last completed ET session bar, or > STALE_OHLCV_DAYS calendar days.
 * After the 4pm ET close, yesterday's bar is stale (Schwab often lags Yahoo by hours —
 * without this, schwabOk short-circuits and never calls Yahoo for today's bar).
 * Weekend / Mon pre-open: Friday still equals lastCompletedSessionYmd → not stale.
 */
export function isOHLCVStale(latestDate: string | null): boolean {
  if (!latestDate) return true;
  const ymd = String(latestDate).slice(0, 10);
  if (ymd < lastCompletedSessionYmd()) return true;
  const calDays = (Date.now() - new Date(`${ymd}T16:00:00-04:00`).getTime()) / 86_400_000;
  return calDays > STALE_OHLCV_DAYS;
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

/**
 * Display-only, in-memory recompute of RSI/MFI/Stoch/MACD/signal with the live price
 * substituted as today's bar (close = live price; high/low widened to include it;
 * volume proxied from the prior day since no live volume source is wired). Never
 * writes indicatorCache — the official daily-batch record stays untouched. This lets
 * Live Monitor show signals that move during the day using the exact same scoring
 * logic as the daily pipeline (Technical Scorecard), instead of a second, separate
 * signals engine that could drift from it.
 */
export async function getLiveIndicatorOverlay(
  tickers: string[],
): Promise<Map<string, Pick<IndicatorResult, "rsi" | "mfi" | "stoch" | "macdCross" | "signal">>> {
  const result = new Map<string, Pick<IndicatorResult, "rsi" | "mfi" | "stoch" | "macdCross" | "signal">>();
  const keys = [...new Set(tickers.map(t => t.toUpperCase()))];
  if (keys.length === 0) return result;

  const live = await getLivePrices(keys);

  await Promise.all(keys.map(async key => {
    const livePrice = live.get(key)?.price;
    if (livePrice == null) return;

    const rows = await readOHLCVFromDB(key);
    if (rows.length < 15) return;

    const last = rows[rows.length - 1];
    const liveRows: OHLCVRow[] = [...rows, {
      close: livePrice,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      volume: last.volume,
    }];

    try {
      const r = computeIndicators(key, liveRows);
      result.set(key, { rsi: r.rsi, mfi: r.mfi, stoch: r.stoch, macdCross: r.macdCross, signal: r.signal });
    } catch {
      // Not enough data for some sub-indicator on this ticker — skip overlay, caller falls back to daily value.
    }
  }));

  return result;
}
