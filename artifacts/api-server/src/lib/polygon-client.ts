import { logApiCall } from "./api-logger.js";

// Normalized output from Polygon /vX/reference/financials (deprecated — A84).
// Fields match ticker_fundamentals column names per data-agent.md mappings.
export interface PolygonFundamentalsData {
  totalRevenue?: number;
  grossMargin?: number;
  netIncome?: number;
  operatingMargin?: number;
  interestExpense?: number;
  totalDebt?: number;
  totalStockholdersEquity?: number;
  quarterlyOperatingCashFlow?: number;
}

/**
 * A84: Polygon deprecated `/vX/reference/financials` (status GONE).
 * No network call — fundamentals waterfall no longer uses this source.
 */
export async function fetchPolygonFundamentals(
  ticker: string,
  _apiKey: string,
): Promise<PolygonFundamentalsData> {
  const t = ticker.toUpperCase();
  logApiCall({
    source: "polygon",
    fn: "fetchPolygonFundamentals",
    trigger: "disabled-a84",
    ticker: t,
    outcome: "failure",
    error: "endpoint GONE — fundamentals waterfall no longer uses Polygon",
    requestedFields: "vX/reference/financials",
  });
  return {};
}
