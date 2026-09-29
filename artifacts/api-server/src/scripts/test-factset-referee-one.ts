/**
 * One-ticker FactSet referee smoke + discrepancy explain.
 * Usage: pnpm exec tsx src/scripts/test-factset-referee-one.ts AFRM
 */
import { and, eq } from "drizzle-orm";
import { db, fieldProvenance, sourceFundamentals } from "@workspace/db";
import { fetchFactSetFundamentals, deriveFactSetValuations } from "../lib/factset-client.js";
import { runFactsetReferee } from "../lib/factset-referee.js";
import { runMergeTrusted } from "./merge-trusted.js";
import { pricesHistorical } from "@workspace/db";
import { desc } from "drizzle-orm";

const T = (process.argv[2] ?? "AFRM").toUpperCase();

const EXPLAIN_FIELDS = [
  "peRatio", "forwardPe", "pegRatio", "priceToBook",
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity",
  "currentRatio", "netIncome", "earningsPerShare", "totalStockholdersEquity",
];

async function dump(label: string) {
  const divergent = await db
    .select()
    .from(fieldProvenance)
    .where(and(eq(fieldProvenance.ticker, T), eq(fieldProvenance.divergent, true)));
  const all = await db.select().from(fieldProvenance).where(eq(fieldProvenance.ticker, T));
  const fs = await db
    .select()
    .from(sourceFundamentals)
    .where(and(eq(sourceFundamentals.ticker, T), eq(sourceFundamentals.source, "factset")));
  console.log(`\n=== ${label} ===`);
  console.log(`divergent_count=${divergent.length}  fields=[${divergent.map((r) => r.field).join(",")}]`);
  console.log(`factset_sf_rows=${fs.length}`);
}

async function explainDiscrepancies() {
  const sf = await db.select().from(sourceFundamentals).where(eq(sourceFundamentals.ticker, T));
  const prov = await db.select().from(fieldProvenance).where(eq(fieldProvenance.ticker, T));
  const byField = new Map<string, Map<string, number>>();
  for (const r of sf) {
    const n = Number(r.value);
    if (!isFinite(n)) continue;
    if (!byField.has(r.field)) byField.set(r.field, new Map());
    byField.get(r.field)!.set(r.source, n);
  }
  const provBy = new Map(prov.map((p) => [p.field, p]));

  console.log("\n=== DISCREPANCY EXPLAIN (free sources vs FactSet referee) ===");
  console.log("Rule: if free sources disagree, pick free source within 20% of FactSet;");
  console.log("      else gold = FactSet derived/reported value (winning_source=factset).");
  console.log("");

  for (const field of EXPLAIN_FIELDS) {
    const sources = byField.get(field);
    const p = provBy.get(field);
    if (!sources && !p) continue;
    const free = [...(sources?.entries() ?? [])].filter(([s]) => s !== "factset");
    const fsVal = sources?.get("factset");
    const parts = free.map(([s, v]) => `${s}=${fmt(v)}`).join("  ");
    const dist =
      fsVal != null
        ? free
            .map(([s, v]) => {
              const d = Math.abs(v - fsVal) / Math.max(Math.abs(fsVal), 1e-9);
              return `${s}:${(d * 100).toFixed(0)}%`;
            })
            .join(" ")
        : "—";
    console.log(
      `${field.padEnd(24)} free:[${parts || "none"}]  factset=${fsVal != null ? fmt(fsVal) : "—"}  ` +
        `closest_dist=[${dist}]  → gold=${p?.winningSource ?? "?"} ${p?.winningValue != null ? fmt(Number(p.winningValue)) : "?"} ` +
        `divergent=${p?.divergent ?? "?"}`,
    );
  }
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1e6) return n.toExponential(3);
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

async function main() {
  await dump("BEFORE");
  await explainDiscrepancies();

  console.log("\n--- raw FactSet + derived ---");
  const raw = await fetchFactSetFundamentals(T);
  const priceRow = await db
    .select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(eq(pricesHistorical.ticker, T))
    .orderBy(desc(pricesHistorical.date))
    .limit(1);
  const price = priceRow[0]?.close != null ? Number(priceRow[0].close) : null;
  const fwd = await db
    .select()
    .from(sourceFundamentals)
    .where(and(eq(sourceFundamentals.ticker, T), eq(sourceFundamentals.field, "forwardEps")));
  const fwdEps = fwd.find((r) => r.source === "yahoo")?.value;
  const derived = deriveFactSetValuations(raw ?? {}, price, fwdEps != null ? Number(fwdEps) : null);
  console.log(JSON.stringify({ price, forwardEps: fwdEps, ...derived }, null, 2));

  console.log("\n--- referee (1 ticker) ---");
  const ref = await runFactsetReferee({ tickers: [T], maxTickers: 1 });
  console.log(ref);

  if (ref.fieldsWritten > 0) {
    console.log("\n--- merge-trusted ---");
    await runMergeTrusted();
  }

  await dump("AFTER");
  await explainDiscrepancies();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
