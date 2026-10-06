/**
 * Ad-hoc: backfill ticker_technicals for flagged universe missing a row.
 *   pnpm exec tsx src/scripts/backfill-missing-technicals.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { refreshTechnicals } from "../lib/technicals-db.js";

async function main() {
  const r = await db.execute(sql`
    SELECT r.ticker FROM ticker_registry r
    LEFT JOIN ticker_technicals t ON t.ticker = r.ticker
    WHERE r.fetch_fundamentals AND t.ticker IS NULL
    ORDER BY r.ticker
  `);
  const rows = (r as unknown as { rows?: { ticker: string }[] })?.rows ?? (r as unknown as { ticker: string }[]);
  const tickers = rows.map((x) => x.ticker);
  console.log(`[tech] missing before: ${tickers.length}`);
  if (tickers.length === 0) return;
  await refreshTechnicals(tickers);
  const after = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM ticker_registry r
    LEFT JOIN ticker_technicals t ON t.ticker = r.ticker
    WHERE r.fetch_fundamentals AND t.ticker IS NULL
  `);
  const n = Number((after as any).rows?.[0]?.n ?? (after as any)[0]?.n ?? "?");
  console.log(`[tech] missing after: ${n}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
