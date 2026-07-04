/**
 * Merge fundamentals into ticker_fundamentals using per-field source priority.
 * Reads source_fundamentals; does NOT depend on trusted-fields.json (priority is hardcoded here).
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

import { db, sourceFundamentals, tickerFundamentals, fmpFundamentals } from "@workspace/db";

// ── Per-field source priority: [source, sf_field] pairs in priority order ────
// sf_field = the canonical field name as stored in source_fundamentals
// tf_col   = the ticker_fundamentals JS property to write

type SFPair = [source: string, sfField: string];
type FieldDef = { tfCol: keyof typeof tickerFundamentals.$inferInsert; priority: SFPair[] };

const FIELD_DEFS: FieldDef[] = [
  // ── Valuation ratios ──────────────────────────────────────────────────────
  { tfCol: "peRatio",            priority: [["yahoo","peRatio"],      ["finnhub","peRatio"],      ["fmp","peRatio"]] },
  { tfCol: "forwardPe",          priority: [["yahoo","forwardPe"],    ["fmp","forwardPe"]] },
  { tfCol: "pegRatio",           priority: [["yahoo","pegRatio"],     ["fmp","pegRatio"]] },
  { tfCol: "evEbitda",           priority: [["yahoo","evEbitda"],     ["fmp","evEbitda"]] },
  { tfCol: "evRevenue",          priority: [["yahoo","evRevenue"],    ["fmp","evRevenue"]] },
  { tfCol: "priceToBook",        priority: [["yahoo","priceToBook"],  ["finnhub","priceToBook"], ["fmp","priceToBook"]] },
  { tfCol: "priceToSales",       priority: [["yahoo","priceToSales"], ["fmp","priceToSales"]] },

  // ── Margins & returns (TTM: yahoo → finnhub → fmp, never edgar) ───────────
  { tfCol: "grossMargin",        priority: [["yahoo","grossMargin"],      ["finnhub","grossMargin"],      ["fmp","grossMargin"]] },
  { tfCol: "operatingMargin",    priority: [["yahoo","operatingMargin"],  ["finnhub","operatingMargin"],  ["fmp","operatingMargin"]] },
  { tfCol: "netMargin",          priority: [["yahoo","netMargin"],        ["finnhub","netMargin"],        ["fmp","netMargin"]] },
  { tfCol: "returnOnEquity",     priority: [["yahoo","returnOnEquity"],   ["finnhub","returnOnEquity"],   ["fmp","returnOnEquity"]] },
  { tfCol: "returnOnAssets",     priority: [["yahoo","returnOnAssets"],   ["finnhub","returnOnAssets"],   ["fmp","returnOnAssets"]] },
  { tfCol: "roic",               priority: [["finnhub","roic"],           ["fmp","roic"]] },

  // ── Growth ────────────────────────────────────────────────────────────────
  // yahoo/finnhub store as "revenueGrowth", fmp stores as "revenueGrowthYoY"
  { tfCol: "revenueGrowthYoY",   priority: [["yahoo","revenueGrowth"],    ["finnhub","revenueGrowth"],    ["fmp","revenueGrowthYoY"]] },
  { tfCol: "revenueGrowthYoyPrior", priority: [["fmp","revenueGrowthYoyPrior"]] },
  { tfCol: "epsGrowth",          priority: [["finnhub","epsGrowth"],      ["fmp","epsGrowth"]] },

  // ── debtToEquity: yahoo only → fmp fallback (never finnhub — different def) ─
  { tfCol: "debtToEquity",       priority: [["yahoo","debtToEquity"],  ["fmp","debtToEquity"]] },

  // ── Balance sheet ─────────────────────────────────────────────────────────
  // yahoo has "totalCash" (TTM cash), edgar/fmp have "cashAndEquivalents"
  { tfCol: "cashAndEquivalents",      priority: [["yahoo","totalCash"],            ["edgar","cashAndEquivalents"],       ["fmp","cashAndEquivalents"]] },
  { tfCol: "totalDebt",               priority: [["yahoo","totalDebt"],            ["edgar","totalDebt"],                ["fmp","totalDebt"]] },
  { tfCol: "totalStockholdersEquity", priority: [["edgar","totalEquity"],          ["fmp","totalStockholdersEquity"]] },
  { tfCol: "sharesOutstanding",       priority: [["yahoo","sharesOutstanding"],    ["edgar","sharesOutstanding"],        ["fmp","sharesOutstanding"]] },
  { tfCol: "sharesOutstandingPrior",  priority: [["fmp","sharesOutstandingPrior"]] },
  { tfCol: "currentRatio",            priority: [["yahoo","currentRatio"],         ["finnhub","currentRatio"],           ["fmp","currentRatio"]] },

  // ── Income statement (absolute $) ─────────────────────────────────────────
  // yahoo annual fields → fmp → edgar
  { tfCol: "totalRevenue",       priority: [["yahoo","annualTotalRevenue"], ["yahoo","totalRevenue"],    ["fmp","totalRevenue"],   ["edgar","totalRevenue"]] },
  { tfCol: "netIncome",          priority: [["yahoo","annualNetIncome"],    ["fmp","netIncome"],         ["edgar","netIncome"]] },
  { tfCol: "ebitda",             priority: [["yahoo","ebitda"],             ["fmp","ebitda"],            ["edgar","ebitda"]] },
  { tfCol: "ebit",               priority: [["yahoo","annualEbit"],         ["fmp","ebit"],              ["edgar","ebit"]] },
  { tfCol: "grossProfit",        priority: [["edgar","grossProfit"],        ["yahoo","annualGrossProfit"]] } as any,  // not in TF schema, skip below
  { tfCol: "interestExpense",    priority: [["edgar","interestExpense"],    ["fmp","interestExpense"]] },
  { tfCol: "effectiveTaxRate",   priority: [["fmp","effectiveTaxRate"]] },
  { tfCol: "wacc",               priority: [["fmp","wacc"]] },

  // ── Cash flow ─────────────────────────────────────────────────────────────
  { tfCol: "freeCashFlow",               priority: [["yahoo","freeCashFlow"],              ["yahoo","annualFreeCashFlow"], ["fmp","freeCashFlow"],   ["edgar","freeCashFlow"]] },
  { tfCol: "quarterlyOperatingCashFlow", priority: [["fmp","quarterlyOperatingCashFlow"]] },

  // ── Market / other ────────────────────────────────────────────────────────
  { tfCol: "beta",               priority: [["yahoo","beta"],              ["finnhub","beta"],    ["fmp","beta"]] },
  { tfCol: "dividendYield",      priority: [["yahoo","dividendYield"],     ["fmp","dividendYield"]] },
  { tfCol: "analystTargetPrice", priority: [["yahoo","analystTargetPrice"],["fmp","analystTargetPrice"]] },
  { tfCol: "earningsPerShare",   priority: [["yahoo","trailingEps"],       ["finnhub","earningsPerShare"], ["fmp","earningsPerShare"]] },
];

// Filter out fields not in ticker_fundamentals schema
const TF_COLS = new Set(Object.keys(tickerFundamentals) as string[]);
const VALID_FIELD_DEFS = FIELD_DEFS.filter(({ tfCol }) => {
  // grossProfit has no TF column — skip
  if (tfCol === "grossProfit" as any) return false;
  return true;
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Canonical ticker universe = fmp_fundamentals (169 tickers = Stock DB UI scope).
  // Using fmp_fundamentals as the allowlist ensures we only UPDATE existing
  // ticker_fundamentals rows and never INSERT new ones for out-of-scope tickers.
  const fmpRows = await db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals);
  const trackedTickers = new Set(fmpRows.map(r => r.ticker));
  console.log(`Canonical universe: ${trackedTickers.size} tickers from fmp_fundamentals\n`);

  const sfRows = await db.select().from(sourceFundamentals);

  // Index: ticker → sf_field → source → value (only for tracked tickers)
  type SFIndex = Map<string, Map<string, Map<string, number>>>;
  const index: SFIndex = new Map();
  for (const row of sfRows) {
    if (!trackedTickers.has(row.ticker)) continue;
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }

  // Iterate over ALL tracked tickers (even those with no source_fundamentals data)
  const allTickers = [...trackedTickers].sort();
  let totalTickersMerged = 0;
  let totalFieldsWritten = 0;
  const sourceUsage: Record<string, number> = {};
  const fieldNullCount: Record<string, number> = {};
  for (const { tfCol } of VALID_FIELD_DEFS) fieldNullCount[tfCol as string] = 0;

  for (const ticker of allTickers) {
    const byField = index.get(ticker)!;
    const update: Record<string, number> = {};
    const tickerSourceUsage: Record<string, number> = {};

    for (const { tfCol, priority } of VALID_FIELD_DEFS) {
      let picked: number | undefined;
      let pickedSource: string | undefined;

      for (const [src, sfField] of priority) {
        const val = byField.get(sfField)?.get(src);
        if (val !== undefined && isFinite(val)) {
          picked = val;
          pickedSource = src;
          break;
        }
      }

      if (picked !== undefined && pickedSource !== undefined) {
        update[tfCol as string] = picked;
        tickerSourceUsage[pickedSource] = (tickerSourceUsage[pickedSource] ?? 0) + 1;
        sourceUsage[pickedSource] = (sourceUsage[pickedSource] ?? 0) + 1;
      } else {
        fieldNullCount[tfCol as string]++;
      }
    }

    if (Object.keys(update).length === 0) continue;

    await db
      .insert(tickerFundamentals)
      .values({ ticker, ...update } as any)
      .onConflictDoUpdate({
        target: tickerFundamentals.ticker,
        set: update as any,
      });

    const srcStr = Object.entries(tickerSourceUsage)
      .sort(([, a], [, b]) => b - a)
      .map(([s, n]) => `${s}:${n}`)
      .join(" ");
    console.log(`[${ticker}] merged ${Object.keys(update).length} fields — sources used: ${srcStr}`);
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

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
