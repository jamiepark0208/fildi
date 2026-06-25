import { logger } from "./logger.js";

const FMP_BASE = "https://financialmodelingprep.com/stable";

// Parsed, normalized output from all FMP endpoints for a single ticker.
// All number fields are in natural decimal units (margins as 0.25, not 25%).
// debtToEquity is the raw ratio (not ×100 like Yahoo returns).
// interestExpense is always positive (Math.abs applied).
export interface FMPFundamentalsData {
  // VALUE
  peRatio?: number;
  pegRatio?: number;
  forwardPe?: number;
  evEbitda?: number;
  evRevenue?: number;
  priceToBook?: number;
  priceToSales?: number;
  debtToEquity?: number;
  dividendYield?: number;
  analystTargetPrice?: number;
  // GROWTH
  revenueGrowthYoY?: number;
  revenueGrowthYoyPrior?: number;
  epsGrowth?: number;
  earningsPerShare?: number;
  // QUALITY
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  effectiveTaxRate?: number;
  // INCOME STATEMENT raw ($)
  totalRevenue?: number;
  netIncome?: number;
  ebitda?: number;
  freeCashFlow?: number;
  ebit?: number;
  interestExpense?: number;
  // SAFETY
  currentRatio?: number;
  wacc?: number;
  roic?: number;
  totalDebt?: number;
  totalStockholdersEquity?: number;
  cashAndEquivalents?: number;
  quarterlyOperatingCashFlow?: number;
  sharesOutstanding?: number;
  sharesOutstandingPrior?: number;
  beta?: number;
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`FMP rate limit exceeded after ${maxRetries} retries`);
      logger.warn({ url, attempt }, "fmp: rate limited, backing off");
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`FMP HTTP ${res.status} for ${url}`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fmpN(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

function firstOf(arr: unknown): Record<string, unknown> {
  return (Array.isArray(arr) && arr.length > 0 ? arr[0] : {}) as Record<string, unknown>;
}

function secondOf(arr: unknown): Record<string, unknown> {
  return (Array.isArray(arr) && arr.length > 1 ? arr[1] : {}) as Record<string, unknown>;
}

// Fetches the 5 annual FMP endpoints in parallel + the quarterly cash-flow endpoint.
// Returns undefined for any field where FMP returned null/missing.
// Never throws on individual field absence — only throws on network failure after retries.
export async function fetchFMPFundamentals(
  ticker: string,
  apiKey: string,
): Promise<FMPFundamentalsData> {
  const t = ticker.toUpperCase();
  const q = `symbol=${t}&apikey=${apiKey}`;

  // 9 endpoints × 31 tickers = ~279 requests per full refresh.
  // beta is NOT fetched from FMP — stable/profile is heavily rate-limited. Yahoo beta
  // (quote.beta in buildMetrics) is the reliable source and is used for approxWACC.
  const [kmRaw, ratiosRaw, incomeRaw, balanceRaw, targetRaw, cfQtrRaw, growthRaw, waccRaw, cfAnnualRaw] =
    await Promise.all([
      fetchWithRetry(`${FMP_BASE}/key-metrics?${q}&limit=1`),
      fetchWithRetry(`${FMP_BASE}/ratios?${q}&limit=1`),
      fetchWithRetry(`${FMP_BASE}/income-statement?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/balance-sheet-statement?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/price-target-consensus?${q}`).catch(() => null),
      fetchWithRetry(`${FMP_BASE}/cash-flow-statement?${q}&period=quarter&limit=2`),
      fetchWithRetry(`${FMP_BASE}/financial-growth?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/wacc?${q}&limit=1`).catch(() => null),
      fetchWithRetry(`${FMP_BASE}/cash-flow-statement?${q}&limit=1`),
    ]);

  const km      = firstOf(kmRaw);
  const r       = firstOf(ratiosRaw);
  const waccRow = firstOf(waccRaw);
  const is0     = firstOf(incomeRaw);
  const is1     = secondOf(incomeRaw);
  const bs      = firstOf(balanceRaw);
  const cfAnn   = firstOf(cfAnnualRaw); // annual cash-flow — source for freeCashFlow
  // price-target-consensus may return object directly or array
  const tgt    = (targetRaw && !Array.isArray(targetRaw)) ? targetRaw as Record<string, unknown>
                  : firstOf(targetRaw);
  const cfQ    = firstOf(cfQtrRaw);
  const growth  = firstOf(growthRaw);
  const growth1 = secondOf(growthRaw); // prior-year period — for revenue acceleration

  // Log warnings for key scoring fields that came back null from FMP
  const criticalFields = ["returnOnInvestedCapital", "revenue", "netIncome", "grossProfitMargin"];
  for (const field of criticalFields) {
    const val = km[field] ?? r[field] ?? is0[field];
    if (val === null || val === undefined) {
      logger.warn({ ticker: t, field }, "fmp: critical field missing");
    }
  }

  const result: FMPFundamentalsData = {};

  // ── VALUE ────────────────────────────────────────────────────────────────────
  // P/E: stable ratios field is priceToEarningsRatio (was priceEarningsRatio in v3)
  result.peRatio        = fmpN(r.priceToEarningsRatio);
  // PEG: stable field is priceToEarningsGrowthRatio
  result.pegRatio       = fmpN(r.priceToEarningsGrowthRatio);
  // Forward P/E and EV multiples — key-metrics endpoint
  result.forwardPe      = fmpN(km.forwardPE);
  result.evEbitda       = fmpN(km.enterpriseValueOverEBITDA);
  result.evRevenue      = fmpN(km.evToRevenue);
  // P/B, P/S: field names unchanged
  result.priceToBook    = fmpN(r.priceToBookRatio);
  result.priceToSales   = fmpN(r.priceToSalesRatio);
  // D/E: stable ratios field is debtToEquityRatio (was debtEquityRatio in v3)
  result.debtToEquity   = fmpN(r.debtToEquityRatio);
  result.dividendYield  = fmpN(r.dividendYield);
  result.analystTargetPrice = fmpN(tgt.targetConsensus);

  // ── GROWTH — stable financial-growth endpoint (not in ratios) ────────────────
  result.revenueGrowthYoY      = fmpN(growth.revenueGrowth);
  result.revenueGrowthYoyPrior = fmpN(growth1.revenueGrowth);
  // stable uses lowercase 'epsgrowth'
  result.epsGrowth        = fmpN(growth.epsgrowth);
  result.earningsPerShare = fmpN(is0.eps);

  // ── QUALITY (margins as decimals) ────────────────────────────────────────────
  result.grossMargin     = fmpN(r.grossProfitMargin);
  result.operatingMargin = fmpN(r.operatingProfitMargin);
  result.netMargin       = fmpN(r.netProfitMargin);
  result.returnOnEquity  = fmpN(r.returnOnEquity)  ?? fmpN(km.returnOnEquity);
  result.returnOnAssets  = fmpN(r.returnOnAssets);
  result.effectiveTaxRate = fmpN(r.effectiveTaxRate);
  // beta: not fetched from FMP stable (profile endpoint is rate-limited at 31-ticker scale)
  // buildMetrics falls back to Yahoo quote.beta which is reliable for all watchlist tickers.

  // ── INCOME STATEMENT raw $ ───────────────────────────────────────────────────
  result.totalRevenue    = fmpN(is0.revenue);
  result.netIncome       = fmpN(is0.netIncome);
  result.ebitda          = fmpN(is0.ebitda);
  result.ebit            = fmpN(is0.ebit)          ?? fmpN(is0.operatingIncome); // ebit proxy
  // interestExpense — always store as positive (expense amount)
  const rawInterest = fmpN(is0.interestExpense);
  result.interestExpense = rawInterest !== undefined ? Math.abs(rawInterest) : undefined;
  result.sharesOutstanding      = fmpN(is0.weightedAverageShsOut);
  result.sharesOutstandingPrior = fmpN(is1.weightedAverageShsOut);

  // ── SAFETY ───────────────────────────────────────────────────────────────────
  result.currentRatio            = fmpN(r.currentRatio)  ?? fmpN(km.currentRatio);
  result.wacc                    = fmpN(waccRow.wacc);
  result.roic                    = fmpN(km.returnOnInvestedCapital);
  result.totalDebt               = fmpN(bs.totalDebt);
  result.totalStockholdersEquity = fmpN(bs.totalStockholdersEquity);
  result.cashAndEquivalents      = fmpN(bs.cashAndCashEquivalents);
  // quarterly OCF: positive = generating cash, negative = burning cash
  result.quarterlyOperatingCashFlow = fmpN(cfQ.operatingCashFlow);

  // Annual FCF: from annual cash-flow-statement (cfAnn). FMP field is freeCashFlow.
  result.freeCashFlow = fmpN(cfAnn.freeCashFlow);

  return result;
}
