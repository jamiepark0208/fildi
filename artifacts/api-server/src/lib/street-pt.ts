/**
 * A86 Phase 1 — street consensus price-target series (from analyst_events).
 * Display / disagreement lab only — not a score input.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

let ensured = false;

async function ensure(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS street_pt_daily (
      ticker text NOT NULL,
      as_of date NOT NULL,
      median_pt double precision NOT NULL,
      n integer NOT NULL,
      source text NOT NULL DEFAULT 'analyst_events',
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, as_of)
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS street_pt_daily_asof_idx ON street_pt_daily (as_of)`);
  ensured = true;
}

/** Rebuild daily median PT from analyst_events (one row per ticker × event day). */
export async function backfillStreetPtFromEvents(): Promise<number> {
  await ensure();
  const res = await db.execute(sql`
    INSERT INTO street_pt_daily (ticker, as_of, median_pt, n, source)
    SELECT UPPER(ticker), event_date::date AS as_of,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY price_target::float8) AS median_pt,
           count(*)::int AS n,
           'analyst_events'
    FROM analyst_events
    WHERE price_target IS NOT NULL AND event_date IS NOT NULL
    GROUP BY 1, 2
    ON CONFLICT (ticker, as_of) DO UPDATE SET
      median_pt = excluded.median_pt,
      n = excluded.n,
      fetched_at = now()`);
  const n = typeof (res as { rowCount?: number }).rowCount === "number"
    ? (res as { rowCount: number }).rowCount
    : 0;
  logger.info({ rows: n }, "street-pt: backfill from analyst_events");
  return n;
}

/** Largest |Fildi FV − street PT| / street among latest snapshots (review queue, not alert). */
export async function listLargestStreetGaps(limit = 40): Promise<Array<{
  ticker: string;
  asOf: string;
  fairValue: number;
  streetPt: number;
  gapPct: number;
  price: number | null;
}>> {
  await ensure();
  return rowsOf<{
    ticker: string; as_of: string; fair_value: number; street_pt: number; gap_pct: number; price: number | null;
  }>((await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ticker) ticker, as_of, fair_value::float8 AS fair_value, price::float8 AS price
      FROM fair_value_snapshots
      WHERE fair_value IS NOT NULL
      ORDER BY ticker, as_of DESC
    ),
    gaps AS (
      SELECT l.ticker, l.as_of::text AS as_of, l.fair_value, l.price,
        (SELECT s.median_pt FROM street_pt_daily s
         WHERE s.ticker = l.ticker AND s.as_of <= l.as_of
         ORDER BY s.as_of DESC LIMIT 1) AS street_pt
      FROM latest l
    )
    SELECT ticker, as_of, fair_value, street_pt, price,
           ((fair_value - street_pt) / street_pt * 100) AS gap_pct
    FROM gaps
    WHERE street_pt IS NOT NULL AND street_pt > 0
    ORDER BY abs((fair_value - street_pt) / street_pt) DESC
    LIMIT ${limit}`)) as SqlRows<never>)
    .map((r) => ({
      ticker: r.ticker,
      asOf: r.as_of,
      fairValue: Number(r.fair_value),
      streetPt: Number(r.street_pt),
      gapPct: Number(r.gap_pct),
      price: r.price != null ? Number(r.price) : null,
    }));
}

export async function getStreetPtSeries(
  ticker: string,
  days = 400,
): Promise<Array<{ date: string; medianPt: number; n: number }>> {
  await ensure();
  const key = ticker.toUpperCase();
  return rowsOf<{ date: string; median_pt: number; n: number }>((await db.execute(sql`
    SELECT as_of::text AS date, median_pt, n
    FROM street_pt_daily
    WHERE ticker = ${key} AND as_of >= (CURRENT_DATE - ${days}::int)
    ORDER BY as_of`)) as SqlRows<never>)
    .map((r) => ({ date: r.date, medianPt: Number(r.median_pt), n: Number(r.n) }));
}

/** Forward-filled street PT aligned to fair_value_snapshots dates for a ticker. */
export async function getFvVsStreet(
  ticker: string,
  days = 400,
): Promise<Array<{
  date: string;
  price: number | null;
  fairValue: number | null;
  streetPt: number | null;
  gapPct: number | null;
}>> {
  await ensure();
  const key = ticker.toUpperCase();
  return rowsOf<{
    date: string; price: number | null; fair_value: number | null; street_pt: number | null;
  }>((await db.execute(sql`
    WITH fv AS (
      SELECT as_of::text AS date, price::float8 AS price, fair_value::float8 AS fair_value
      FROM fair_value_snapshots
      WHERE ticker = ${key} AND as_of >= (CURRENT_DATE - ${days}::int)
    ),
    street AS (
      SELECT as_of, median_pt FROM street_pt_daily WHERE ticker = ${key}
    )
    SELECT f.date, f.price, f.fair_value,
      (SELECT s.median_pt FROM street s WHERE s.as_of <= f.date::date ORDER BY s.as_of DESC LIMIT 1) AS street_pt
    FROM fv f
    ORDER BY f.date`)) as SqlRows<never>)
    .map((r) => {
      const fv = r.fair_value != null ? Number(r.fair_value) : null;
      const st = r.street_pt != null ? Number(r.street_pt) : null;
      const gapPct = fv != null && st != null && st > 0 ? ((fv - st) / st) * 100 : null;
      return {
        date: r.date,
        price: r.price != null ? Number(r.price) : null,
        fairValue: fv,
        streetPt: st,
        gapPct,
      };
    });
}
