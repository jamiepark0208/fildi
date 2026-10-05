/**
 * Free-enrich active tickers that still have null fund_total_score.
 * Skips ETFs + fetch_fundamentals=false (dead/acquired). Wired into Maintain
 * so coverage/safety gaps shrink without burning FactSet.
 *
 *   pnpm exec tsx src/scripts/enrich-unscored-fundamentals.ts
 *   pnpm exec tsx src/scripts/enrich-unscored-fundamentals.ts --max=20
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, tickerRegistry, tickerFundamentals } from "@workspace/db";
import { isExcludedEtf } from "../lib/etf-exclusions.js";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : 20;

async function main() {
  const rows = await db
    .select({ ticker: tickerFundamentals.ticker })
    .from(tickerFundamentals)
    .innerJoin(tickerRegistry, eq(tickerRegistry.ticker, tickerFundamentals.ticker))
    .where(
      and(
        eq(tickerRegistry.fetchFundamentals, true),
        isNull(tickerFundamentals.fundTotalScore),
      ),
    )
    .orderBy(sql`${tickerFundamentals.ticker}`)
    .limit(Math.max(1, MAX));

  const tickers = rows.map((r) => r.ticker).filter((t) => !isExcludedEtf(t));
  if (tickers.length === 0) {
    console.log(JSON.stringify({ ok: true, tickers: [], skipped: true, reason: "none unscored active" }));
    process.exit(0);
  }

  console.error(`[enrich-unscored] enriching ${tickers.length}: ${tickers.join(",")}`);
  const result = await enrichAndMergeTickers(tickers, { respectMutex: true });
  console.log(JSON.stringify({ ...result, requested: tickers }, null, 2));
  process.exit(result.ok || result.skipped ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
