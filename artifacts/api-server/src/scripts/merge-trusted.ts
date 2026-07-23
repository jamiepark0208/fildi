/**
 * Merge fundamentals into ticker_fundamentals using per-field source priority.
 * Also writes field_provenance records and consults manual_overrides.
 *
 * Priority rules (first non-null source wins per field):
 *   Valuation ratios:   yahoo → finnhub → fmp
 *   Margins/returns:    yahoo → finnhub → fmp  (never edgar — period mismatch)
 *   Growth:             yahoo(revenueGrowth) → finnhub(revenueGrowth) → fmp(revenueGrowthYoY)
 *   debtToEquity:       yahoo → fmp  (never finnhub — different definition)
 *   Balance sheet:      yahoo → finnhub → edgar → fmp
 *   Income statement $: yahoo(annual) → fmp → edgar
 *   Cash flow:          yahoo → fmp → edgar
 *   Market/other:       yahoo → finnhub → fmp
 *
 * Existing ticker_fundamentals values are preserved when no source has data for that field.
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/merge-trusted.ts
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db, sourceFundamentals, tickerFundamentals, tickerRegistry,
  fieldProvenance, manualOverrides,
  type ManualOverridesRow,
} from "@workspace/db";
import { compareAll } from "./validate-sources.js";
import { provenanceCache } from "../lib/provenance-cache.js";

// ── Per-field source priority: [source, sf_field] pairs in priority order ────
// sf_field = the canonical field name as stored in source_fundamentals
// tf_col   = the ticker_fundamentals JS property to write

type SFPair = [source: string, sfField: string];
type FieldDef = { tfCol: keyof typeof tickerFundamentals.$inferInsert; priority: SFPair[] };

export const FIELD_DEFS: FieldDef[] = [
  // ── Valuation ratios ──────────────────────────────────────────────────────
  { tfCol: "peRatio",            priority: [["yahoo","peRatio"],      ["finnhub","peRatio"],      ["fmp","peRatio"],      ["alpha_vantage","peRatio"]] },
  { tfCol: "forwardPe",          priority: [["yahoo","forwardPe"],    ["fmp","forwardPe"],                               ["alpha_vantage","forwardPe"]] },
  { tfCol: "pegRatio",           priority: [["yahoo","pegRatio"],     ["fmp","pegRatio"],                                ["alpha_vantage","pegRatio"]] },
  { tfCol: "evEbitda",           priority: [["yahoo","evEbitda"],     ["fmp","evEbitda"]] },
  { tfCol: "evRevenue",          priority: [["yahoo","evRevenue"],    ["fmp","evRevenue"]] },
  { tfCol: "priceToBook",        priority: [["yahoo","priceToBook"],  ["finnhub","priceToBook"], ["fmp","priceToBook"],  ["alpha_vantage","priceToBook"]] },
  { tfCol: "priceToSales",       priority: [["yahoo","priceToSales"], ["finnhub","psRatio"], ["fmp","priceToSales"]] },

  // ── Margins & returns (TTM: yahoo → finnhub → fmp → polygon → av) ────────
  { tfCol: "grossMargin",        priority: [["yahoo","grossMargin"],      ["finnhub","grossMargin"],      ["fmp","grossMargin"],      ["polygon","grossMargin"]] },
  { tfCol: "operatingMargin",    priority: [["yahoo","operatingMargin"],  ["finnhub","operatingMargin"],  ["fmp","operatingMargin"],  ["polygon","operatingMargin"], ["alpha_vantage","operatingMargin"]] },
  { tfCol: "netMargin",          priority: [["yahoo","netMargin"],        ["finnhub","netMargin"],        ["fmp","netMargin"],        ["alpha_vantage","netMargin"]] },
  { tfCol: "returnOnEquity",     priority: [["yahoo","returnOnEquity"],   ["finnhub","returnOnEquity"],   ["fmp","returnOnEquity"],   ["alpha_vantage","returnOnEquity"]] },
  { tfCol: "returnOnAssets",     priority: [["yahoo","returnOnAssets"],   ["finnhub","returnOnAssets"],   ["fmp","returnOnAssets"]] },
  { tfCol: "roic",               priority: [["yahoo","roic"],             ["finnhub","roic"],           ["fmp","roic"]] },

  // ── Growth ────────────────────────────────────────────────────────────────
  { tfCol: "revenueGrowthYoY",      priority: [["yahoo","revenueGrowth"],    ["finnhub","revenueGrowth"],    ["fmp","revenueGrowthYoY"]] },
  { tfCol: "revenueGrowthYoyPrior", priority: [["yahoo","revenueGrowthYoyPrior"], ["fmp","revenueGrowthYoyPrior"]] },
  { tfCol: "epsGrowth",             priority: [["yahoo","epsGrowth"],       ["finnhub","epsGrowth"],      ["fmp","epsGrowth"]] },

  // ── debtToEquity: yahoo only → fmp fallback (never finnhub — different def) ─
  { tfCol: "debtToEquity",       priority: [["yahoo","debtToEquity"],  ["fmp","debtToEquity"]] },

  // ── Balance sheet ─────────────────────────────────────────────────────────
  { tfCol: "cashAndEquivalents",      priority: [["yahoo","totalCash"],            ["edgar","cashAndEquivalents"],       ["fmp","cashAndEquivalents"]] },
  { tfCol: "totalDebt",               priority: [["yahoo","totalDebt"],            ["edgar","totalDebt"],                ["fmp","totalDebt"],            ["polygon","totalDebt"]] },
  { tfCol: "totalStockholdersEquity", priority: [["edgar","totalEquity"],          ["fmp","totalStockholdersEquity"],   ["polygon","totalStockholdersEquity"]] },
  { tfCol: "sharesOutstanding",       priority: [["yahoo","sharesOutstanding"],    ["edgar","sharesOutstanding"],        ["fmp","sharesOutstanding"]] },
  { tfCol: "sharesOutstandingPrior",  priority: [["yahoo","sharesOutstandingPrior"], ["fmp","sharesOutstandingPrior"]] },
  { tfCol: "currentRatio",            priority: [["yahoo","currentRatio"],         ["finnhub","currentRatio"],           ["fmp","currentRatio"]] },

  // ── Income statement (absolute $) ─────────────────────────────────────────
  { tfCol: "totalRevenue",       priority: [["yahoo","annualTotalRevenue"], ["yahoo","totalRevenue"],    ["fmp","totalRevenue"],   ["edgar","totalRevenue"],  ["polygon","totalRevenue"],  ["alpha_vantage","totalRevenue"]] },
  { tfCol: "netIncome",          priority: [["yahoo","annualNetIncome"],    ["fmp","netIncome"],         ["edgar","netIncome"],    ["polygon","netIncome"]] },
  { tfCol: "ebitda",             priority: [["yahoo","ebitda"],             ["fmp","ebitda"],            ["edgar","ebitda"],       ["alpha_vantage","ebitda"]] },
  { tfCol: "ebit",               priority: [["yahoo","annualEbit"],         ["fmp","ebit"],              ["edgar","ebit"]] },
  { tfCol: "grossProfit",        priority: [["edgar","grossProfit"],        ["yahoo","annualGrossProfit"]] } as any,
  { tfCol: "interestExpense",    priority: [["edgar","interestExpense"],    ["yahoo","interestExpense"],  ["fmp","interestExpense"],   ["polygon","interestExpense"]] },
  { tfCol: "effectiveTaxRate",   priority: [["yahoo","effectiveTaxRate"], ["fmp","effectiveTaxRate"]] },
  { tfCol: "wacc",               priority: [["yahoo","wacc"],             ["fmp","wacc"]] },

  // ── Cash flow ─────────────────────────────────────────────────────────────
  { tfCol: "freeCashFlow",               priority: [["yahoo","freeCashFlow"],              ["yahoo","annualFreeCashFlow"], ["fmp","freeCashFlow"],   ["edgar","freeCashFlow"]] },
  // FMP "quarter" cash-flow endpoint returns YTD from 10-Q, not isolated quarter — Yahoo only.
  { tfCol: "quarterlyOperatingCashFlow", priority: [["yahoo","quarterlyOperatingCashFlow"]] },

  // ── Market / other ────────────────────────────────────────────────────────
  { tfCol: "beta",               priority: [["yahoo","beta"],              ["finnhub","beta"],    ["fmp","beta"],              ["alpha_vantage","beta"]] },
  { tfCol: "dividendYield",      priority: [["yahoo","dividendYield"],     ["finnhub","dividendYield"], ["fmp","dividendYield"], ["alpha_vantage","dividendYield"]] },
  { tfCol: "analystTargetPrice", priority: [["yahoo","analystTargetPrice"],["fmp","analystTargetPrice"],                      ["alpha_vantage","analystTargetPrice"]] },
  { tfCol: "earningsPerShare",   priority: [["yahoo","trailingEps"],       ["finnhub","earningsPerShare"], ["fmp","earningsPerShare"]] },
];

// grossProfit has no ticker_fundamentals column — skip in merge
const VALID_FIELD_DEFS = FIELD_DEFS.filter(({ tfCol }) => (tfCol as string) !== "grossProfit");

// ── Resolution result type ────────────────────────────────────────────────────

export type ResolveResult = {
  source: string;
  value: number;
  isOverride: boolean;
  divergent: boolean;
} | null;

// ── Internal: resolve from a pre-built index ──────────────────────────────────
// byField: sfField → source → value  (from source_fundamentals)
// override: manual_overrides row for this (ticker, field), if any

function resolveFromIndex(
  fieldDef: FieldDef,
  byField: Map<string, Map<string, number>>,
  override: ManualOverridesRow | undefined,
): ResolveResult {
  const { priority } = fieldDef;

  // Collect all (source → value) pairs that have data across all sfField aliases.
  // First sfField alias wins per source for divergence comparison.
  const allVals = new Map<string, number>();
  for (const [src, sfField] of priority) {
    const val = byField.get(sfField)?.get(src);
    if (val !== undefined && isFinite(val) && !allVals.has(src)) {
      allVals.set(src, val);
    }
  }

  const divergent = allVals.size >= 2 && compareAll(allVals) !== "PASS";

  // Override takes precedence over normal priority
  if (override) {
    // Literal value override (overrideSource = 'manual')
    if (override.overrideValue !== null) {
      const v = parseFloat(String(override.overrideValue));
      if (isFinite(v)) {
        return { source: override.overrideSource, value: v, isOverride: true, divergent };
      }
    }
    // Source-preference override: use best value from the specified source
    const srcVal = allVals.get(override.overrideSource);
    if (srcVal !== undefined) {
      return { source: override.overrideSource, value: srcVal, isOverride: true, divergent };
    }
    // overrideSource has no data — fall through to normal priority
  }

  // Normal priority walk: first non-null source wins
  for (const [src, sfField] of priority) {
    const val = byField.get(sfField)?.get(src);
    if (val !== undefined && isFinite(val)) {
      return { source: src, value: val, isOverride: false, divergent };
    }
  }

  return null;
}

// ── Public: resolve a single (ticker, field) by querying DB ──────────────────
// Used by PUT/DELETE /api/fundamentals/override to re-resolve immediately.

export async function resolveField(ticker: string, field: string): Promise<ResolveResult> {
  const fieldDef = VALID_FIELD_DEFS.find(d => (d.tfCol as string) === field);
  if (!fieldDef) return null;

  const [sfRows, overrideRows] = await Promise.all([
    db.select().from(sourceFundamentals).where(eq(sourceFundamentals.ticker, ticker)),
    db.select().from(manualOverrides).where(
      and(eq(manualOverrides.ticker, ticker), eq(manualOverrides.field, field))
    ),
  ]);

  const byField = new Map<string, Map<string, number>>();
  for (const row of sfRows) {
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }

  return resolveFromIndex(fieldDef, byField, overrideRows[0]);
}

// ── Public: write a field_provenance record ───────────────────────────────────

export async function writeProvenance(
  ticker: string,
  field: string,
  result: ResolveResult,
  fetchedAt: Date,
): Promise<void> {
  if (!result) return;
  await db
    .insert(fieldProvenance)
    .values({
      ticker, field,
      winningSource: result.source,
      winningValue:  String(result.value),
      isOverride:    result.isOverride,
      divergent:     result.divergent,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [fieldProvenance.ticker, fieldProvenance.field],
      set: {
        winningSource: result.source,
        winningValue:  String(result.value),
        isOverride:    result.isOverride,
        divergent:     result.divergent,
        fetchedAt,
        updatedAt:     new Date(),
      },
    });
}

// ── Main batch runner ─────────────────────────────────────────────────────────

async function main() {
  const regRows = await db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true));
  const trackedTickers = new Set(regRows.map(r => r.ticker));
  console.log(`Canonical universe: ${trackedTickers.size} tickers (fetch_fundamentals=true in ticker_registry)\n`);

  const [sfRows, overrideRows, existingRows] = await Promise.all([
    db.select().from(sourceFundamentals),
    db.select().from(manualOverrides),
    db.select().from(tickerFundamentals),
  ]);
  const existingMap = new Map(existingRows.map(r => [r.ticker, r as Record<string, unknown>]));

  // Treat a value as "changed" only past a small tolerance — avoids logging
  // noise from float round-tripping through numeric/string DB columns.
  function isChanged(oldVal: unknown, newVal: number): { changed: boolean; from: number | null } {
    if (oldVal == null) return { changed: true, from: null };
    const from = parseFloat(String(oldVal));
    if (!isFinite(from)) return { changed: true, from: null };
    return { changed: Math.abs(from - newVal) > Math.max(1e-6, Math.abs(from) * 0.0005), from };
  }
  const fmt = (n: number | null) => n == null ? "—" : Number(n.toFixed(4)).toString();

  // Index: ticker → sfField → source → value
  const index = new Map<string, Map<string, Map<string, number>>>();
  for (const row of sfRows) {
    if (!trackedTickers.has(row.ticker)) continue;
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }

  // Override index: `${ticker}:${field}` → ManualOverridesRow
  const overrideIndex = new Map<string, ManualOverridesRow>();
  for (const row of overrideRows) {
    overrideIndex.set(`${row.ticker}:${row.field}`, row);
  }

  const allTickers = [...trackedTickers].sort();
  let totalTickersMerged = 0;
  let totalFieldsWritten = 0;
  const sourceUsage: Record<string, number> = {};
  const fieldNullCount: Record<string, number> = {};
  for (const { tfCol } of VALID_FIELD_DEFS) fieldNullCount[tfCol as string] = 0;

  const now = new Date();

  for (const ticker of allTickers) {
    const byField = index.get(ticker) ?? new Map();
    const update: Record<string, number> = {};
    const provenanceBatch: Array<{ field: string; result: Exclude<ResolveResult, null> }> = [];
    const tickerNullFields: string[] = [];
    const changedFields: Array<{ field: string; from: number | null; to: number }> = [];
    const existing = existingMap.get(ticker);

    for (const fieldDef of VALID_FIELD_DEFS) {
      const override = overrideIndex.get(`${ticker}:${fieldDef.tfCol}`);
      const result = resolveFromIndex(fieldDef, byField, override);

      if (result) {
        update[fieldDef.tfCol as string] = result.value;
        sourceUsage[result.source] = (sourceUsage[result.source] ?? 0) + 1;
        provenanceBatch.push({ field: fieldDef.tfCol as string, result });

        const { changed, from } = isChanged(existing?.[fieldDef.tfCol as string], result.value);
        if (changed) changedFields.push({ field: fieldDef.tfCol as string, from, to: result.value });
      } else {
        fieldNullCount[fieldDef.tfCol as string]++;
        tickerNullFields.push(fieldDef.tfCol as string);
      }
    }

    if (Object.keys(update).length === 0) continue;

    const divergentFields = provenanceBatch
      .filter(({ result }) => result.divergent)
      .map(({ field }) => field);
    const discrepancyFlags = divergentFields.length > 0 ? divergentFields.join(",") : null;

    await db
      .insert(tickerFundamentals)
      .values({ ticker, ...update, fundamentalsLastFetched: now, discrepancyFlags } as any)
      .onConflictDoUpdate({ target: tickerFundamentals.ticker, set: { ...update, fundamentalsLastFetched: now, discrepancyFlags } as any });

    if (provenanceBatch.length > 0) {
      await db
        .insert(fieldProvenance)
        .values(provenanceBatch.map(({ field, result }) => ({
          ticker, field,
          winningSource: result!.source,
          winningValue:  String(result!.value),
          isOverride:    result!.isOverride,
          divergent:     result!.divergent,
          fetchedAt:     now,
        })))
        .onConflictDoUpdate({
          target: [fieldProvenance.ticker, fieldProvenance.field],
          set: {
            winningSource: sql`excluded.winning_source`,
            winningValue:  sql`excluded.winning_value`,
            isOverride:    sql`excluded.is_override`,
            divergent:     sql`excluded.divergent`,
            fetchedAt:     sql`excluded.fetched_at`,
            updatedAt:     now,
          },
        });
    }

    provenanceCache.delete(ticker);

    if (changedFields.length > 0) {
      const shown = changedFields.slice(0, 6).map(c => `${c.field} ${fmt(c.from)}→${fmt(c.to)}`).join(", ");
      const more  = changedFields.length > 6 ? ` (+${changedFields.length - 6} more)` : "";
      console.log(`[${ticker}] updated: ${shown}${more}`);
    }
    totalTickersMerged++;
    totalFieldsWritten += Object.keys(update).length;
  }

  const nullThreshold = Math.ceil(allTickers.length * 0.2);
  const highNullFields = Object.entries(fieldNullCount)
    .filter(([, n]) => n > nullThreshold)
    .sort(([, a], [, b]) => b - a)
    .map(([f, n]) => `${f}(${n}/${allTickers.length})`);

  const srcBreakdown = Object.entries(sourceUsage)
    .sort(([, a], [, b]) => b - a)
    .map(([s, n]) => `${s}=${n}`)
    .join("  ");

  console.log(`\nSummary:`);
  console.log(`  Total tickers merged:  ${totalTickersMerged}`);
  console.log(`  Total fields written:  ${totalFieldsWritten}`);
  console.log(`  Source usage breakdown: ${srcBreakdown}`);
  console.log(`  Fields null >20% of tickers: ${highNullFields.length > 0 ? highNullFields.join(", ") : "none"}`);

  process.exit(0);
}

const isMain = ["merge-trusted.ts", "merge-trusted.js", "merge-trusted.mjs"].some(s => process.argv[1]?.endsWith(s));
if (isMain) main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
