import { and, eq, sql } from "drizzle-orm";
import { db, fieldProvenance, sourceFundamentals, tickerFundamentals } from "@workspace/db";
import { computeCanonicalPeg, runMergeTrusted } from "./merge-trusted.js";

async function main() {
  console.log("canonical AFRM example", computeCanonicalPeg(42.17, 1.0967));
  await runMergeTrusted();

  const t = "AFRM";
  const gold = await db
    .select({
      peg: tickerFundamentals.pegRatio,
      pe: tickerFundamentals.peRatio,
      g: tickerFundamentals.epsGrowth,
    })
    .from(tickerFundamentals)
    .where(eq(tickerFundamentals.ticker, t));
  const prov = await db
    .select()
    .from(fieldProvenance)
    .where(and(eq(fieldProvenance.ticker, t), eq(fieldProvenance.field, "pegRatio")));
  const vendors = await db
    .select()
    .from(sourceFundamentals)
    .where(and(eq(sourceFundamentals.ticker, t), eq(sourceFundamentals.field, "pegRatio")));

  console.log("AFRM gold", gold[0]);
  console.log("AFRM peg provenance", prov[0]);
  console.log(
    "AFRM vendor pegs (display only)",
    vendors.map((v) => `${v.source}=${v.value}`),
  );

  const pegDiv = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM field_provenance WHERE field='pegRatio' AND divergent`,
  );
  const allDiv = await db.execute(sql`SELECT COUNT(*)::int AS n FROM field_provenance WHERE divergent`);
  console.log("peg_divergent", (pegDiv as any).rows?.[0] ?? pegDiv);
  console.log("total_divergent", (allDiv as any).rows?.[0] ?? allDiv);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
