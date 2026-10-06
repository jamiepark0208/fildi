import YahooFinanceClass from "yahoo-finance2";
import { logger } from "./logger.js";
import { logApiCall } from "./api-logger.js";

// The ONE Yahoo client for the server: each instance carries its own cookie/crumb
// handshake and request queue, so per-module instances multiplied crumb fetches and
// effective concurrency against Yahoo. Import this instead of constructing a new one.
export const yahooFinance = new YahooFinanceClass();

export interface YahooFundamentalsData {
  yahoo_grossMargins?: number;
  yahoo_operatingMargins?: number;
  yahoo_profitMargins?: number;
  yahoo_returnOnEquity?: number;
  yahoo_returnOnAssets?: number;
  yahoo_revenueGrowth?: number;
  yahoo_debtToEquity?: number;
  yahoo_currentRatio?: number;
  yahoo_totalRevenue?: number;
  yahoo_totalDebt?: number;
  yahoo_totalCash?: number;
  yahoo_freeCashflow?: number;
  yahoo_operatingCashflow?: number;
  yahoo_ebitda?: number;
  yahoo_targetMeanPrice?: number;
  yahoo_forwardPE?: number;
  yahoo_pegRatio?: number;
  yahoo_priceToBook?: number;
  yahoo_enterpriseToEbitda?: number;
  yahoo_enterpriseToRevenue?: number;
  yahoo_trailingEps?: number;
  yahoo_forwardEps?: number;
  yahoo_beta?: number;
  yahoo_sharesOutstanding?: number;
  yahoo_floatShares?: number;
  yahoo_heldPercentInsiders?: number;
  yahoo_shortRatio?: number;
  yahoo_annualTotalRevenue?: number;
  yahoo_annualGrossProfit?: number;
  yahoo_annualEbit?: number;
  yahoo_annualNetIncome?: number;
  yahoo_annualRevenueYoy?: number;
  yahoo_annualCash?: number;
  yahoo_annualTotalDebt?: number;
  yahoo_annualTotalEquity?: number;
  yahoo_annualOperatingCashFlow?: number;
  yahoo_annualCapex?: number;
  yahoo_trailingPE?: number;
  yahoo_annualFreeCashFlow?: number;
  yahoo_annualRevenueYoyPrior?: number;
  yahoo_epsGrowth?: number;
  yahoo_sharesOutstandingPrior?: number;
  yahoo_effectiveTaxRate?: number;
  yahoo_interestExpense?: number;
  yahoo_quarterlyOcf?: number;
  yahoo_roic?: number;
  yahoo_wacc?: number;
  yahoo_dividendYield?: number;
}

function n(v: unknown): number | undefined {
  if (v == null) return undefined;
  const num = Number(v);
  return isFinite(num) ? num : undefined;
}

// Yahoo D/E is ×100 (e.g. 726.1 means 7.261). Normalize to raw ratio.
function debtToEquity(v: unknown): number | undefined {
  const num = n(v);
  if (num === undefined) return undefined;
  return num > 20 ? num / 100 : num;
}

export async function fetchYahooFundamentals(ticker: string): Promise<YahooFundamentalsData> {
  const symbol = ticker.toUpperCase().replace(".", "-");

  let raw: Awaited<ReturnType<typeof yahooFinance.quoteSummary>>;
  try {
    raw = await yahooFinance.quoteSummary(symbol, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail"],
    }, { validateResult: false });
  } catch (err: any) {
    logApiCall({ source: "yahoo", fn: "fetchYahooFundamentals", trigger: "backfill-yahoo script", ticker, outcome: "failure", error: err.message, requestedFields: "quoteSummary: financialData, defaultKeyStatistics" });
    return {};
  }

  // fundamentalsTimeSeries annual — fetch 3 years to get 2 annual rows for YoY calc
  let ftsRows: any[] = [];
  try {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    ftsRows = (await (yahooFinance as any).fundamentalsTimeSeries(symbol, {
      period1: threeYearsAgo.toISOString().slice(0, 10),
      type: "annual",
      module: "all",
    }, { validateResult: false })) ?? [];
  } catch (err: any) {
    logApiCall({ source: "yahoo", fn: "fetchYahooFundamentals", trigger: "backfill-yahoo script", ticker, outcome: "failure", error: `fundamentalsTimeSeries annual non-fatal: ${err.message}`, requestedFields: "fundamentalsTimeSeries: annual" });
  }

  // fundamentalsTimeSeries quarterly — most recent quarter OCF
  let ftsQRows: any[] = [];
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    ftsQRows = (await (yahooFinance as any).fundamentalsTimeSeries(symbol, {
      period1: oneYearAgo.toISOString().slice(0, 10),
      type: "quarterly",
      module: "all",
    }, { validateResult: false })) ?? [];
  } catch (err: any) {
    logApiCall({ source: "yahoo", fn: "fetchYahooFundamentals", trigger: "backfill-yahoo script", ticker, outcome: "failure", error: `fundamentalsTimeSeries quarterly non-fatal: ${err.message}`, requestedFields: "fundamentalsTimeSeries: quarterly" });
  }

  // Results are oldest-first; most recent is last
  const fts0 = ftsRows.length > 0 ? ftsRows[ftsRows.length - 1] : {};
  const fts1 = ftsRows.length > 1 ? ftsRows[ftsRows.length - 2] : {};
  const fts2 = ftsRows.length > 2 ? ftsRows[ftsRows.length - 3] : {};

  const fd  = (raw as any).financialData        ?? {};
  const ks  = (raw as any).defaultKeyStatistics  ?? {};
  const sd  = (raw as any).summaryDetail         ?? {};

  const rev0 = n(fts0.totalRevenue);
  const rev1 = n(fts1.totalRevenue);
  const rev2 = n(fts2.totalRevenue);
  const revenueYoy = rev0 != null && rev1 != null && rev1 !== 0
    ? (rev0 - rev1) / Math.abs(rev1)
    : undefined;
  const revenueYoyPrior = rev1 != null && rev2 != null && rev2 !== 0
    ? (rev1 - rev2) / Math.abs(rev2)
    : undefined;

  const ni0 = n(fts0.netIncome);
  const ni1 = n(fts1.netIncome);
  const sh0 = n(fts0.basicAverageShares);
  const sh1 = n(fts1.basicAverageShares);
  const eps0 = ni0 != null && sh0 != null && sh0 !== 0 ? ni0 / sh0 : undefined;
  const eps1 = ni1 != null && sh1 != null && sh1 !== 0 ? ni1 / sh1 : undefined;
  const epsGrowth = eps0 != null && eps1 != null && eps1 !== 0
    ? (eps0 - eps1) / Math.abs(eps1)
    : undefined;

  const rawCapex = n(fts0.capitalExpenditure);
  const capex = rawCapex != null ? Math.abs(rawCapex) : undefined;
  const opCF  = n(fts0.operatingCashFlow);

  // Quarterly OCF — most recent quarter (rows oldest-first)
  const ftsQ0 = ftsQRows.length > 0 ? ftsQRows[ftsQRows.length - 1] : {};
  const quarterlyOcf = n(ftsQ0.operatingCashFlow);

  // ROIC = NOPAT / InvestedCapital
  const ebit      = n(fts0.EBIT);
  const taxRate   = n(fts0.taxRateForCalcs);
  const equity    = n(fts0.stockholdersEquity);
  const ltDebt    = n(fts0.longTermDebt)    ?? 0;
  const stDebt    = n(fts0.currentDebt)     ?? 0;
  const cash      = n(fts0.cashAndCashEquivalents) ?? 0;
  const totalDebt = ltDebt + stDebt;
  const nopat = ebit != null && taxRate != null ? ebit * (1 - taxRate) : undefined;
  const investedCapital = equity != null ? equity + totalDebt - cash : undefined;
  const roic = nopat != null && investedCapital != null && investedCapital !== 0
    ? nopat / investedCapital
    : undefined;

  // approxWACC — rf=4.5%, ERP=5.5% (Damodaran 2026); cost of debt from interestExpense/totalDebt
  const beta         = n(ks.beta);
  const currentPrice = n(fd.currentPrice);
  const shares       = n(ks.sharesOutstanding);
  const intExp       = n(fts0.interestExpense);
  const marketCap    = currentPrice != null && shares != null ? currentPrice * shares : undefined;
  const wacc = (() => {
    if (beta == null || marketCap == null || marketCap <= 0) return undefined;
    const ke = 0.045 + beta * 0.055;
    const enterpriseValue = marketCap + totalDebt - cash;
    if (enterpriseValue <= 0) return undefined;
    const we = marketCap / enterpriseValue;
    const wd = totalDebt / enterpriseValue;
    const kd = intExp != null && totalDebt > 0 && taxRate != null
      ? (intExp / totalDebt) * (1 - taxRate)
      : 0;
    return ke * we + kd * wd;
  })();

  const result = {
    yahoo_grossMargins:       n(fd.grossMargins),
    yahoo_operatingMargins:   n(fd.operatingMargins),
    yahoo_profitMargins:      n(fd.profitMargins),
    yahoo_returnOnEquity:     n(fd.returnOnEquity),
    yahoo_returnOnAssets:     n(fd.returnOnAssets),
    yahoo_revenueGrowth:      n(fd.revenueGrowth),
    yahoo_debtToEquity:       debtToEquity(fd.debtToEquity),
    yahoo_currentRatio:       n(fd.currentRatio),
    yahoo_totalRevenue:       n(fd.totalRevenue),
    yahoo_totalDebt:          n(fd.totalDebt),
    yahoo_totalCash:          n(fd.totalCash),
    yahoo_freeCashflow:       n(fd.freeCashflow),
    yahoo_operatingCashflow:  n(fd.operatingCashflow),
    yahoo_ebitda:             n(fd.ebitda),
    yahoo_dividendYield:      n(sd.dividendYield) ?? 0,
    yahoo_targetMeanPrice:    n(fd.targetMeanPrice),
    yahoo_trailingPE:         n(sd.trailingPE),
    yahoo_forwardPE:          n(ks.forwardPE),
    yahoo_pegRatio:           n(ks.pegRatio),
    yahoo_priceToBook:        n(ks.priceToBook),
    yahoo_enterpriseToEbitda: n(ks.enterpriseToEbitda),
    yahoo_enterpriseToRevenue:n(ks.enterpriseToRevenue),
    yahoo_trailingEps:        n(ks.trailingEps),
    yahoo_forwardEps:         n(ks.forwardEps),
    yahoo_beta:               n(ks.beta),
    yahoo_sharesOutstanding:  n(ks.sharesOutstanding),
    yahoo_floatShares:        n(ks.floatShares),
    yahoo_heldPercentInsiders:n(ks.heldPercentInsiders),
    yahoo_shortRatio:         n(ks.shortRatio),
    yahoo_annualTotalRevenue:      rev0,
    yahoo_annualGrossProfit:       n(fts0.grossProfit),
    yahoo_annualEbit:              n(fts0.EBIT),
    yahoo_annualNetIncome:         n(fts0.netIncome),
    yahoo_annualRevenueYoy:        revenueYoy,
    yahoo_annualRevenueYoyPrior:   revenueYoyPrior,
    yahoo_annualCash:              n(fts0.cashAndCashEquivalents),
    yahoo_annualTotalDebt:         n(fts0.longTermDebt),
    yahoo_annualTotalEquity:       n(fts0.stockholdersEquity),
    yahoo_annualOperatingCashFlow: opCF,
    yahoo_annualCapex:             capex,
    yahoo_annualFreeCashFlow:      n(fts0.freeCashFlow),
    yahoo_epsGrowth:               epsGrowth,
    yahoo_sharesOutstandingPrior:  sh1,
    yahoo_effectiveTaxRate:        n(fts0.taxRateForCalcs),
    yahoo_interestExpense:         n(fts0.interestExpense),
    yahoo_quarterlyOcf:            quarterlyOcf,
    yahoo_roic:                    roic,
    yahoo_wacc:                    wacc,
  };

  const fieldsReturned = Object.values(result).filter(v => v !== undefined).length;
  logApiCall({ source: "yahoo", fn: "fetchYahooFundamentals", trigger: "backfill-yahoo script", ticker, outcome: "success", fieldsReturned });
  return result;
}

// Run directly: node_modules/.bin/tsx artifacts/api-server/src/lib/yahoo-client.ts NVDA
if (process.argv[1]?.endsWith("yahoo-client.ts") || process.argv[1]?.endsWith("yahoo-client.js")) {
  const ticker = process.argv[2] ?? "NVDA";
  console.log(`\nFetching Yahoo fundamentals for: ${ticker}\n`);
  fetchYahooFundamentals(ticker).then(data => {
    const filled = Object.values(data).filter(v => v !== undefined).length;
    const total  = Object.keys(data).length;
    console.log(`Fields populated: ${filled} / ${total}`);
    console.log(JSON.stringify(data, null, 2));
  }).catch(err => { console.error(err.message); process.exit(1); });
}
