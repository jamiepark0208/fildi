/**
 * Backfill prices_historical (+ recompute ticker_technicals) for every active ticker (a bar in the last
 * ACTIVE_DAYS) missing the last completed session's bar. Sources: Schwab → Yahoo → LSEG (fetchAndStoreOHLCV).
 * Runs daily from scripts/maintain.mjs. Prints universe coverage; exits 2 when coverage < MIN_COVERAGE so the
 * maintain report flags it. (2026-10-09: the old 4-calendar-day rule skipped 1–3 day gaps → ~265 names stale.)
 *
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts --max=60 --new-max=60   # new-max: never-priced universe adds per run
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts --tickers=AMD,JPM,SPY
 */
import { pool } from "@workspace/db";
import { fetchAndStoreOHLCV } from "../lib/indicators.js";
import { refreshTechnicals } from "../lib/technicals-db.js";
import { lastCompletedSessionYmd } from "../lib/market-hours.js";
import { priceCoverage, MIN_PRICE_COVERAGE as MIN_COVERAGE } from "../lib/price-coverage.js";

const ACTIVE_DAYS = 30;
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const tickersArg = process.argv.find((a) => a.startsWith("--tickers="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : 1000;
const newMaxArg = process.argv.find((a) => a.startsWith("--new-max="));
const NEW_MAX = newMaxArg ? Number(newMaxArg.split("=")[1]) : 60;

async function main() {
  const expected = lastCompletedSessionYmd();
  let tickers: string[];
  if (tickersArg) {
    tickers = tickersArg
      .split("=")[1]!
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
  } else {
    const r = await pool.query<{ ticker: string; last_date: string }>(
      `SELECT UPPER(p.ticker) AS ticker, max(p.date)::text AS last_date
       FROM prices_historical p
       GROUP BY 1
       HAVING max(p.date) < $1::date AND max(p.date) >= $1::date - $2::int
       ORDER BY max(p.date) ASC, 1
       LIMIT $3`,
      [expected, ACTIVE_DAYS, Math.max(1, MAX)],
    );
    tickers = r.rows.map((row) => row.ticker);
    // 10-27: names just added to the universe have no bar at all → the query above never sees them. Onboard ≤ NEW_MAX a day
    // (full history + technicals below), so a 300-name universe add spreads over ~5 days instead of one Yahoo burst.
    const nr = await pool.query<{ ticker: string }>(
      `SELECT r.ticker FROM ticker_registry r
       WHERE r.is_active AND r.fetch_fundamentals
         AND NOT EXISTS (SELECT 1 FROM prices_historical p WHERE p.ticker = r.ticker)
       ORDER BY r.added_at, r.ticker LIMIT $1`,
      [NEW_MAX],
    );
    tickers.push(...nr.rows.map((row) => row.ticker));
  }

  if (tickers.length === 0) {
    const coverage = await priceCoverage(expected);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "none stale", coverage }));
    await pool.end();
    if (coverage.pct < MIN_COVERAGE) process.exitCode = 2;
    return;
  }

  console.error(`[backfill-stale-prices] ${tickers.length} tickers missing the ${expected} bar`);
  const ok: string[] = [];
  const failed: { ticker: string; err: string }[] = [];

  for (const t of tickers) {
    try {
      const rows = await fetchAndStoreOHLCV(t);
      ok.push(t);
      console.error(`  ${t}: ${rows.length} bars`);
    } catch (err) {
      failed.push({ ticker: t, err: err instanceof Error ? err.message : String(err) });
      console.error(`  ${t}: FAIL ${failed[failed.length - 1]!.err.slice(0, 120)}`);
    }
  }

  if (ok.length) {
    console.error(`[backfill-stale-prices] recomputing technicals for ${ok.length}…`);
    await refreshTechnicals(ok);
  }

  const check = await pool.query<{ ticker: string; last_date: string }>(
    `SELECT UPPER(ticker) AS ticker, max(date)::text AS last_date
     FROM prices_historical
     WHERE UPPER(ticker) = ANY($1::text[])
     GROUP BY 1
     ORDER BY 1`,
    [ok],
  );

  const coverage = await priceCoverage(expected);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0 && coverage.pct >= MIN_COVERAGE,
        expected,
        coverage,
        refreshed: ok.length,
        failed,
        latest: Object.fromEntries(check.rows.map((r) => [r.ticker, r.last_date])),
      },
      null,
      2,
    ),
  );
  await pool.end();
  if (coverage.pct < MIN_COVERAGE) process.exitCode = 2;
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
