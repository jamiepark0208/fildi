/**
 * Daily-bar coverage: share of *active registry* tickers whose latest prices_historical bar
 * is on/after the last completed session. Zero-bar actives count as stale (A87).
 * Used by backfill-stale-prices + scheduled-tasks "prices-coverage" alert.
 */
import { pool } from "@workspace/db";
import { lastCompletedSessionYmd } from "./market-hours.js";

export const MIN_PRICE_COVERAGE = 0.95;
/** A universe add (research/lseg/universe_review.py) prices ≤ 60 new names a day (backfill-stale-prices) — not a coverage failure. */
export const ONBOARDING_DAYS = 21;

export interface PriceCoverage {
  expected: string;
  /** 10-27: active names added < ONBOARDING_DAYS ago with no bar yet — being onboarded, not stale (kept out of pct). */
  onboarding: number;
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
  const { rows: all } = await pool.query<{ ticker: string; last: string | null; fresh_add: boolean }>(
    `SELECT r.ticker, max(p.date)::text AS last, bool_or(r.added_at >= now() - make_interval(days => $2::int)) AS fresh_add
     FROM ticker_registry r
     LEFT JOIN prices_historical p
       ON p.ticker = r.ticker AND p.date >= $1::date - 30
     WHERE COALESCE(r.is_active, true)
       AND COALESCE(r.fetch_fundamentals, true)  -- 10-22: reference-only rows (peers, funds, foreign) are never priced
     GROUP BY r.ticker`,
    [expected, ONBOARDING_DAYS],
  );
  // Zero-bar actives still count as stale (A87) unless they were just added to the universe.
  const rows = all.filter((r) => !(r.last == null && r.fresh_add));
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
    onboarding: all.length - rows.length,
    fresh,
    active,
    pct: active ? fresh / active : 0,
    staleSample: stale.slice(0, 10).map((r) => (r.last == null ? `${r.ticker}(none)` : r.ticker)),
    noBar5d: no5.length,
    noBar5dSample: no5.slice(0, 10).map((r) => (r.last == null ? `${r.ticker}(none)` : `${r.ticker}@${r.last}`)),
  };
}
