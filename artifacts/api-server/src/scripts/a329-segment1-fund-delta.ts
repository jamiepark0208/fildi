/**
 * A329 segment 1 — fund score before/after negative-equity leverage fix (dry run, no persist).
 */
import { sql, eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, tickerFundamentals, tickerRegistry } from "@workspace/db";
import { scoreUniverse, withRanks } from "../lib/fund-score-engine.js";
import { rowToFundInput, enrichMarketCap } from "../lib/fund-score-inputs.js";
import { hasNegativeEquity } from "../lib/negative-equity-policy.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../out/audit");

async function main() {
  const rows = await db
    .select({ tf: tickerFundamentals })
    .from(tickerFundamentals)
    .innerJoin(tickerRegistry, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
    .where(sql`${tickerRegistry.fetchFundamentals} = true AND ${tickerRegistry.isActive} = true`);
  const tfRows = rows.map((r) => r.tf);
  const negTickers = tfRows
    .filter((r) => hasNegativeEquity(r.totalStockholdersEquity != null ? Number(r.totalStockholdersEquity) : null))
    .map((r) => r.ticker);
  const inputs = tfRows.map((row) =>
    enrichMarketCap(rowToFundInput(row, null, row.styleBucket ?? null), row, null),
  );
  const before = withRanks(scoreUniverse(inputs, {}, {}, {}, { negativeEquityLeverage: "legacy" }));
  const after = withRanks(scoreUniverse(inputs, {}, {}, {}, { negativeEquityLeverage: "sanitized" }));
  const beforeBy = new Map(before.map((r) => [r.ticker, r]));
  const afterBy = new Map(after.map((r) => [r.ticker, r]));
  const universe = before.filter((r) => r.ranked && r.totalScore != null).length;
  const moved: { ticker: string; beforeRank: number; afterRank: number; deltaPctPts: number }[] = [];
  for (const t of negTickers) {
    const b = beforeBy.get(t);
    const a = afterBy.get(t);
    if (!b?.rank || !a?.rank || universe <= 0) continue;
    const bPct = ((universe - b.rank + 1) / universe) * 100;
    const aPct = ((universe - a.rank + 1) / universe) * 100;
    const delta = aPct - bPct;
    if (Math.abs(delta) >= 10) {
      moved.push({ ticker: t, beforeRank: b.rank, afterRank: a.rank, deltaPctPts: delta });
    }
  }
  mkdirSync(OUT, { recursive: true });
  const payload = {
    negativeEquityTickers: negTickers.length,
    universeRanked: universe,
    rankMoved10PctPts: moved.sort((x, y) => Math.abs(y.deltaPctPts) - Math.abs(x.deltaPctPts)),
  };
  writeFileSync(join(OUT, "a329-segment1-fund-delta.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
