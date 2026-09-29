/**
 * Quarantine confirmed delisted / acquired tickers from the fundamentals universe.
 * Does NOT touch dotted Yahoo symbols (BRK.B / BF.B) — those need alias mapping later.
 *
 *   pnpm exec tsx src/scripts/quarantine-delisted.ts
 *   pnpm exec tsx src/scripts/quarantine-delisted.ts --dry-run
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/** Yahoo "may be delisted" / acquired names observed in tech backfill. */
const DELISTED = [
  "SKX", // Skechers — acquired
  "STOR", // STORE Capital — acquired
  "WTR", // Aqua America rename / dead symbol
  "X", // US Steel — acquired
  "ECOL", // acquired
  "PEAK", // Healthpeak rename leftover
  "PXD", // Pioneer — acquired by Exxon
  "HES", // Hess — acquired
  "DFS", // Discover — acquired by Capital One
  "RDFN", // thin / problematic
  "NOVA", // bankruptcy / delisted risk
  "IOND", // invalid / micro
  "SKHY", // insufficient history / invalid
] as const;

const dry = process.argv.includes("--dry-run");

async function main() {
  console.log(`[quarantine] candidates=${DELISTED.length} dryRun=${dry}`);
  if (dry) {
    const r = await db.execute(sql`
      SELECT ticker, fetch_fundamentals
      FROM ticker_registry
      WHERE ticker IN (${sql.join(
        DELISTED.map((t) => sql`${t}`),
        sql`, `,
      )})
      ORDER BY ticker
    `);
    console.log((r as any).rows ?? r);
    return;
  }

  const r = await db.execute(sql`
    UPDATE ticker_registry
    SET fetch_fundamentals = false, is_active = false
    WHERE ticker IN (${sql.join(
      DELISTED.map((t) => sql`${t}`),
      sql`, `,
    )})
      AND fetch_fundamentals = true
    RETURNING ticker
  `);
  const rows = (r as any).rows ?? r;
  console.log(`[quarantine] deactivated ${rows.length}: ${rows.map((x: { ticker: string }) => x.ticker).join(", ") || "(none)"}`);

  // Drop stale Needs Review / provenance for inactive universe members
  await db.execute(sql`
    DELETE FROM field_provenance fp
    USING ticker_registry r
    WHERE fp.ticker = r.ticker AND r.fetch_fundamentals = false
  `);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
