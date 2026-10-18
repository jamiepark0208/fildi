/**
 * Short interest history (Claude, PM role, user 2026-10-14) → Breakdown "Short interest" panel.
 * A96: also short-volume ratio (Polygon stocks/v1/short-volume) — display only, "no proven edge".
 *
 * History: Polygon free `stocks/v1/short-interest` (FINRA, twice a month).
 * Polygon free = 5 calls/min → shared `polygon-limiter.ts`.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import { polygonApiKey, polygonFetch } from "./polygon-limiter.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export interface ShortInterestPoint { date: string; sharesShort: number; daysToCover: number | null; avgDailyVolume: number | null }
export interface ShortVolumePoint { date: string; shortVolumeRatio: number; shortVolume: number; totalVolume: number }
export interface ShortInterestView {
  ticker: string;
  points: ShortInterestPoint[];
  shortVolume: ShortVolumePoint[];
  shortVolumeAvg20: number | null;
  current: { shortPctFloat: number | null; asOf: string | null; freeFloat: number | null };
  fetchedAt: string | null;
  refreshing: boolean;
}

const STALE_DAYS = 7;
let ensured = false;
const inFlight = new Map<string, Promise<void>>();

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS short_interest_history (
      ticker text NOT NULL, settlement_date date NOT NULL, short_interest bigint NOT NULL,
      avg_daily_volume bigint, days_to_cover double precision, source text NOT NULL DEFAULT 'polygon',
      fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, settlement_date))`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS short_volume_daily (
      ticker text NOT NULL, date date NOT NULL, short_volume bigint NOT NULL, total_volume bigint NOT NULL,
      short_volume_ratio double precision, source text NOT NULL DEFAULT 'polygon',
      fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, date))`);
  ensured = true;
}

async function fetchPolygonInterest(ticker: string): Promise<void> {
  const key = polygonApiKey();
  if (!key) return;
  const url = `https://api.polygon.io/stocks/v1/short-interest?ticker=${encodeURIComponent(ticker)}&limit=1000&sort=settlement_date.asc&apiKey=${key}`;
  const res = await polygonFetch(url);
  if (!res.ok) {
    logger.warn({ ticker, status: res.status }, "short-interest: polygon fetch failed");
    return;
  }
  const body = (await res.json()) as { results?: Array<{ settlement_date: string; short_interest: number; avg_daily_volume?: number; days_to_cover?: number }> };
  const rows = (body.results ?? []).filter((r) => r.settlement_date && Number.isFinite(r.short_interest));
  if (rows.length === 0) {
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

async function fetchPolygonVolume(ticker: string): Promise<void> {
  const key = polygonApiKey();
  if (!key) return;
  const url = `https://api.polygon.io/stocks/v1/short-volume?ticker=${encodeURIComponent(ticker)}&limit=60&sort=date.desc&apiKey=${key}`;
  const res = await polygonFetch(url);
  if (!res.ok) {
    logger.warn({ ticker, status: res.status }, "short-volume: polygon fetch failed");
    return;
  }
  const body = (await res.json()) as {
    results?: Array<{ date: string; short_volume?: number; total_volume?: number; short_volume_ratio?: number }>;
  };
  for (const r of body.results ?? []) {
    if (!r.date || !(r.total_volume! > 0)) continue;
    const ratio = r.short_volume_ratio ?? (r.short_volume != null ? r.short_volume / r.total_volume! : null);
    await db.execute(sql`
      INSERT INTO short_volume_daily (ticker, date, short_volume, total_volume, short_volume_ratio)
      VALUES (${ticker}, ${r.date}, ${Math.round(r.short_volume ?? 0)}, ${Math.round(r.total_volume!)}, ${ratio})
      ON CONFLICT (ticker, date) DO UPDATE SET short_volume = excluded.short_volume, total_volume = excluded.total_volume,
        short_volume_ratio = excluded.short_volume_ratio, fetched_at = now()`);
  }
}

function refresh(ticker: string): Promise<void> {
  const existing = inFlight.get(ticker);
  if (existing) return existing;
  const p = Promise.all([fetchPolygonInterest(ticker), fetchPolygonVolume(ticker)])
    .then(() => undefined)
    .catch((err) => logger.warn({ ticker, err: String(err) }, "short-interest: refresh error"))
    .finally(() => inFlight.delete(ticker));
  inFlight.set(ticker, p);
  return p;
}

export async function getShortInterest(rawTicker: string): Promise<ShortInterestView> {
  const ticker = rawTicker.trim().toUpperCase();
  await ensureTable();
  const readInterest = async () => rowsOf<{ settlement_date: string; short_interest: string; days_to_cover: number | null; avg_daily_volume: string | null; fetched_at: string; source: string }>(
    (await db.execute(sql`SELECT settlement_date::text, short_interest, days_to_cover, avg_daily_volume, fetched_at::text, source
      FROM short_interest_history WHERE ticker = ${ticker} ORDER BY settlement_date`)) as SqlRows<never>);
  const readVolume = async () => rowsOf<{ date: string; short_volume: string; total_volume: string; short_volume_ratio: number | null }>(
    (await db.execute(sql`SELECT date::text, short_volume, total_volume, short_volume_ratio
      FROM short_volume_daily WHERE ticker = ${ticker} ORDER BY date`)) as SqlRows<never>);
  let rows = await readInterest();
  let vol = await readVolume();
  const newest = rows.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), "");
  const stale = !newest || Date.now() - new Date(newest).getTime() > STALE_DAYS * 86_400_000 || vol.length === 0;
  let refreshing = false;
  if (stale) {
    if (rows.length === 0) {
      await refresh(ticker);
      rows = await readInterest();
      vol = await readVolume();
    } else {
      refreshing = true;
      void refresh(ticker);
    }
  }
  const cur = rowsOf<{ short_pct: number | null; free_float: number | null; as_of: string }>((await db.execute(sql`
    SELECT short_pct::float8 AS short_pct, free_float::float8 AS free_float, as_of::text FROM lseg_research.signals_daily
    WHERE ticker = ${ticker} ORDER BY as_of DESC LIMIT 1`)) as SqlRows<never>)[0];
  const volPts = vol
    .filter((r) => r.short_volume_ratio != null)
    .map((r) => ({
      date: r.date,
      shortVolumeRatio: Number(r.short_volume_ratio),
      shortVolume: Number(r.short_volume),
      totalVolume: Number(r.total_volume),
    }));
  const last20 = volPts.slice(-20);
  const shortVolumeAvg20 = last20.length
    ? last20.reduce((s, p) => s + p.shortVolumeRatio, 0) / last20.length
    : null;
  return {
    ticker,
    points: rows.filter((r) => r.source === "polygon").map((r) => ({
      date: r.settlement_date, sharesShort: Number(r.short_interest), daysToCover: r.days_to_cover,
      avgDailyVolume: r.avg_daily_volume == null ? null : Number(r.avg_daily_volume),
    })),
    shortVolume: volPts,
    shortVolumeAvg20,
    current: { shortPctFloat: cur?.short_pct ?? null, asOf: cur?.as_of ?? null, freeFloat: cur?.free_float ?? null },
    fetchedAt: newest || null,
    refreshing,
  };
}
