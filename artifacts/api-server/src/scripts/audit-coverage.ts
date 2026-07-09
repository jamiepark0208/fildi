/**
 * Coverage audit — shows per-field null counts across all ticker_fundamentals rows,
 * diagnoses whether nulls are due to "source never fetched" vs "source returned null",
 * and lists the most incomplete tickers.
 *
 * Run: npx tsx artifacts/api-server/src/scripts/audit-coverage.ts
 */
import { eq } from "drizzle-orm";
import { db, tickerFundamentals, tickerRegistry, sourceFundamentals } from "@workspace/db";
import { FIELD_DEFS } from "./merge-trusted.js";

const VALID_FIELDS = FIELD_DEFS.filter(d => (d.tfCol as string) !== "grossProfit");

async function main() {
  const [tfRows, regRows, sfRows] = await Promise.all([
    db.select().from(tickerFundamentals),
    db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true)),
    db.select({ ticker: sourceFundamentals.ticker, source: sourceFundamentals.source, field: sourceFundamentals.field, value: sourceFundamentals.value }).from(sourceFundamentals),
  ]);

  const allTickers = regRows.map(r => r.ticker);
  const tfMap = new Map(tfRows.map(r => [r.ticker, r]));

  // Build source_fundamentals index: ticker → source → Set<field>
  const sfIndex = new Map<string, Map<string, Set<string>>>();
  for (const row of sfRows) {
    if (!sfIndex.has(row.ticker)) sfIndex.set(row.ticker, new Map());
    const bySource = sfIndex.get(row.ticker)!;
    if (!bySource.has(row.source)) bySource.set(row.source, new Set());
    if (row.value != null) bySource.get(row.source)!.add(row.field);
  }

  const totalTickers = allTickers.length;
  const missingRow = allTickers.filter(t => !tfMap.has(t));

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  COVERAGE AUDIT  —  ${totalTickers} tickers with fetch_fundamentals=true`);
  console.log(`  ticker_fundamentals rows: ${tfRows.length}  |  missing rows: ${missingRow.length}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (missingRow.length) {
    console.log(`Tickers with NO row in ticker_fundamentals (${missingRow.length}):`);
    console.log(missingRow.join(", ") + "\n");
  }

  // ── Per-field null analysis ────────────────────────────────────────────────
  type FieldReport = {
    field: string;
    nullCount: number;
    sources: string[];
    missingFromAllSources: number; // tickers where no source has this field
  };

  const reports: FieldReport[] = [];

  for (const { tfCol, priority } of VALID_FIELDS) {
    const field = tfCol as string;
    let nullCount = 0;
    let missingFromAllSources = 0;

    for (const ticker of allTickers) {
      const row = tfMap.get(ticker);
      const val = row ? (row as Record<string, unknown>)[field] : null;
      if (val == null) {
        nullCount++;
        // Check if any source has this field
        const bySrc = sfIndex.get(ticker);
        const anySourceHasIt = priority.some(([src, sfField]) => bySrc?.get(src)?.has(sfField));
        if (!anySourceHasIt) missingFromAllSources++;
      }
    }

    const sources = priority.map(([s]) => s).filter((s, i, a) => a.indexOf(s) === i);
    reports.push({ field, nullCount, sources, missingFromAllSources });
  }

  reports.sort((a, b) => b.nullCount - a.nullCount);

  console.log("── PER-FIELD NULL COUNTS (sorted worst first) ──────────────────");
  console.log(`${"FIELD".padEnd(28)} ${"NULL".padStart(5)} / ${totalTickers} ${"SOURCES (priority)".padEnd(40)} MISSING_FROM_ALL_SRCS`);
  console.log("─".repeat(100));

  for (const r of reports) {
    const pct = Math.round((r.nullCount / totalTickers) * 100);
    const bar = pct === 0 ? "✓" : pct < 30 ? "▓" : pct < 70 ? "░░" : "✗✗";
    console.log(
      `${r.field.padEnd(28)} ${String(r.nullCount).padStart(5)} / ${totalTickers} (${String(pct).padStart(3)}%) ${bar.padEnd(4)}  ` +
      `${r.sources.join(" → ").padEnd(42)} ${r.missingFromAllSources > 0 ? `${r.missingFromAllSources} tickers have NO source data` : ""}`
    );
  }

  // ── Source coverage summary ───────────────────────────────────────────────
  const SOURCES = ["yahoo", "fmp", "finnhub", "edgar", "polygon", "alpha_vantage"];
  console.log("\n── SOURCE COVERAGE (tickers with ≥1 field in source_fundamentals) ──");
  for (const src of SOURCES) {
    const count = allTickers.filter(t => sfIndex.get(t)?.has(src)).length;
    console.log(`  ${src.padEnd(16)} ${count} / ${totalTickers} tickers`);
  }

  // ── Per-ticker null counts (worst 30) ─────────────────────────────────────
  const tickerNulls = allTickers.map(ticker => {
    const row = tfMap.get(ticker);
    const nullCount = row
      ? VALID_FIELDS.filter(({ tfCol }) => (row as Record<string, unknown>)[tfCol as string] == null).length
      : VALID_FIELDS.length;
    return { ticker, nullCount };
  });
  tickerNulls.sort((a, b) => b.nullCount - a.nullCount);
  const worst = tickerNulls.filter(t => t.nullCount > 0).slice(0, 30);

  console.log(`\n── WORST 30 TICKERS BY NULL COUNT (of ${VALID_FIELDS.length} fields) ──`);
  for (const { ticker, nullCount } of worst) {
    const pct = Math.round((nullCount / VALID_FIELDS.length) * 100);
    const bar = "█".repeat(Math.round(pct / 5));
    console.log(`  ${ticker.padEnd(8)} ${String(nullCount).padStart(3)} nulls (${String(pct).padStart(3)}%) ${bar}`);
  }

  const complete = tickerNulls.filter(t => t.nullCount === 0).length;
  console.log(`\n  Complete (0 nulls): ${complete} / ${totalTickers} tickers`);
  console.log(`  Incomplete:         ${totalTickers - complete} / ${totalTickers} tickers`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
