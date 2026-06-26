import YahooFinanceClass from "yahoo-finance2";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

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
  yahoo_annualFreeCashFlow?: number;
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
  logger.info({ ticker, symbol }, "yahoo: fetching fundamentals");

  let raw: Awaited<ReturnType<typeof yahooFinance.quoteSummary>>;
  try {
    raw = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "financialData",
        "defaultKeyStatistics",
        "incomeStatementHistory",
        "balanceSheetHistory",
        "cashflowStatementHistory",
      ],
    }, { validateResult: false });
  } catch (err: any) {
    logger.warn({ ticker, err: err.message }, "yahoo: quoteSummary failed");
    return {};
  }

  const fd  = (raw as any).financialData            ?? {};
  const ks  = (raw as any).defaultKeyStatistics      ?? {};
  const is0 = (raw as any).incomeStatementHistory?.incomeStatementHistory?.[0]  ?? {};
  const is1 = (raw as any).incomeStatementHistory?.incomeStatementHistory?.[1]  ?? {};
  const bs0 = (raw as any).balanceSheetHistory?.balanceSheetStatements?.[0]     ?? {};
  const cf0 = (raw as any).cashflowStatementHistory?.cashflowStatements?.[0]    ?? {};

  const opCF  = n(cf0.totalCashFromOperatingActivities);
  const capex = cf0.capitalExpenditures != null ? Math.abs(Number(cf0.capitalExpenditures)) : undefined;

  const rev0 = n(is0.totalRevenue);
  const rev1 = n(is1.totalRevenue);
  const revenueYoy = rev0 != null && rev1 != null && rev1 !== 0
    ? (rev0 - rev1) / Math.abs(rev1)
    : undefined;

  const ltd  = n(bs0.longTermDebt);
  const stlt = n(bs0.shortLongTermDebt);
  const annualDebt = ltd != null || stlt != null ? (ltd ?? 0) + (stlt ?? 0) : undefined;

  logger.info({ ticker }, "yahoo: parsed successfully");

  return {
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
    yahoo_targetMeanPrice:    n(fd.targetMeanPrice),
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
    yahoo_annualTotalRevenue: rev0,
    yahoo_annualGrossProfit:  n(is0.grossProfit),
    yahoo_annualEbit:         n(is0.ebit),
    yahoo_annualNetIncome:    n(is0.netIncome),
    yahoo_annualRevenueYoy:   revenueYoy,
    yahoo_annualCash:         n(bs0.cash),
    yahoo_annualTotalDebt:    annualDebt,
    yahoo_annualTotalEquity:  n(bs0.totalStockholderEquity),
    yahoo_annualOperatingCashFlow: opCF,
    yahoo_annualCapex:        capex,
    yahoo_annualFreeCashFlow: opCF != null && capex != null ? opCF + capex : undefined,
  };
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
