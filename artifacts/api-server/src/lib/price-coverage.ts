/**
 * Daily-bar coverage: share of active tickers (a bar in the last 30 days) whose latest prices_historical bar
 * is on/after the last completed session. Used by backfill-stale-prices (exit code) and the scheduled-tasks
 * "prices-coverage" alert, so a silent refresh gap can't recur (2026-10-06..09: ~265 of 569 names stale).
 */
import { pool } from "@workspace/db";
import { lastCompletedSessionYmd } from "./market-hours.js";

export const MIN_PRICE_COVERAGE = 0.95;

export interface PriceCoverage {
  expected: string;
  fresh: number;
  active: number;
  pct: number;
  /** Up to 10 stale tickers, oldest bar first */
  staleSample: string[];
}

export async function priceCoverage(expected: string = lastCompletedSessionYmd()): Promise<PriceCoverage> {
  const { rows } = await pool.query<{ ticker: string; last: string }>(
    `SELECT ticker, max(date)::text AS last FROM prices_historical
     WHERE date >= $1::date - 30 GROUP BY 1`,
    [expected],
  );
  const stale = rows.filter((r) => r.last < expected).sort((a, b) => a.last.localeCompare(b.last));
  const active = rows.length;
  const fresh = active - stale.length;
  return { expected, fresh, active, pct: active ? fresh / active : 0, staleSample: stale.slice(0, 10).map((r) => r.ticker) };
}
