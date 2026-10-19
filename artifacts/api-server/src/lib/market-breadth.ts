/**
 * A96 market breadth — % of US stocks above 50d/200d MA, A/D, new highs−lows.
 * Source: Polygon grouped daily aggs (1 call/day) via shared limiter. Display only — not a signal (S027).
 * Nightly: `upsertBreadthForDate` + `fillMaPctForDate`; Regime chart reads `market_breadth_daily`.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import { isTradingDayYmd, lastCompletedSessionYmd } from "./market-hours.js";
import { polygonApiKey, polygonFetch } from "./polygon-limiter.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

let ensured = false;

async function ensure(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS market_breadth_daily (
      date date PRIMARY KEY,
      pct_above_50 double precision,
      pct_above_200 double precision,
      advance_decline double precision,
      new_highs_minus_lows integer,
      n_stocks integer,
      source text NOT NULL DEFAULT 'polygon',
      fetched_at timestamptz NOT NULL DEFAULT now()
    )`);
  ensured = true;
}

function prevTradingDay(ymd: string): string {
  let d = ymd;
  do {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    d = t.toISOString().slice(0, 10);
  } while (!isTradingDayYmd(d));
  return d;
}

/** Trading days ending at `end` (inclusive), newest last. */
export function tradingDaysBack(n: number, end: string = lastCompletedSessionYmd()): string[] {
  const out: string[] = [];
  let cur = end;
  if (!isTradingDayYmd(cur)) cur = prevTradingDay(cur);
  for (let i = 0; i < n; i++) {
    out.push(cur);
    cur = prevTradingDay(cur);
  }
  return out.reverse();
}

/** Fetch one NYSE/NASDAQ session via Polygon grouped aggs. Caller owns scheduling (nightly). */
export async function upsertBreadthForDate(date: string): Promise<boolean> {
  await ensure();
  const key = polygonApiKey();
  if (!key) return false;
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${key}`;
  const res = await polygonFetch(url);
  if (!res.ok) {
    logger.warn({ date, status: res.status }, "market-breadth: grouped fetch failed");
    return false;
  }
  const body = (await res.json()) as { results?: Array<{ T?: string; c?: number; h?: number; l?: number; o?: number; v?: number }> };
  const bars = (body.results ?? []).filter((b) => b.T && b.c! > 0);
  if (bars.length < 100) return false;
  let adv = 0, dec = 0;
  for (const b of bars) {
    if (b.c! > (b.o ?? b.c!)) adv++;
    else if (b.c! < (b.o ?? b.c!)) dec++;
  }
  // 50/200d % above filled separately from prices_historical (registry actives).
  const ad = dec > 0 ? adv / dec : adv;
  await db.execute(sql`
    INSERT INTO market_breadth_daily (date, advance_decline, n_stocks, pct_above_50, pct_above_200, new_highs_minus_lows)
    VALUES (${date}, ${ad}, ${bars.length}, NULL, NULL, NULL)
    ON CONFLICT (date) DO UPDATE SET advance_decline = excluded.advance_decline, n_stocks = excluded.n_stocks, fetched_at = now()`);
  return true;
}

/**
 * % of active registry tickers with close > SMA50 / SMA200 on `date`.
 * Uses prices_historical only (no Polygon). Skips names without enough history.
 */
export async function fillMaPctForDate(date: string): Promise<boolean> {
  await ensure();
  const rows = rowsOf<{ pct50: number | null; pct200: number | null }>((await db.execute(sql`
    WITH actives AS (
      SELECT ticker FROM ticker_registry WHERE COALESCE(is_active, true)
    ),
    closes AS (
      SELECT p.ticker, p.date::text AS date, p.close::float8 AS close
      FROM prices_historical p
      JOIN actives a ON a.ticker = p.ticker
      WHERE p.date <= ${date}::date AND p.date >= (${date}::date - 320)
    ),
    ranked AS (
      SELECT ticker, date, close,
        avg(close) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 49 PRECEDING AND CURRENT ROW) AS sma50,
        avg(close) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS sma200,
        count(*) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 49 PRECEDING AND CURRENT ROW) AS n50,
        count(*) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS n200
      FROM closes
    ),
    day AS (
      SELECT
        avg(CASE WHEN n50 >= 50 AND close > sma50 THEN 1.0 WHEN n50 >= 50 THEN 0.0 END)::float8 AS pct50,
        avg(CASE WHEN n200 >= 200 AND close > sma200 THEN 1.0 WHEN n200 >= 200 THEN 0.0 END)::float8 AS pct200
      FROM ranked WHERE date = ${date}
    )
    SELECT pct50, pct200 FROM day`)) as SqlRows<never>);
  const pct50 = rows[0]?.pct50 ?? null;
  const pct200 = rows[0]?.pct200 ?? null;
  if (pct50 == null && pct200 == null) return false;
  await db.execute(sql`
    INSERT INTO market_breadth_daily (date, pct_above_50, pct_above_200, advance_decline, n_stocks)
    VALUES (${date}, ${pct50}, ${pct200}, NULL, NULL)
    ON CONFLICT (date) DO UPDATE SET
      pct_above_50 = COALESCE(excluded.pct_above_50, market_breadth_daily.pct_above_50),
      pct_above_200 = COALESCE(excluded.pct_above_200, market_breadth_daily.pct_above_200),
      fetched_at = now()`);
  return true;
}

export async function hasBreadthAd(date: string): Promise<boolean> {
  await ensure();
  const rows = rowsOf<{ n: number }>((await db.execute(sql`
    SELECT 1::int AS n FROM market_breadth_daily
    WHERE date = ${date}::date AND advance_decline IS NOT NULL LIMIT 1`)) as SqlRows<never>);
  return rows.length > 0;
}

/**
 * Backfill A/D (Polygon) for the last `days` sessions, then MA% for dates still null.
 * Skips dates that already have advance_decline. Respects polygon limiter (~5/min).
 * MA% is deferred — per-day window SQL over the full registry is too heavy mid-loop.
 */
export async function backfillMarketBreadth(days: number): Promise<{ ok: number; skip: number; fail: number; ma: number }> {
  const dates = tradingDaysBack(days);
  let ok = 0, skip = 0, fail = 0;
  for (const date of dates) {
    if (await hasBreadthAd(date)) {
      skip++;
      continue;
    }
    const wrote = await upsertBreadthForDate(date);
    if (!wrote) {
      fail++;
      continue;
    }
    ok++;
  }
  let ma = 0;
  // MA% window SQL is heavy — only newest few missing dates (Maintain + long backfill).
  const needMa = rowsOf<{ date: string }>((await db.execute(sql`
    SELECT date::text AS date FROM market_breadth_daily
    WHERE pct_above_50 IS NULL
    ORDER BY date DESC LIMIT 3`)) as SqlRows<never>);
  for (const r of needMa) {
    if (await fillMaPctForDate(r.date)) ma++;
  }
  logger.info({ days, ok, skip, fail, ma }, "market-breadth: backfill done");
  return { ok, skip, fail, ma };
}

export async function getBreadthHistory(days = 400): Promise<Array<{ date: string; pctAbove50: number | null; pctAbove200: number | null; advanceDecline: number | null }>> {
  await ensure();
  return rowsOf<{ date: string; pct_above_50: number | null; pct_above_200: number | null; advance_decline: number | null }>((await db.execute(sql`
    SELECT date::text, pct_above_50, pct_above_200, advance_decline FROM market_breadth_daily
    ORDER BY date DESC LIMIT ${days}`)) as SqlRows<never>)
    .map((r) => ({
      date: r.date,
      pctAbove50: r.pct_above_50,
      pctAbove200: r.pct_above_200,
      advanceDecline: r.advance_decline,
    }))
    .reverse();
}
