import { rowToFundInput } from "./fund-score-inputs.js";
import type { TickerFundamentalsRow } from "@workspace/db";

const FUND_COLS = [
  "peRatio", "pegRatio", "forwardPe", "evEbitda", "evRevenue", "priceToBook", "priceToSales",
  "dividendYield", "netIncome", "freeCashFlow", "totalRevenue", "ebitda", "ebit", "interestExpense",
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "revenueGrowthYoyPrior", "epsGrowth", "currentRatio", "debtToEquity",
  "totalDebt", "cashAndEquivalents", "quarterlyOperatingCashFlow", "sharesOutstanding",
  "totalStockholdersEquity", "grossProfit", "earningsPerShare",
] as const;

/** Field whose fund input changed most between two gold rows. */
export function attributeLargestGoldField(
  beforeTf: TickerFundamentalsRow,
  afterTf: TickerFundamentalsRow,
): string | null {
  const b = rowToFundInput(beforeTf, null, null);
  const a = rowToFundInput(afterTf, null, null);
  let bestField: string | null = null;
  let bestMag = 0;
  for (const key of FUND_COLS) {
    const bv = (b as unknown as Record<string, number | null>)[key];
    const av = (a as unknown as Record<string, number | null>)[key];
    if (bv == null && av == null) continue;
    if (bv != null && av != null && Math.abs(av - bv) < 1e-9) continue;
    const mag = Math.abs((av ?? 0) - (bv ?? 0)) / Math.max(Math.abs(bv ?? av ?? 1), 1e-9);
    if (mag > bestMag) {
      bestMag = mag;
      bestField = key;
    }
  }
  return bestField;
}
