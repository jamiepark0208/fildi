/**
 * Ad-hoc Needs Review drain: FactSet referee on worst divergent tickers + re-merge.
 * Does NOT wait for nightly schedule.
 *
 *   pnpm exec tsx src/scripts/drain-needs-review.ts
 *   pnpm exec tsx src/scripts/drain-needs-review.ts --max=40
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { runFactsetReferee } from "../lib/factset-referee.js";
import { runMergeTrusted } from "./merge-trusted.js";

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const maxTickers = maxArg ? Number(maxArg.split("=")[1]) : 40;

async function nrCount(): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM field_provenance WHERE divergent`);
  return Number((r as any).rows?.[0]?.n ?? (r as any)[0]?.n ?? 0);
}

async function topDivergentTickers(limit: number): Promise<string[]> {
  // Prefer active-universe tickers that still lack any FactSet silver rows —
  // re-fetching already-refereed names burns budget with near-zero NR delta.
  const r = await db.execute(sql`
    SELECT fp.ticker, COUNT(*)::int AS n,
      CASE WHEN EXISTS (
        SELECT 1 FROM source_fundamentals sf
        WHERE sf.ticker = fp.ticker AND sf.source = 'factset'
      ) THEN 1 ELSE 0 END AS has_factset
    FROM field_provenance fp
    JOIN ticker_registry r ON r.ticker = fp.ticker AND r.fetch_fundamentals = true
    WHERE fp.divergent = true
    GROUP BY fp.ticker
    ORDER BY has_factset ASC, n DESC, fp.ticker
    LIMIT ${limit}
  `);
  const rows = (r as any).rows ?? r;
  return rows.map((row: { ticker: string }) => row.ticker);
}

async function main() {
  const before = await nrCount();
  const tickers = await topDivergentTickers(maxTickers);
  console.log(`[drain] Needs Review before: ${before}`);
  console.log(`[drain] FactSet referee on ${tickers.length} tickers: ${tickers.slice(0, 15).join(",")}…`);

  const ref = await runFactsetReferee({ tickers, maxTickers: tickers.length });
  console.log("[drain] referee result", ref);

  console.log("[drain] merge-trusted…");
  await runMergeTrusted();

  const after = await nrCount();
  console.log(`[drain] Needs Review after: ${after}  (Δ ${after - before})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
