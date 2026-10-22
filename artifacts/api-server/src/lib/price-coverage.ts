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
  /** A87 Maintain: active tickers with no bar in ≥5 calendar days (or never). */
  noBar5d: number;
  noBar5dSample: string[];
}

export async function priceCoverage(expected: string = lastCompletedSessionYmd()): Promise<PriceCoverage> {
  const { rows } = await pool.query<{ ticker: string; last: string | null }>(
    `SELECT r.ticker, max(p.date)::text AS last
     FROM ticker_registry r
     LEFT JOIN prices_historical p
       ON p.ticker = r.ticker AND p.date >= $1::date - 30
     WHERE COALESCE(r.is_active, true)
       AND COALESCE(r.fetch_fundamentals, true)  -- 10-22: reference-only rows (peers, funds, foreign) are never priced
     GROUP BY r.ticker`,
    [expected],
  );
  const stale = rows
    .filter((r) => r.last == null || r.last < expected)
    .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
  const cutoff5 = (() => {
    const d = new Date(`${expected}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 5);
    return d.toISOString().slice(0, 10);
  })();
  const no5 = rows
    .filter((r) => r.last == null || r.last < cutoff5)
    .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
  const active = rows.length;
  const fresh = active - stale.length;
  return {
    expected,
    fresh,
    active,
    pct: active ? fresh / active : 0,
    staleSample: stale.slice(0, 10).map((r) => (r.last == null ? `${r.ticker}(none)` : r.ticker)),
    noBar5d: no5.length,
    noBar5dSample: no5.slice(0, 10).map((r) => (r.last == null ? `${r.ticker}(none)` : `${r.ticker}@${r.last}`)),
  };
}
