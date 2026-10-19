/**
 * A96 — seed / catch up market_breadth_daily (Polygon A/D + registry MA%).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/backfill-market-breadth.ts [--days=5|500]
 * Maintain uses --days=5 (recent holes). Full 2y ≈ --days=500 (~100 min @ 5/min).
 */
import { backfillMarketBreadth } from "../lib/market-breadth.js";
import { logger } from "../lib/logger.js";

function argDays(): number {
  const raw = process.argv.find((a) => a.startsWith("--days="))?.slice("--days=".length)
    ?? process.argv[2];
  const n = Number(raw ?? 5);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid days: ${raw}`);
  return Math.min(Math.floor(n), 600);
}

async function main(): Promise<void> {
  const days = argDays();
  const r = await backfillMarketBreadth(days);
  logger.info(r, `backfill-market-breadth: days=${days}`);
  console.log(JSON.stringify({ days, ...r }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
