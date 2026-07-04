/**
 * Populate source_fundamentals from all four staging tables that currently have data.
 * One row per (ticker, source, field) with camelCase canonical field names.
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/populate-source-fundamentals.ts
 */

import { sql } from "drizzle-orm";
import {
  db,
  yahooFundamentals,
  edgarFundamentals,
  finnhubFundamentals,
  fmpFundamentals,
  sourceFundamentals,
} from "@workspace/db";

type Row = Record<string, unknown>;

// ── Field maps: JS property name → canonical camelCase field name ─────────────

const YAHOO_FIELDS: Record<string, string> = {
  yahooGrossMargins:          "grossMargin",
  yahooOperatingMargins:      "operatingMargin",
  yahooProfitMargins:         "netMargin",
  yahooReturnOnEquity:        "returnOnEquity",
  yahooReturnOnAssets:        "returnOnAssets",
  yahooRevenueGrowth:         "revenueGrowth",
  yahooDebtToEquity:          "debtToEquity",
  yahooCurrentRatio:          "currentRatio",
  yahooTotalRevenue:          "totalRevenue",
  yahooTotalDebt:             "totalDebt",
  yahooTotalCash:             "totalCash",
  yahooFreeCashflow:          "freeCashFlow",
  yahooOperatingCashflow:     "operatingCashFlow",
  yahooEbitda:                "ebitda",
  yahooTargetMeanPrice:       "analystTargetPrice",
  yahooForwardPe:             "forwardPe",
  yahooPegRatio:              "pegRatio",
  yahooPriceToBook:           "priceToBook",
  yahooEnterpriseToEbitda:    "evEbitda",
  yahooEnterpriseToRevenue:   "evRevenue",
  yahooTrailingEps:           "trailingEps",
  yahooForwardEps:            "forwardEps",
  yahooBeta:                  "beta",
  yahooSharesOutstanding:     "sharesOutstanding",
  yahooFloatShares:           "floatShares",
  yahooHeldPercentInsiders:   "heldPercentInsiders",
  yahooShortRatio:            "shortRatio",
  yahooAnnualTotalRevenue:    "annualTotalRevenue",
  yahooAnnualGrossProfit:     "annualGrossProfit",
  yahooAnnualEbit:            "annualEbit",
  yahooAnnualNetIncome:       "annualNetIncome",
  yahooAnnualRevenueYoy:      "annualRevenueYoy",
  yahooAnnualCash:            "annualCash",
  yahooAnnualTotalDebt:       "annualTotalDebt",
  yahooAnnualTotalEquity:     "annualTotalEquity",
  yahooAnnualOperatingCashFlow: "annualOperatingCashFlow",
  yahooAnnualCapex:           "annualCapex",
  yahooAnnualFreeCashFlow:    "annualFreeCashFlow",
};

const EDGAR_FIELDS: Record<string, string> = {
  edgarTotalRevenue:       "totalRevenue",
  edgarGrossProfit:        "grossProfit",
  edgarNetIncome:          "netIncome",
  edgarEbit:               "ebit",
  edgarEbitda:             "ebitda",
  edgarFreeCashFlow:       "freeCashFlow",
  edgarOperatingCashFlow:  "operatingCashFlow",
  edgarCapitalExpenditure: "capitalExpenditure",
  edgarCashAndEquivalents: "cashAndEquivalents",
  edgarTotalDebt:          "totalDebt",
  edgarTotalEquity:        "totalEquity",
  edgarInterestExpense:    "interestExpense",
  edgarSharesOutstanding:  "sharesOutstanding",
  edgarGrossMargin:        "grossMargin",
  edgarNetMargin:          "netMargin",
};

const FINNHUB_FIELDS: Record<string, string> = {
  finnhubPeRatio:               "peRatio",
  finnhubPbRatio:               "pbRatio",
  finnhubPsRatio:               "psRatio",
  finnhubPriceToBook:           "priceToBook",
  finnhubEv:                    "ev",
  finnhubMarketCap:             "marketCap",
  finnhubGrossMargin:           "grossMargin",
  finnhubOperatingMargin:       "operatingMargin",
  finnhubNetMargin:             "netMargin",
  finnhubFcfMargin:             "fcfMargin",
  finnhubReturnOnEquity:        "returnOnEquity",
  finnhubReturnOnAssets:        "returnOnAssets",
  finnhubRoic:                  "roic",
  finnhubRevenueGrowth:         "revenueGrowth",
  finnhubEpsGrowth:             "epsGrowth",
  finnhubDebtToEquity:          "debtToEquity",
  finnhubLongTermDebtToEquity:  "longTermDebtToEquity",
  finnhubNetDebtToEquity:       "netDebtToEquity",
  finnhubCurrentRatio:          "currentRatio",
  finnhubQuickRatio:            "quickRatio",
  finnhubFcfPerShare:           "fcfPerShare",
  finnhubBookValue:             "bookValue",
  finnhubBeta:                  "beta",
  finnhubEps:                   "eps",
  finnhubEbitPerShare:          "ebitPerShare",
  finnhubEarningsPerShare:      "earningsPerShare",
  finnhub52weekHigh:            "weekHigh52",
  finnhub52weekLow:             "weekLow52",
};

const FMP_FIELDS: Record<string, string> = {
  fmpPeRatio:                    "peRatio",
  fmpPegRatio:                   "pegRatio",
  fmpForwardPe:                  "forwardPe",
  fmpEvEbitda:                   "evEbitda",
  fmpEvRevenue:                  "evRevenue",
  fmpPriceToBook:                "priceToBook",
  fmpPriceToSales:               "priceToSales",
  fmpAnalystTargetPrice:         "analystTargetPrice",
  fmpRevenueGrowthYoY:           "revenueGrowthYoY",
  fmpRevenueGrowthYoyPrior:      "revenueGrowthYoyPrior",
  fmpEpsGrowth:                  "epsGrowth",
  fmpEarningsPerShare:           "earningsPerShare",
  fmpGrossMargin:                "grossMargin",
  fmpOperatingMargin:            "operatingMargin",
  fmpNetMargin:                  "netMargin",
  fmpReturnOnEquity:             "returnOnEquity",
  fmpReturnOnAssets:             "returnOnAssets",
  fmpEffectiveTaxRate:           "effectiveTaxRate",
  fmpTotalRevenue:               "totalRevenue",
  fmpNetIncome:                  "netIncome",
  fmpEbitda:                     "ebitda",
  fmpEbit:                       "ebit",
  fmpInterestExpense:            "interestExpense",
  fmpFreeCashFlow:               "freeCashFlow",
  fmpCurrentRatio:               "currentRatio",
  fmpDebtToEquity:               "debtToEquity",
  fmpTotalDebt:                  "totalDebt",
  fmpTotalStockholdersEquity:    "totalStockholdersEquity",
  fmpCashAndEquivalents:         "cashAndEquivalents",
  fmpWacc:                       "wacc",
  fmpRoic:                       "roic",
  fmpQuarterlyOperatingCashFlow: "quarterlyOperatingCashFlow",
  fmpSharesOutstanding:          "sharesOutstanding",
  fmpSharesOutstandingPrior:     "sharesOutstandingPrior",
  fmpDividendYield:              "dividendYield",
  fmpBeta:                       "beta",
};

// ── Rejection rules (applied before writing to source_fundamentals) ───────────
// These mirror the SQL cleanup run on 2026-07-04. Any future backfill passes
// through these guards so invalid values are never written.

type RejectionRule = { fields: string[]; test: (v: number) => boolean; reason: string };

const REJECTION_RULES: RejectionRule[] = [
  {
    fields: ["grossMargin", "operatingMargin", "netMargin"],
    test: (v) => v > 1.0 || v < -1.0,
    reason: "margin outside [-1, 1] range",
  },
  {
    fields: ["returnOnEquity", "returnOnAssets"],
    test: (v) => Math.abs(v) > 2.0,
    reason: "|ROE/ROA| > 2.0 (200%)",
  },
  {
    fields: ["currentRatio", "priceToBook", "peRatio"],
    test: (v) => v < 0,
    reason: "ratio cannot be negative",
  },
];

function isRejected(field: string, value: number): boolean {
  for (const rule of REJECTION_RULES) {
    if (rule.fields.includes(field) && rule.test(value)) return true;
  }
  return false;
}

// ── Core function ─────────────────────────────────────────────────────────────

async function populateFromTable(
  rows: Row[],
  source: string,
  fieldMap: Record<string, string>,
  fetchedAtKey: string,
) {
  let tickers = 0;
  let totalFields = 0;
  let rejected = 0;

  for (const row of rows) {
    const ticker = row["ticker"] as string;
    const fetchedAt = (row[fetchedAtKey] as Date | null) ?? new Date();
    const batch: { ticker: string; source: string; field: string; value: string; fetchedAt: Date }[] = [];

    for (const [prop, canonical] of Object.entries(fieldMap)) {
      const val = row[prop];
      if (val === null || val === undefined) continue;
      const numVal = typeof val === "string" ? parseFloat(val) : Number(val);
      if (!isFinite(numVal)) continue;
      if (isRejected(canonical, numVal)) { rejected++; continue; }
      batch.push({ ticker, source, field: canonical, value: String(numVal), fetchedAt });
    }

    if (batch.length === 0) continue;

    // Bulk upsert in one query per ticker
    await db
      .insert(sourceFundamentals)
      .values(batch)
      .onConflictDoUpdate({
        target: [sourceFundamentals.ticker, sourceFundamentals.source, sourceFundamentals.field],
        set: {
          value:     sql`excluded.value`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });

    tickers++;
    totalFields += batch.length;
  }

  return { tickers, totalFields, rejected };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [yahooRows, edgarRows, finnhubRows, fmpRows] = await Promise.all([
    db.select().from(yahooFundamentals),
    db.select().from(edgarFundamentals),
    db.select().from(finnhubFundamentals),
    db.select().from(fmpFundamentals),
  ]);

  console.log(`Loaded: yahoo=${yahooRows.length} edgar=${edgarRows.length} finnhub=${finnhubRows.length} fmp=${fmpRows.length}`);

  console.log("\nPopulating from yahoo_fundamentals …");
  const yahoo = await populateFromTable(yahooRows as Row[], "yahoo", YAHOO_FIELDS, "fetchedAt");
  console.log(`  → ${yahoo.tickers} tickers, ${yahoo.totalFields} fields, ${yahoo.rejected} rejected`);

  console.log("Populating from edgar_fundamentals …");
  const edgar = await populateFromTable(edgarRows as Row[], "edgar", EDGAR_FIELDS, "fetchedAt");
  console.log(`  → ${edgar.tickers} tickers, ${edgar.totalFields} fields, ${edgar.rejected} rejected`);

  console.log("Populating from finnhub_fundamentals …");
  const finnhub = await populateFromTable(finnhubRows as Row[], "finnhub", FINNHUB_FIELDS, "fetchedAt");
  console.log(`  → ${finnhub.tickers} tickers, ${finnhub.totalFields} fields, ${finnhub.rejected} rejected`);

  console.log("Populating from fmp_fundamentals …");
  const fmp = await populateFromTable(fmpRows as Row[], "fmp", FMP_FIELDS, "fetchedAt");
  console.log(`  → ${fmp.tickers} tickers, ${fmp.totalFields} fields, ${fmp.rejected} rejected`);

  const totalRejected = yahoo.rejected + edgar.rejected + finnhub.rejected + fmp.rejected;
  console.log("\nSummary:");
  console.log(`  yahoo:   ${yahoo.tickers} tickers, ${yahoo.totalFields} fields`);
  console.log(`  edgar:   ${edgar.tickers} tickers, ${edgar.totalFields} fields`);
  console.log(`  finnhub: ${finnhub.tickers} tickers, ${finnhub.totalFields} fields`);
  console.log(`  fmp:     ${fmp.tickers} tickers, ${fmp.totalFields} fields`);
  console.log(`  TOTAL:   ${yahoo.totalFields + edgar.totalFields + finnhub.totalFields + fmp.totalFields} rows written, ${totalRejected} rejected`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
