/**
 * Merge TRUSTED_FIELDS from source_fundamentals into ticker_fundamentals.
 * Reads trusted-fields.json produced by validate-sources.ts.
 *
 * For each trusted field: picks value from preferred source, falls back to
 * next source if preferred has no value for that ticker.
 * Only writes to ticker_fundamentals columns that exist.
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/merge-trusted.ts
 */

import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sourceFundamentals, tickerFundamentals } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Field mapping: canonical name → ticker_fundamentals JS property ───────────
// Only fields that have a direct column in ticker_fundamentals.
// operatingCashFlow is excluded (annual ≠ quarterlyOperatingCashFlow).

const FIELD_TO_TF: Record<string, keyof typeof tickerFundamentals.$inferInsert> = {
  grossMargin:       "grossMargin",
  netMargin:         "netMargin",
  operatingMargin:   "operatingMargin",
  returnOnEquity:    "returnOnEquity",
  returnOnAssets:    "returnOnAssets",
  beta:              "beta",
  currentRatio:      "currentRatio",
  priceToBook:       "priceToBook",
  debtToEquity:      "debtToEquity",
  revenueGrowth:     "revenueGrowthYoY",   // yahoo TTM YoY ≈ revenueGrowthYoY
  freeCashFlow:      "freeCashFlow",
  totalRevenue:      "totalRevenue",
  totalDebt:         "totalDebt",
  sharesOutstanding: "sharesOutstanding",
  // operatingCashFlow → skip (annual OCF ≠ quarterlyOperatingCashFlow)
};

// ── Load trusted-fields.json ──────────────────────────────────────────────────

interface TrustedEntry {
  preferredSource: string;
  passRate: number;
  fallbackSources: string[];
}

interface TrustedFields {
  trusted: Record<string, TrustedEntry>;
  disputed: Record<string, { passRate: number; topIssue: string }>;
}

function loadTrustedFields(): TrustedFields {
  const jsonPath = path.join(process.cwd(), "logs/trusted-fields.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`trusted-fields.json not found at ${jsonPath}. Run validate-sources.ts first.`);
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { trusted, disputed } = loadTrustedFields();

  // Only process trusted fields that have a ticker_fundamentals column
  const mergeableFields = Object.entries(trusted).filter(([field]) => FIELD_TO_TF[field]);
  const skippedFields = Object.keys(trusted).filter((f) => !FIELD_TO_TF[f]);

  console.log(`Trusted fields: ${Object.keys(trusted).length} total, ${mergeableFields.length} mergeable, ${skippedFields.length} skipped (no TF column)`);
  if (skippedFields.length > 0) console.log(`  Skipped: ${skippedFields.join(", ")}`);
  console.log(`Disputed fields (untouched): ${Object.keys(disputed).join(", ")}\n`);

  // Load all relevant source_fundamentals rows in one query
  const relevantFields = mergeableFields.map(([f]) => f);
  const allSources = [...new Set(mergeableFields.flatMap(([, e]) => [e.preferredSource, ...e.fallbackSources]))];

  const sfRows = await db
    .select()
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.field, relevantFields));

  // Index: ticker → field → source → value
  const index = new Map<string, Map<string, Map<string, number>>>();
  for (const row of sfRows) {
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }

  // Get all tickers in source_fundamentals for these fields
  const allTickers = [...index.keys()].sort();

  let totalTickersMerged = 0;
  let totalFieldsWritten = 0;
  const fieldNullCount: Record<string, number> = {};

  for (const [field] of mergeableFields) fieldNullCount[field] = 0;

  for (const ticker of allTickers) {
    const byField = index.get(ticker);
    if (!byField) continue;

    const update: Record<string, number | null> = {};
    let fieldsThisTicker = 0;

    for (const [field, entry] of mergeableFields) {
      const tfCol = FIELD_TO_TF[field]!;
      const bySource = byField.get(field);

      if (!bySource) {
        fieldNullCount[field]++;
        continue;
      }

      // Try preferred source first, then fallbacks
      const sourceOrder = [entry.preferredSource, ...entry.fallbackSources];
      let picked: number | undefined;
      for (const src of sourceOrder) {
        const v = bySource.get(src);
        if (v !== undefined && isFinite(v)) { picked = v; break; }
      }

      if (picked === undefined) {
        fieldNullCount[field]++;
        continue;
      }

      update[tfCol as string] = picked;
      fieldsThisTicker++;
    }

    if (fieldsThisTicker === 0) continue;

    // Upsert into ticker_fundamentals — only update the fields we have values for
    await db
      .insert(tickerFundamentals)
      .values({ ticker, ...update } as any)
      .onConflictDoUpdate({
        target: tickerFundamentals.ticker,
        set: update as any,
      });

    console.log(`[${ticker}] merged ${fieldsThisTicker} trusted fields`);
    totalTickersMerged++;
    totalFieldsWritten += fieldsThisTicker;
  }

  // Fields still null across >20% of all tickers
  const nullThreshold = Math.ceil(allTickers.length * 0.2);
  const highNullFields = Object.entries(fieldNullCount)
    .filter(([, count]) => count > nullThreshold)
    .sort(([, a], [, b]) => b - a)
    .map(([f, count]) => `${f}(${count}/${allTickers.length} null)`);

  console.log(`\nSummary:`);
  console.log(`  Total tickers merged:  ${totalTickersMerged}`);
  console.log(`  Total fields written:  ${totalFieldsWritten}`);
  console.log(`  Fields null >20% of tickers: ${highNullFields.length > 0 ? highNullFields.join(", ") : "none"}`);
  console.log(`\nDisputed fields left untouched in ticker_fundamentals:`);
  for (const [f, info] of Object.entries(disputed)) {
    console.log(`  ${f.padEnd(22)} pass_rate=${(info.passRate * 100).toFixed(0)}%  issue=${info.topIssue}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
