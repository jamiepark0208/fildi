/**
 * Backfill prices_historical (+ recompute ticker_technicals) for tickers whose
 * latest close is older than STALE_OHLCV_DAYS. Fixes A12: technicals refresh only
 * bootstrapped Yahoo when row-count < 200, so full-window names froze in July.
 *
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts --max=60
 *   pnpm exec tsx src/scripts/backfill-stale-prices.ts --tickers=AMD,JPM,SPY
 */
import { pool } from "@workspace/db";
import { fetchAndStoreOHLCV } from "../lib/indicators.js";
import { refreshTechnicals } from "../lib/technicals-db.js";

const STALE_DAYS = 4;
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const tickersArg = process.argv.find((a) => a.startsWith("--tickers="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : 200;

async function main() {
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
       HAVING max(p.date) < CURRENT_DATE - $1::int
       ORDER BY max(p.date) ASC, 1
       LIMIT $2`,
      [STALE_DAYS, Math.max(1, MAX)],
    );
    tickers = r.rows.map((row) => row.ticker);
  }

  if (tickers.length === 0) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "none stale" }));
    await pool.end();
    return;
  }

  console.error(`[backfill-stale-prices] ${tickers.length} tickers (stale>${STALE_DAYS}d)`);
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

  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        refreshed: ok.length,
        failed,
        latest: Object.fromEntries(check.rows.map((r) => [r.ticker, r.last_date])),
      },
      null,
      2,
    ),
  );
  await pool.end();
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
