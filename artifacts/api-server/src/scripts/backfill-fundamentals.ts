/**
 * DEPRECATED — do not write gold from this script.
 *
 * Legacy FMP/Polygon/AV waterfall that called writeFundamentalsRow() bypassed
 * FIELD_DEFS / merge-trusted. Use the canonical path instead:
 *
 *   npx tsx src/scripts/nightly-enrichment.ts
 *   // or on-demand: enrichAndMergeTickers() in lib/enrich-and-merge.ts
 *
 * This CLI now redirects to enrichAndMergeTickers for the stale/null work queue.
 */
import { eq, inArray } from "drizzle-orm";
import { db, tickerRegistry, peerGroupMembers, tickerFundamentals } from "@workspace/db";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";
import { STALE_DAYS, CALLS_PER_TICKER } from "../lib/data-ops-config.js";
import { checkFMPBudget } from "../lib/fundamentals-db.js";

const CRITICAL = [
  "grossMargin", "netMargin", "operatingMargin", "totalRevenue",
  "netIncome", "freeCashFlow", "ebitda", "ebit", "totalDebt",
  "cashAndEquivalents", "returnOnEquity", "revenueGrowthYoY",
] as const;

function isFresh(fetched: Date | null): boolean {
  if (!fetched) return false;
  return Date.now() - new Date(fetched).getTime() < STALE_DAYS * 86_400_000;
}

async function main(): Promise<void> {
  console.log("[deprecated] backfill-fundamentals → enrichAndMergeTickers (FIELD_DEFS path)");

  const reg = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true));
  const peers = await db.select({ ticker: peerGroupMembers.ticker }).from(peerGroupMembers);
  const universe = [...new Set([...reg, ...peers].map((r) => r.ticker.toUpperCase()))];

  const rows = await db
    .select()
    .from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, universe));
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));

  const needsWork = universe.filter((t) => {
    const row = byTicker.get(t);
    if (!row) return true;
    if (!isFresh(row.fundamentalsLastFetched)) return true;
    const rec = row as Record<string, unknown>;
    return CRITICAL.some((c) => rec[c] == null);
  });

  // Cap by remaining FMP budget (~9 calls/ticker) so we don't blow the free plan
  const budget = await checkFMPBudget(0);
  const maxByBudget = Math.max(1, Math.floor(budget.remaining / (CALLS_PER_TICKER.fmp || 9)));
  const batch = needsWork.slice(0, Math.min(40, maxByBudget));

  console.log(
    `universe=${universe.length} needsWork=${needsWork.length} batch=${batch.length} fmpRemaining=${budget.remaining}`,
  );
  if (batch.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const result = await enrichAndMergeTickers(batch);
  console.log(`done ok=${result.ok} fetched=${result.fetched} failed=${result.failed} reason=${result.reason ?? "—"}`);
  if (!result.ok) process.exit(1);
}

const isMain = process.argv[1]?.includes("backfill-fundamentals");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
