/**
 * A96 market breadth — % of US stocks above 50d/200d MA, A/D, new highs−lows.
 * Source: Polygon grouped daily aggs (1 call/day) via shared limiter. Display only — not a signal (S027).
 * Nightly: call `upsertBreadthForDate(date)`; Regime chart reads `market_breadth_daily`.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
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
  // 50/200d % above needs history — store A/D now; MA % filled by nightly job that joins prices_historical.
  const ad = dec > 0 ? adv / dec : adv;
  await db.execute(sql`
    INSERT INTO market_breadth_daily (date, advance_decline, n_stocks, pct_above_50, pct_above_200, new_highs_minus_lows)
    VALUES (${date}, ${ad}, ${bars.length}, NULL, NULL, NULL)
    ON CONFLICT (date) DO UPDATE SET advance_decline = excluded.advance_decline, n_stocks = excluded.n_stocks, fetched_at = now()`);
  return true;
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
