/**
 * Daily maintain: refresh fundamentals for tickers in the earnings window
 * (±1 day before / +2 after report_date) without waiting for the 4-day full run.
 *
 * Only touches fetch_fundamentals names whose gold row is missing or older than
 * EARNINGS_STALE_DAYS (1). Free sources only via enrichAndMergeTickers.
 *
 *   pnpm exec tsx src/scripts/enrich-earnings-window.ts
 *   pnpm exec tsx src/scripts/enrich-earnings-window.ts --max=40
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, tickerRegistry, tickerFundamentals } from "@workspace/db";
import {
  EARNINGS_STALE_DAYS,
  getEarningsWindowTickers,
  listEarningsWindowHits,
} from "../lib/refresh-triggers.js";
import { isExcludedEtf } from "../lib/etf-exclusions.js";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : 40;

async function main() {
  const windowSet = await getEarningsWindowTickers();
  if (windowSet.size === 0) {
    console.log(JSON.stringify({ ok: true, tickers: [], skipped: true, reason: "empty earnings window" }));
    process.exit(0);
  }

  const candidates = [...windowSet].filter((t) => !isExcludedEtf(t));
  if (candidates.length === 0) {
    console.log(JSON.stringify({ ok: true, tickers: [], skipped: true, reason: "window is all ETFs" }));
    process.exit(0);
  }

  const staleCutoff = new Date(Date.now() - EARNINGS_STALE_DAYS * 86400_000);

  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .leftJoin(tickerFundamentals, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
    .where(
      and(
        eq(tickerRegistry.fetchFundamentals, true),
        inArray(tickerRegistry.ticker, candidates),
        or(
          isNull(tickerFundamentals.ticker),
          isNull(tickerFundamentals.fundamentalsLastFetched),
          lt(tickerFundamentals.fundamentalsLastFetched, staleCutoff),
        ),
      ),
    )
    .orderBy(sql`${tickerFundamentals.fundamentalsLastFetched} asc nulls first`)
    .limit(Math.max(1, MAX));

  const tickers = rows.map((r) => r.ticker);
  if (tickers.length === 0) {
    const hits = await listEarningsWindowHits();
    console.log(
      JSON.stringify({
        ok: true,
        tickers: [],
        skipped: true,
        reason: "window tickers already fresh",
        windowSize: windowSet.size,
        sampleHits: hits.slice(0, 8),
      }),
    );
    process.exit(0);
  }

  console.error(
    `[enrich-earnings] window=${windowSet.size} refreshing ${tickers.length}: ${tickers.join(",")}`,
  );
  const result = await enrichAndMergeTickers(tickers, { respectMutex: true });
  console.log(JSON.stringify({ ...result, requested: tickers, windowSize: windowSet.size }, null, 2));
  process.exit(result.ok || result.skipped ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
