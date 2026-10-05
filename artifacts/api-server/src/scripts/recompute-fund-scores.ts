#!/usr/bin/env npx tsx
/**
 * Recompute all fundamental scores with the v2 engine.
 *   cd artifacts/api-server && npx tsx src/scripts/recompute-fund-scores.ts
 */
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { db, marketRegime } from "@workspace/db";
import { desc } from "drizzle-orm";

async function main() {
  const rows = await db.select({ regime: marketRegime.regime }).from(marketRegime).orderBy(desc(marketRegime.computedAt)).limit(1);
  const regime = rows[0]?.regime ?? null;
  console.log("regime=", regime);
  const results = await computeAndPersistFundamentalScores(regime);
  const ranked = results.filter((r) => r.ranked);
  const byStyle = new Map<string, number>();
  for (const r of results) {
    const s = r.styleBucket ?? "unknown";
    byStyle.set(s, (byStyle.get(s) ?? 0) + 1);
  }
  console.log(JSON.stringify({
    total: results.length,
    ranked: ranked.length,
    unranked: results.length - ranked.length,
    sectorLayerWeight: 0.1,
    byStyle: Object.fromEntries(byStyle),
    top20: ranked.slice(0, 20).map((r) => ({
      ticker: r.ticker,
      total: r.totalScore,
      company: r.companyScore,
      sector: r.sectorScore,
      style: r.styleBucket,
      conf: r.confidence,
      peers: r.peerGroupSize,
      group: r.peerGroupId,
    })),
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
