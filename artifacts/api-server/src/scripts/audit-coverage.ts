/**
 * Coverage audit — per-field null counts, source staging diagnostics, and per-ticker drilldown.
 *
 * Modes:
 *   node dist/audit-coverage.mjs                    — full summary
 *   node dist/audit-coverage.mjs --ticker=AAPL      — drilldown for one ticker
 *   node dist/audit-coverage.mjs --field=wacc       — all tickers null for this field + why
 */
import { eq } from "drizzle-orm";
import {
  db, tickerFundamentals, tickerRegistry, sourceFundamentals,
  yahooFundamentals, fmpFundamentals, finnhubFundamentals,
  edgarFundamentals, polygonFundamentals, avFundamentals,
} from "@workspace/db";
import { FIELD_DEFS } from "./merge-trusted.js";

const VALID_FIELDS = FIELD_DEFS.filter(d => (d.tfCol as string) !== "grossProfit");

// CLI flags
const TICKER_ARG = process.argv.find(a => a.startsWith("--ticker="))?.split("=")[1]?.toUpperCase();
const FIELD_ARG  = process.argv.find(a => a.startsWith("--field="))?.split("=")[1];

// Staging table presence index: ticker → source → fetchedAt (non-null means "API was called")
type StagingIndex = Map<string, Map<string, Date | null>>;

async function buildStagingIndex(): Promise<StagingIndex> {
  const [yahoo, fmp, finnhub, edgar, polygon, av] = await Promise.all([
    db.select({ ticker: yahooFundamentals.ticker,   fetchedAt: yahooFundamentals.fetchedAt   }).from(yahooFundamentals),
    db.select({ ticker: fmpFundamentals.ticker,     fetchedAt: fmpFundamentals.fetchedAt     }).from(fmpFundamentals),
    db.select({ ticker: finnhubFundamentals.ticker, fetchedAt: finnhubFundamentals.fetchedAt }).from(finnhubFundamentals),
    db.select({ ticker: edgarFundamentals.ticker,   fetchedAt: edgarFundamentals.fetchedAt   }).from(edgarFundamentals),
    db.select({ ticker: polygonFundamentals.ticker, fetchedAt: polygonFundamentals.fetchedAt }).from(polygonFundamentals),
    db.select({ ticker: avFundamentals.ticker,      fetchedAt: avFundamentals.fetchedAt      }).from(avFundamentals),
  ]);
  const sourceRows: { source: string; ticker: string; fetchedAt: Date | null }[] = [
    ...yahoo.map(r => ({ source: "yahoo",         ...r })),
    ...fmp.map(r   => ({ source: "fmp",           ...r })),
    ...finnhub.map(r => ({ source: "finnhub",     ...r })),
    ...edgar.map(r  => ({ source: "edgar",        ...r })),
    ...polygon.map(r => ({ source: "polygon",     ...r })),
    ...av.map(r     => ({ source: "alpha_vantage",...r })),
  ];
  const idx: StagingIndex = new Map();
  for (const { ticker, source, fetchedAt } of sourceRows) {
    if (!idx.has(ticker)) idx.set(ticker, new Map());
    idx.get(ticker)!.set(source, fetchedAt);
  }
  return idx;
}

async function main() {
  const [tfRows, regRows, sfRows, stagingIdx] = await Promise.all([
    db.select().from(tickerFundamentals),
    db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true)),
    db.select({ ticker: sourceFundamentals.ticker, source: sourceFundamentals.source, field: sourceFundamentals.field }).from(sourceFundamentals),
    buildStagingIndex(),
  ]);

  const allTickers = regRows.map(r => r.ticker);
  const tfMap = new Map(tfRows.map(r => [r.ticker, r]));

  // source_fundamentals index: ticker → source → Set<field> (non-null values only)
  const sfIndex = new Map<string, Map<string, Set<string>>>();
  for (const row of sfRows) {
    if (!sfIndex.has(row.ticker)) sfIndex.set(row.ticker, new Map());
    const bySource = sfIndex.get(row.ticker)!;
    if (!bySource.has(row.source)) bySource.set(row.source, new Set());
    bySource.get(row.source)!.add(row.field);
  }

  // ── --ticker drilldown ────────────────────────────────────────────────────
  if (TICKER_ARG) {
    const row = tfMap.get(TICKER_ARG);
    console.log(`\n═══ TICKER DRILLDOWN: ${TICKER_ARG} ═══`);
    if (!row) console.log("  ⚠  No row in ticker_fundamentals");

    const staging = stagingIdx.get(TICKER_ARG);
    const SOURCES = ["yahoo","fmp","finnhub","edgar","polygon","alpha_vantage"];
    console.log("\nStaging table status:");
    for (const src of SOURCES) {
      const fetched = staging?.get(src);
      console.log(`  ${src.padEnd(16)} ${fetched ? `fetched ${fetched.toISOString().slice(0,10)}` : "NEVER FETCHED"}`);
    }

    console.log("\nPer-field breakdown:");
    console.log(`  ${"FIELD".padEnd(28)} ${"TF VALUE".padEnd(14)} SOURCE_SF             STAGING`);
    console.log("  " + "─".repeat(90));
    for (const { tfCol, priority } of VALID_FIELDS) {
      const field = tfCol as string;
      const tfVal = row ? (row as Record<string, unknown>)[field] : undefined;
      const isNull = tfVal == null;

      const sfStatus = priority.map(([src, sfField]) => {
        const has = sfIndex.get(TICKER_ARG)?.get(src)?.has(sfField);
        return has ? `${src}✓` : null;
      }).filter(Boolean).join(", ") || "none";

      const stagingStatus = priority.map(([src]) => {
        const uniq = [...new Set(priority.filter(([s]) => s === src).map(([s]) => s))];
        return uniq.map(s => staging?.has(s) ? `${s}✓` : `${s}✗`);
      }).flat().filter((v, i, a) => a.indexOf(v) === i).join(" ");

      const tfDisplay = isNull ? "NULL" : String(tfVal).slice(0, 12);
      console.log(`  ${field.padEnd(28)} ${tfDisplay.padEnd(14)} sf:[${sfStatus.padEnd(18)}] staging:[${stagingStatus}]`);
    }
    return;
  }

  // ── --field drilldown ─────────────────────────────────────────────────────
  if (FIELD_ARG) {
    const fieldDef = VALID_FIELDS.find(d => (d.tfCol as string) === FIELD_ARG);
    if (!fieldDef) { console.log(`Unknown field: ${FIELD_ARG}`); return; }
    const { tfCol, priority } = fieldDef;
    const nullTickers = allTickers.filter(t => {
      const row = tfMap.get(t);
      return !row || (row as Record<string, unknown>)[tfCol as string] == null;
    });

    console.log(`\n═══ FIELD DRILLDOWN: ${FIELD_ARG} ═══`);
    console.log(`${nullTickers.length} / ${allTickers.length} tickers are null\n`);
    console.log(`Priority chain: ${priority.map(([s,f]) => `${s}:${f}`).join(" → ")}\n`);
    console.log(`${"TICKER".padEnd(8)} ${"TF".padEnd(6)}` + priority.map(([s]) => s.padEnd(16)).join(""));
    console.log("─".repeat(8 + 6 + priority.length * 16));

    for (const ticker of nullTickers) {
      const staging = stagingIdx.get(ticker);
      const row = tfMap.get(ticker);
      const tfVal = row ? String((row as Record<string, unknown>)[tfCol as string] ?? "NULL") : "NO_ROW";
      const cols = priority.map(([src, sfField]) => {
        const inSF = sfIndex.get(ticker)?.get(src)?.has(sfField);
        const fetched = staging?.has(src);
        if (inSF)    return "SF_HAS_VAL ".padEnd(16);
        if (fetched) return "FETCHED_NULL".padEnd(16);
        return      "NOT_FETCHED ".padEnd(16);
      });
      console.log(`${ticker.padEnd(8)} ${tfVal.padEnd(6)}${cols.join("")}`);
    }
    return;
  }

  // ── Full summary ──────────────────────────────────────────────────────────
  const totalTickers = allTickers.length;
  const missingRow = allTickers.filter(t => !tfMap.has(t));

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  COVERAGE AUDIT  —  ${totalTickers} tickers with fetch_fundamentals=true`);
  console.log(`  ticker_fundamentals rows: ${tfRows.length}  |  missing rows: ${missingRow.length}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (missingRow.length) {
    console.log(`Tickers with NO row in ticker_fundamentals: ${missingRow.join(", ")}\n`);
  }

  // Per-field null analysis with staging diagnostics
  type FieldReport = {
    field: string; nullCount: number; sources: string[];
    neverFetched: number;   // staging table has no row
    fetchedNull: number;    // staging table has row but value not in source_fundamentals
    sfHasData: number;      // source_fundamentals has value but still null in TF (pipeline not run?)
  };

  const reports: FieldReport[] = [];
  for (const { tfCol, priority } of VALID_FIELDS) {
    const field = tfCol as string;
    let nullCount = 0, neverFetched = 0, fetchedNull = 0, sfHasData = 0;

    for (const ticker of allTickers) {
      const row = tfMap.get(ticker);
      const val = row ? (row as Record<string, unknown>)[field] : null;
      if (val != null) continue;
      nullCount++;

      // Check each source in priority chain
      const staging = stagingIdx.get(ticker);
      const bySF = sfIndex.get(ticker);
      let anyFetched = false, anySFData = false;

      for (const [src, sfField] of priority) {
        if (bySF?.get(src)?.has(sfField)) { anySFData = true; break; }
        if (staging?.has(src)) anyFetched = true;
      }

      if (anySFData)       sfHasData++;
      else if (anyFetched) fetchedNull++;
      else                 neverFetched++;
    }

    const sources = priority.map(([s]) => s).filter((s, i, a) => a.indexOf(s) === i);
    reports.push({ field, nullCount, sources, neverFetched, fetchedNull, sfHasData });
  }
  reports.sort((a, b) => b.nullCount - a.nullCount);

  console.log("── PER-FIELD NULL COUNTS ────────────────────────────────────────────────────────────");
  console.log(`${"FIELD".padEnd(28)} NULL  NEVER_FETCHED  FETCHED_NULL  SF_PIPELINE  SOURCES`);
  console.log("─".repeat(110));
  for (const r of reports) {
    const pct = Math.round((r.nullCount / totalTickers) * 100);
    const bar = pct === 0 ? "✓" : pct < 30 ? "▓" : pct < 70 ? "░" : "✗";
    console.log(
      `${r.field.padEnd(28)} ${bar} ${String(r.nullCount).padStart(3)}/${totalTickers}` +
      `  ${String(r.neverFetched).padStart(13)}  ${String(r.fetchedNull).padStart(12)}  ${String(r.sfHasData).padStart(11)}` +
      `  ${r.sources.join("→")}`
    );
  }

  // Staging table coverage
  const SOURCES = ["yahoo","fmp","finnhub","edgar","polygon","alpha_vantage"];
  console.log("\n── STAGING TABLE COVERAGE (rows in source-specific table) ──");
  for (const src of SOURCES) {
    const count = allTickers.filter(t => stagingIdx.get(t)?.has(src)).length;
    const sfCount = allTickers.filter(t => sfIndex.get(t)?.has(src)).length;
    console.log(`  ${src.padEnd(16)} staging: ${String(count).padStart(3)}/${totalTickers}  source_fundamentals: ${String(sfCount).padStart(3)}/${totalTickers}`);
  }

  // Worst tickers
  const tickerNulls = allTickers.map(ticker => {
    const row = tfMap.get(ticker);
    const nullCount = row ? VALID_FIELDS.filter(({ tfCol }) => (row as Record<string, unknown>)[tfCol as string] == null).length : VALID_FIELDS.length;
    return { ticker, nullCount };
  }).sort((a, b) => b.nullCount - a.nullCount);

  console.log(`\n── WORST 30 TICKERS (of ${VALID_FIELDS.length} fields) ──`);
  for (const { ticker, nullCount } of tickerNulls.filter(t => t.nullCount > 0).slice(0, 30)) {
    const pct = Math.round((nullCount / VALID_FIELDS.length) * 100);
    console.log(`  ${ticker.padEnd(8)} ${String(nullCount).padStart(3)} nulls (${String(pct).padStart(3)}%) ${"█".repeat(Math.round(pct / 5))}`);
  }
  const complete = tickerNulls.filter(t => t.nullCount === 0).length;
  console.log(`\n  Complete: ${complete}/${totalTickers}  |  Incomplete: ${totalTickers - complete}/${totalTickers}`);
  console.log(`\n  Drilldown: node dist/audit-coverage.mjs --ticker=AAPL`);
  console.log(`             node dist/audit-coverage.mjs --field=wacc`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
