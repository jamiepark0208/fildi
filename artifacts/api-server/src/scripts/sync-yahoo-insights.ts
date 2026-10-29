/**
 * Daily Trading Central / Argus / Morningstar-text pull (lib/yahoo-insights.ts). Universe = names LSEG covered in the last
 * 10 days (the active book: watchlist + engine + Model List) unless tickers are passed.
 * Usage: npx tsx src/scripts/sync-yahoo-insights.ts [TICKER ...]
 */
import { pool } from "@workspace/db";
import { syncYahooInsights } from "../lib/yahoo-insights.js";

const args = process.argv.slice(2).map((a) => a.toUpperCase());
const tickers = args.length
  ? args
  : (await pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM lseg_research.signals_daily WHERE as_of >= CURRENT_DATE - 10 ORDER BY ticker`,
    )).rows.map((r) => r.ticker);
const t0 = Date.now();
const r = await syncYahooInsights(tickers);
console.log(`yahoo-insights: ${r.ok} ok, ${r.failed} failed of ${tickers.length} in ${Math.round((Date.now() - t0) / 1000)} s`);
await pool.end();
process.exit(r.ok === 0 && tickers.length > 0 ? 1 : 0);
