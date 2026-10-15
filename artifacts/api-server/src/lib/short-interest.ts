/**
 * Short interest history (Claude, PM role, user 2026-10-14) → Breakdown "Short interest" panel.
 *
 * History: Polygon free `stocks/v1/short-interest` (FINRA, twice a month, back to 2020; 1 call per ticker returns all of it).
 * Fetched on demand when a breakdown opens, stored in `short_interest_history`, refreshed when the newest row is > 7 days old.
 * Current % of float: LSEG `lseg_research.signals_daily.short_pct` (daily). History is plotted as shares short + days to cover,
 * not % float: float changes over time (dilution), so a historical % with today's float would mislead.
 * Polygon free = 5 calls/min → serialized with a 12.5 s gap; a breakdown never waits on a queue (serves what's stored).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export interface ShortInterestPoint { date: string; sharesShort: number; daysToCover: number | null; avgDailyVolume: number | null }
export interface ShortInterestView {
  ticker: string;
  points: ShortInterestPoint[];
  current: { shortPctFloat: number | null; asOf: string | null; freeFloat: number | null };
  fetchedAt: string | null;
  refreshing: boolean;
}

const STALE_DAYS = 7;
const GAP_MS = 12_500;
let ensured = false;
let lastCall = 0;
const inFlight = new Map<string, Promise<void>>();

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS short_interest_history (
      ticker text NOT NULL, settlement_date date NOT NULL, short_interest bigint NOT NULL,
      avg_daily_volume bigint, days_to_cover double precision, source text NOT NULL DEFAULT 'polygon',
      fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, settlement_date))`);
  ensured = true;
}

async function fetchPolygon(ticker: string): Promise<void> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return;
  const wait = lastCall + GAP_MS - Date.now();
  lastCall = Math.max(Date.now(), lastCall + GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const url = `https://api.polygon.io/stocks/v1/short-interest?ticker=${encodeURIComponent(ticker)}&limit=1000&sort=settlement_date.asc&apiKey=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    logger.warn({ ticker, status: res.status }, "short-interest: polygon fetch failed");
    return;
  }
  const body = (await res.json()) as { results?: Array<{ settlement_date: string; short_interest: number; avg_daily_volume?: number; days_to_cover?: number }> };
  const rows = (body.results ?? []).filter((r) => r.settlement_date && Number.isFinite(r.short_interest));
  if (rows.length === 0) {
    // remember the empty answer so we don't re-ask Polygon every page view
    await db.execute(sql`INSERT INTO short_interest_history (ticker, settlement_date, short_interest, source)
      VALUES (${ticker}, '1900-01-01', 0, 'polygon-empty') ON CONFLICT (ticker, settlement_date) DO UPDATE SET fetched_at = now()`);
    return;
  }
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO short_interest_history (ticker, settlement_date, short_interest, avg_daily_volume, days_to_cover)
      VALUES (${ticker}, ${r.settlement_date}, ${Math.round(r.short_interest)}, ${r.avg_daily_volume == null ? null : Math.round(r.avg_daily_volume)},
              ${r.days_to_cover ?? null})
      ON CONFLICT (ticker, settlement_date) DO UPDATE SET short_interest = excluded.short_interest,
        avg_daily_volume = excluded.avg_daily_volume, days_to_cover = excluded.days_to_cover, fetched_at = now()`);
  }
}

function refresh(ticker: string): Promise<void> {
  const existing = inFlight.get(ticker);
  if (existing) return existing;
  const p = fetchPolygon(ticker)
    .catch((err) => logger.warn({ ticker, err: String(err) }, "short-interest: refresh error"))
    .finally(() => inFlight.delete(ticker));
  inFlight.set(ticker, p);
  return p;
}

export async function getShortInterest(rawTicker: string): Promise<ShortInterestView> {
  const ticker = rawTicker.trim().toUpperCase();
  await ensureTable();
  const read = async () => rowsOf<{ settlement_date: string; short_interest: string; days_to_cover: number | null; avg_daily_volume: string | null; fetched_at: string; source: string }>(
    (await db.execute(sql`SELECT settlement_date::text, short_interest, days_to_cover, avg_daily_volume, fetched_at::text, source
      FROM short_interest_history WHERE ticker = ${ticker} ORDER BY settlement_date`)) as SqlRows<never>);
  let rows = await read();
  const newest = rows.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), "");
  const stale = !newest || Date.now() - new Date(newest).getTime() > STALE_DAYS * 86_400_000;
  let refreshing = false;
  if (stale) {
    if (rows.length === 0) {
      await refresh(ticker); // first view: wait once (≤ ~13 s worst case) so the chart isn't empty
      rows = await read();
    } else {
      refreshing = true;
      void refresh(ticker);
    }
  }
  const cur = rowsOf<{ short_pct: number | null; free_float: number | null; as_of: string }>((await db.execute(sql`
    SELECT short_pct::float8 AS short_pct, free_float::float8 AS free_float, as_of::text FROM lseg_research.signals_daily
    WHERE ticker = ${ticker} ORDER BY as_of DESC LIMIT 1`)) as SqlRows<never>)[0];
  return {
    ticker,
    points: rows.filter((r) => r.source === "polygon").map((r) => ({
      date: r.settlement_date, sharesShort: Number(r.short_interest), daysToCover: r.days_to_cover,
      avgDailyVolume: r.avg_daily_volume == null ? null : Number(r.avg_daily_volume),
    })),
    current: { shortPctFloat: cur?.short_pct ?? null, asOf: cur?.as_of ?? null, freeFloat: cur?.free_float ?? null },
    fetchedAt: newest || null,
    refreshing,
  };
}
