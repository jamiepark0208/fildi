/**
 * One-time script: copy ticker_fundamentals → fmp/polygon/av staging tables.
 *
 * Routing logic:
 *   lastSource contains "fmp"           → fmp_fundamentals
 *   lastSource contains "polygon"       → polygon_fundamentals
 *   lastSource contains "alpha_vantage" → av_fundamentals
 *   null or unrecognized                → fmp_fundamentals (original source)
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/snapshot-to-staging.ts
 */

import { sql } from "drizzle-orm";
import {
  db,
  tickerFundamentals,
  fmpFundamentals,
  polygonFundamentals,
  avFundamentals,
} from "@workspace/db";

type TFRow = typeof tickerFundamentals.$inferSelect;

// ── Field maps ────────────────────────────────────────────────────────────────

type FmpInsert = typeof fmpFundamentals.$inferInsert;
type PolyInsert = typeof polygonFundamentals.$inferInsert;
type AvInsert = typeof avFundamentals.$inferInsert;

function toFmp(row: TFRow): FmpInsert {
  return {
    ticker:                       row.ticker,
    fetchedAt:                    row.fundamentalsLastFetched ?? new Date(),
    fmpPeRatio:                   row.peRatio,
    fmpPegRatio:                  row.pegRatio,
    fmpForwardPe:                 row.forwardPe,
    fmpEvEbitda:                  row.evEbitda,
    fmpEvRevenue:                 row.evRevenue,
    fmpPriceToBook:               row.priceToBook,
    fmpPriceToSales:              row.priceToSales,
    fmpAnalystTargetPrice:        row.analystTargetPrice,
    fmpRevenueGrowthYoY:          row.revenueGrowthYoY,
    fmpRevenueGrowthYoyPrior:     row.revenueGrowthYoyPrior,
    fmpEpsGrowth:                 row.epsGrowth,
    fmpEarningsPerShare:          row.earningsPerShare,
    fmpGrossMargin:               row.grossMargin,
    fmpOperatingMargin:           row.operatingMargin,
    fmpNetMargin:                 row.netMargin,
    fmpReturnOnEquity:            row.returnOnEquity,
    fmpReturnOnAssets:            row.returnOnAssets,
    fmpEffectiveTaxRate:          row.effectiveTaxRate,
    fmpTotalRevenue:              row.totalRevenue,
    fmpNetIncome:                 row.netIncome,
    fmpEbitda:                    row.ebitda,
    fmpEbit:                      row.ebit,
    fmpInterestExpense:           row.interestExpense,
    fmpFreeCashFlow:              row.freeCashFlow,
    fmpCurrentRatio:              row.currentRatio,
    fmpDebtToEquity:              row.debtToEquity,
    fmpTotalDebt:                 row.totalDebt,
    fmpTotalStockholdersEquity:   row.totalStockholdersEquity,
    fmpCashAndEquivalents:        row.cashAndEquivalents,
    fmpWacc:                      row.wacc,
    fmpRoic:                      row.roic,
    fmpQuarterlyOperatingCashFlow: row.quarterlyOperatingCashFlow,
    fmpSharesOutstanding:         row.sharesOutstanding,
    fmpSharesOutstandingPrior:    row.sharesOutstandingPrior,
    fmpDividendYield:             row.dividendYield,
    fmpBeta:                      row.beta,
  };
}

function toPoly(row: TFRow): PolyInsert {
  return {
    ticker:                          row.ticker,
    fetchedAt:                       row.fundamentalsLastFetched ?? new Date(),
    polygonTotalRevenue:             row.totalRevenue,
    polygonNetIncome:                row.netIncome,
    polygonInterestExpense:          row.interestExpense,
    polygonGrossMargin:              row.grossMargin,
    polygonOperatingMargin:          row.operatingMargin,
    polygonTotalDebt:                row.totalDebt,
    polygonTotalStockholdersEquity:  row.totalStockholdersEquity,
    polygonQuarterlyOperatingCashFlow: row.quarterlyOperatingCashFlow,
  };
}

function toAv(row: TFRow): AvInsert {
  return {
    ticker:               row.ticker,
    fetchedAt:            row.fundamentalsLastFetched ?? new Date(),
    avPeRatio:            row.peRatio,
    avPegRatio:           row.pegRatio,
    avForwardPe:          row.forwardPe,
    avPbRatio:            row.priceToBook,
    avDividendYield:      row.dividendYield,
    avAnalystTargetPrice: row.analystTargetPrice,
    avNetMargin:          row.netMargin,
    avOperatingMargin:    row.operatingMargin,
    avReturnOnEquity:     row.returnOnEquity,
    avTotalRevenue:       row.totalRevenue,
    avEbitda:             row.ebitda,
    avBeta:               row.beta,
  };
}

function countNonNull(obj: Record<string, unknown>): number {
  return Object.values(obj).filter(
    (v) => v !== null && v !== undefined && v !== "ticker" && v !== "fetchedAt"
  ).length;
}

function countNonNullData(obj: Record<string, unknown>): number {
  return Object.entries(obj).filter(
    ([k, v]) => k !== "ticker" && k !== "fetchedAt" && v !== null && v !== undefined
  ).length;
}

function hasAnyData(row: TFRow): boolean {
  const dataKeys: (keyof TFRow)[] = [
    "peRatio", "pegRatio", "priceToBook", "priceToSales", "debtToEquity",
    "totalRevenue", "revenueGrowthYoY", "netIncome", "ebitda", "earningsPerShare",
    "epsGrowth", "freeCashFlow", "dividendYield", "returnOnEquity", "returnOnAssets",
    "currentRatio", "grossMargin", "operatingMargin", "netMargin", "beta",
    "analystTargetPrice", "wacc", "roic", "interestExpense", "totalDebt",
    "totalStockholdersEquity", "ebit", "effectiveTaxRate", "cashAndEquivalents",
    "quarterlyOperatingCashFlow", "sharesOutstanding", "sharesOutstandingPrior",
    "forwardPe", "evEbitda", "evRevenue", "revenueGrowthYoyPrior",
  ];
  return dataKeys.some((k) => row[k] !== null && row[k] !== undefined);
}

function resolveSource(lastSource: string | null): "fmp" | "polygon" | "alpha_vantage" {
  if (!lastSource) return "fmp";
  if (lastSource.includes("polygon")) return "polygon";
  if (lastSource.includes("alpha_vantage")) return "alpha_vantage";
  return "fmp";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Reading ticker_fundamentals …");
  const rows = await db.select().from(tickerFundamentals);
  console.log(`  ${rows.length} rows fetched\n`);

  const stats = {
    fmp:           { tickers: 0, fields: 0 },
    polygon:       { tickers: 0, fields: 0 },
    alpha_vantage: { tickers: 0, fields: 0 },
    skipped:       0,
  };

  for (const row of rows) {
    if (!hasAnyData(row)) {
      console.log(`[${row.ticker}] SKIP — all null`);
      stats.skipped++;
      continue;
    }

    const src = resolveSource(row.lastSource);

    if (src === "polygon") {
      const data = toPoly(row);
      const fieldCount = countNonNullData(data as Record<string, unknown>);
      await db
        .insert(polygonFundamentals)
        .values(data)
        .onConflictDoUpdate({
          target: polygonFundamentals.ticker,
          set: {
            fetchedAt:                         data.fetchedAt,
            polygonTotalRevenue:               data.polygonTotalRevenue,
            polygonNetIncome:                  data.polygonNetIncome,
            polygonInterestExpense:            data.polygonInterestExpense,
            polygonGrossMargin:                data.polygonGrossMargin,
            polygonOperatingMargin:            data.polygonOperatingMargin,
            polygonTotalDebt:                  data.polygonTotalDebt,
            polygonTotalStockholdersEquity:    data.polygonTotalStockholdersEquity,
            polygonQuarterlyOperatingCashFlow: data.polygonQuarterlyOperatingCashFlow,
          },
        });
      console.log(`[${row.ticker}] polygon ← ${fieldCount} fields`);
      stats.polygon.tickers++;
      stats.polygon.fields += fieldCount;

    } else if (src === "alpha_vantage") {
      const data = toAv(row);
      const fieldCount = countNonNullData(data as Record<string, unknown>);
      await db
        .insert(avFundamentals)
        .values(data)
        .onConflictDoUpdate({
          target: avFundamentals.ticker,
          set: {
            fetchedAt:            data.fetchedAt,
            avPeRatio:            data.avPeRatio,
            avPegRatio:           data.avPegRatio,
            avForwardPe:          data.avForwardPe,
            avPbRatio:            data.avPbRatio,
            avDividendYield:      data.avDividendYield,
            avAnalystTargetPrice: data.avAnalystTargetPrice,
            avNetMargin:          data.avNetMargin,
            avOperatingMargin:    data.avOperatingMargin,
            avReturnOnEquity:     data.avReturnOnEquity,
            avTotalRevenue:       data.avTotalRevenue,
            avEbitda:             data.avEbitda,
            avBeta:               data.avBeta,
          },
        });
      console.log(`[${row.ticker}] alpha_vantage ← ${fieldCount} fields`);
      stats.alpha_vantage.tickers++;
      stats.alpha_vantage.fields += fieldCount;

    } else {
      const data = toFmp(row);
      const fieldCount = countNonNullData(data as Record<string, unknown>);
      await db
        .insert(fmpFundamentals)
        .values(data)
        .onConflictDoUpdate({
          target: fmpFundamentals.ticker,
          set: {
            fetchedAt:                        data.fetchedAt,
            fmpPeRatio:                       data.fmpPeRatio,
            fmpPegRatio:                      data.fmpPegRatio,
            fmpForwardPe:                     data.fmpForwardPe,
            fmpEvEbitda:                      data.fmpEvEbitda,
            fmpEvRevenue:                     data.fmpEvRevenue,
            fmpPriceToBook:                   data.fmpPriceToBook,
            fmpPriceToSales:                  data.fmpPriceToSales,
            fmpAnalystTargetPrice:            data.fmpAnalystTargetPrice,
            fmpRevenueGrowthYoY:              data.fmpRevenueGrowthYoY,
            fmpRevenueGrowthYoyPrior:         data.fmpRevenueGrowthYoyPrior,
            fmpEpsGrowth:                     data.fmpEpsGrowth,
            fmpEarningsPerShare:              data.fmpEarningsPerShare,
            fmpGrossMargin:                   data.fmpGrossMargin,
            fmpOperatingMargin:               data.fmpOperatingMargin,
            fmpNetMargin:                     data.fmpNetMargin,
            fmpReturnOnEquity:                data.fmpReturnOnEquity,
            fmpReturnOnAssets:                data.fmpReturnOnAssets,
            fmpEffectiveTaxRate:              data.fmpEffectiveTaxRate,
            fmpTotalRevenue:                  data.fmpTotalRevenue,
            fmpNetIncome:                     data.fmpNetIncome,
            fmpEbitda:                        data.fmpEbitda,
            fmpEbit:                          data.fmpEbit,
            fmpInterestExpense:               data.fmpInterestExpense,
            fmpFreeCashFlow:                  data.fmpFreeCashFlow,
            fmpCurrentRatio:                  data.fmpCurrentRatio,
            fmpDebtToEquity:                  data.fmpDebtToEquity,
            fmpTotalDebt:                     data.fmpTotalDebt,
            fmpTotalStockholdersEquity:       data.fmpTotalStockholdersEquity,
            fmpCashAndEquivalents:            data.fmpCashAndEquivalents,
            fmpWacc:                          data.fmpWacc,
            fmpRoic:                          data.fmpRoic,
            fmpQuarterlyOperatingCashFlow:    data.fmpQuarterlyOperatingCashFlow,
            fmpSharesOutstanding:             data.fmpSharesOutstanding,
            fmpSharesOutstandingPrior:        data.fmpSharesOutstandingPrior,
            fmpDividendYield:                 data.fmpDividendYield,
            fmpBeta:                          data.fmpBeta,
          },
        });
      console.log(`[${row.ticker}] fmp ← ${fieldCount} fields`);
      stats.fmp.tickers++;
      stats.fmp.fields += fieldCount;
    }
  }

  console.log("\nSummary:");
  console.log(`  fmp_fundamentals:     ${stats.fmp.tickers} tickers, ${stats.fmp.fields} fields`);
  console.log(`  polygon_fundamentals: ${stats.polygon.tickers} tickers, ${stats.polygon.fields} fields`);
  console.log(`  av_fundamentals:      ${stats.alpha_vantage.tickers} tickers, ${stats.alpha_vantage.fields} fields`);
  console.log(`  Skipped (all null):   ${stats.skipped} tickers`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
