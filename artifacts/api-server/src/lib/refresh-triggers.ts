/**
 * Event-driven refresh triggers — advance specific tickers in the enrichment
 * queue without forcing full-universe daily pulls.
 *
 * v1: earnings calendar window (±1 / +2 days). More triggers later:
 * see .cursor/plans/event-driven-refresh.md
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/** Days before report date to start prioritizing refresh. */
export const EARNINGS_TRIGGER_DAYS_BEFORE = 1;
/** Days after report date to keep prioritizing (numbers still settling). */
export const EARNINGS_TRIGGER_DAYS_AFTER = 2;
/**
 * Inside the earnings window, treat bronze staging as stale after this many days
 * (vs global STALE_DAYS=7) so we re-pull post-print numbers once.
 */
export const EARNINGS_STALE_DAYS = 1;

export interface EarningsTriggerHit {
  ticker: string;
  reportDate: string;
}

/**
 * Tickers with an earnings_calendar report_date in [today − before, today + after].
 * Prefer confirmed rows; include estimate-only upcoming as well.
 */
export async function getEarningsWindowTickers(
  before = EARNINGS_TRIGGER_DAYS_BEFORE,
  after = EARNINGS_TRIGGER_DAYS_AFTER,
): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker
    FROM earnings_calendar
    WHERE report_date BETWEEN
      (CURRENT_DATE - ${before}::int)
      AND (CURRENT_DATE + ${after}::int)
  `);
  const set = new Set<string>();
  for (const r of (rows as { rows?: { ticker: string }[] }).rows ?? []) {
    if (r.ticker) set.add(String(r.ticker).toUpperCase());
  }
  return set;
}

/** For logging / audits — include report dates. */
export async function listEarningsWindowHits(
  before = EARNINGS_TRIGGER_DAYS_BEFORE,
  after = EARNINGS_TRIGGER_DAYS_AFTER,
): Promise<EarningsTriggerHit[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (UPPER(ticker))
      UPPER(ticker) AS ticker,
      report_date::text AS report_date
    FROM earnings_calendar
    WHERE report_date BETWEEN
      (CURRENT_DATE - ${before}::int)
      AND (CURRENT_DATE + ${after}::int)
    ORDER BY UPPER(ticker), report_date DESC
  `);
  return ((rows as { rows?: EarningsTriggerHit[] }).rows ?? []).map((r) => ({
    ticker: String(r.ticker).toUpperCase(),
    reportDate: String(r.report_date ?? r.reportDate ?? ""),
  }));
}
