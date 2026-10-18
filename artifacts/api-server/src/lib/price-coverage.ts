/**
 * Daily-bar coverage: share of *active registry* tickers whose latest prices_historical bar
 * is on/after the last completed session. Zero-bar actives count as stale (A87).
 * Used by backfill-stale-prices + scheduled-tasks "prices-coverage" alert.
 */
import { pool } from "@workspace/db";
import { lastCompletedSessionYmd } from "./market-hours.js";

export const MIN_PRICE_COVERAGE = 0.95;

export interface PriceCoverage {
  expected: string;
  fresh: number;
  active: number;
  pct: number;
  /** Up to 10 stale / never-barred tickers, oldest bar first (null last = never) */
  staleSample: string[];
}

export async function priceCoverage(expected: string = lastCompletedSessionYmd()): Promise<PriceCoverage> {
  const { rows } = await pool.query<{ ticker: string; last: string | null }>(
    `SELECT r.ticker, max(p.date)::text AS last
     FROM ticker_registry r
     LEFT JOIN prices_historical p
       ON p.ticker = r.ticker AND p.date >= $1::date - 30
     WHERE COALESCE(r.is_active, true)
     GROUP BY r.ticker`,
    [expected],
  );
  const stale = rows
    .filter((r) => r.last == null || r.last < expected)
    .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
  const active = rows.length;
  const fresh = active - stale.length;
  return {
    expected,
    fresh,
    active,
    pct: active ? fresh / active : 0,
    staleSample: stale.slice(0, 10).map((r) => (r.last == null ? `${r.ticker}(none)` : r.ticker)),
  };
}
