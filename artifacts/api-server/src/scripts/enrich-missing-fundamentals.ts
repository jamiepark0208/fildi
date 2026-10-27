/**
 * Enrich tickers that are flagged fetch_fundamentals but have no gold row / never fetched.
 * Intended for daily maintain — covers newly watchlisted names without waiting for the
 * 4-day full nightly catch-up.
 *
 *   pnpm exec tsx src/scripts/enrich-missing-fundamentals.ts
 *   pnpm exec tsx src/scripts/enrich-missing-fundamentals.ts --max=30
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, tickerRegistry, tickerFundamentals } from "@workspace/db";
import { isExcludedEtf } from "../lib/etf-exclusions.js";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : 30;

async function main() {
  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .leftJoin(tickerFundamentals, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
    .where(
      and(
        eq(tickerRegistry.fetchFundamentals, true),
        or(
          isNull(tickerFundamentals.ticker),
          isNull(tickerFundamentals.fundamentalsLastFetched),
          // 10-27: a gold row with no core field is "fetched" in name only (see merge-trusted empty-row guard)
          and(isNull(tickerFundamentals.totalRevenue), isNull(tickerFundamentals.peRatio), isNull(tickerFundamentals.sharesOutstanding)),
        ),
      ),
    )
    .orderBy(sql`${tickerRegistry.addedAt} desc nulls last`)
    .limit(Math.max(1, MAX));

  const tickers = rows.map((r) => r.ticker).filter((t) => !isExcludedEtf(t));
  if (tickers.length === 0) {
    console.log(JSON.stringify({ ok: true, tickers: [], skipped: true, reason: "none missing" }));
    process.exit(0);
  }

  console.error(`[enrich-missing] enriching ${tickers.length}: ${tickers.join(",")}`);
  const result = await enrichAndMergeTickers(tickers, { respectMutex: true });
  console.log(JSON.stringify({ ...result, requested: tickers }, null, 2));
  process.exit(result.ok || result.skipped ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
