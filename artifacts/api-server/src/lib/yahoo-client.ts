import { logger } from "./logger.js";

// ── Yahoo Finance v7/v8 scrape endpoints ──────────────────────────────────────
// No API key required. Uses the same endpoints the Yahoo Finance web app uses.
// Modules fetched:
//   financialData          → margins, growth, cash, debt (TTM)
//   defaultKeyStatistics   → forward PE, EV ratios, PEG, P/B, shares
//   incomeStatementHistory → annual revenue, gross profit, EBIT, net income
//   balanceSheetHistory    → annual cash, debt, equity
//   cashflowStatementHistory → annual FCF, operating cash flow
//
// Rate limit: no hard limit, but max 3 concurrent (per data-architecture.md).
// All numeric fields stored in natural units:
//   margins/ratios: decimal (0.25 = 25%), NOT percent
//   large numbers: raw dollars (not millions)

const YAHOO_BASE = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";

const MODULES = [
  "financialData",
  "defaultKeyStatistics",
  "incomeStatementHistory",
  "balanceSheetHistory",
  "cashflowStatementHistory",
] as const;

// ── Raw Yahoo field interface ─────────────────────────────────────────────────
// Intentionally named after Yahoo's own field names, NOT ticker_fundamentals
// column names. This makes it easy to trace where each value came from.
// The validation script and future merge layer handle the mapping.

export interface YahooFundamentalsData {
  // ── financialData module ─────────────────────────────────────────────────────
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

  // ── defaultKeyStatistics module ───────────────────────────────────────────────
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

  // ── incomeStatementHistory module (most recent annual) ────────────────────────
  yahoo_annualTotalRevenue?: number;
  yahoo_annualGrossProfit?: number;
  yahoo_annualEbit?: number;
  yahoo_annualNetIncome?: number;
  yahoo_annualRevenueYoy?: number;

  // ── balanceSheetHistory module (most recent annual) ───────────────────────────
  yahoo_annualCash?: number;
  yahoo_annualTotalDebt?: number;
  yahoo_annualTotalEquity?: number;

  // ── cashflowStatementHistory module (most recent annual) ──────────────────────
  yahoo_annualOperatingCashFlow?: number;
  yahoo_annualCapex?: number;
  yahoo_annualFreeCashFlow?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function yN(field: unknown): number | undefined {
  if (field === null || field === undefined) return undefined;
  if (typeof field === "number") return isFinite(field) ? field : undefined;
  if (typeof field === "object") {
    const raw = (field as Record<string, unknown>).raw;
    if (raw === null || raw === undefined) return undefined;
    const n = Number(raw);
    return isFinite(n) ? n : undefined;
  }
  const n = Number(field);
  return isFinite(n) ? n : undefined;
}

// Yahoo debtToEquity is reported as a percentage (e.g. 726.1 = 7.261 ratio).
// Normalize to raw ratio to match every other source.
function yDebtToEquity(field: unknown): number | undefined {
  const v = yN(field);
  if (v === undefined) return undefined;
  return v > 20 ? v / 100 : v;
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 1500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay);
      delay *= 2;
      continue;
    }

    if (res.status === 429 || res.status === 401 || res.status === 403) {
      if (attempt === maxRetries)
        throw new Error(`Yahoo HTTP ${res.status} after ${maxRetries} retries`);
      logger.warn({ url, status: res.status, attempt }, "yahoo: rate limited or auth error, backing off");
      await sleep(delay);
      delay *= 2;
      continue;
    }

    if (!res.ok) {
      if (res.status === 404) {
        logger.warn({ url }, "yahoo: ticker not found (404)");
        return null;
      }
      if (attempt === maxRetries)
        throw new Error(`Yahoo HTTP ${res.status} for ${url}`);
      await sleep(delay);
      delay *= 2;
      continue;
    }

    return res.json();
  }
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchYahooFundamentals(
  ticker: string,
): Promise<YahooFundamentalsData> {
  const t = ticker.toUpperCase();
  const yahooSymbol = t.replace(".", "-");
  const modules = MODULES.join(",");
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=&formatted=true&lang=en-US&region=US`;

  logger.info({ ticker: t, yahooSymbol }, "yahoo: fetching fundamentals");

  const raw = await fetchWithRetry(url);

  if (!raw) {
    logger.warn({ ticker: t }, "yahoo: null response (ticker not found)");
    return {};
  }

  const result = raw?.quoteSummary?.result;
  if (!Array.isArray(result) || result.length === 0) {
    const errMsg = raw?.quoteSummary?.error?.description ?? "no result";
    logger.warn({ ticker: t, errMsg }, "yahoo: empty result");
    return {};
  }

  const data = result[0] as Record<string, any>;
  const fd  = data.financialData       ?? {};
  const ks  = data.defaultKeyStatistics ?? {};
  const is0 = data.incomeStatementHistory?.incomeStatementHistory?.[0]  ?? {};
  const is1 = data.incomeStatementHistory?.incomeStatementHistory?.[1]  ?? {};
  const bs0 = data.balanceSheetHistory?.balanceSheetStatements?.[0]     ?? {};
  const cf0 = data.cashflowStatementHistory?.cashflowStatements?.[0]    ?? {};

  logger.info({ ticker: t }, "yahoo: modules parsed successfully");

  const out: YahooFundamentalsData = {};

  // ── financialData ─────────────────────────────────────────────────────────
  out.yahoo_grossMargins       = yN(fd.grossMargins);
  out.yahoo_operatingMargins   = yN(fd.operatingMargins);
  out.yahoo_profitMargins      = yN(fd.profitMargins);
  out.yahoo_returnOnEquity     = yN(fd.returnOnEquity);
  out.yahoo_returnOnAssets     = yN(fd.returnOnAssets);
  out.yahoo_revenueGrowth      = yN(fd.revenueGrowth);
  out.yahoo_debtToEquity       = yDebtToEquity(fd.debtToEquity);
  out.yahoo_currentRatio       = yN(fd.currentRatio);
  out.yahoo_totalRevenue       = yN(fd.totalRevenue);
  out.yahoo_totalDebt          = yN(fd.totalDebt);
  out.yahoo_totalCash          = yN(fd.totalCash);
  out.yahoo_freeCashflow       = yN(fd.freeCashflow);
  out.yahoo_operatingCashflow  = yN(fd.operatingCashflow);
  out.yahoo_ebitda             = yN(fd.ebitda);
  out.yahoo_targetMeanPrice    = yN(fd.targetMeanPrice);

  // ── defaultKeyStatistics ─────────────────────────────────────────────────
  out.yahoo_forwardPE             = yN(ks.forwardPE);
  out.yahoo_pegRatio              = yN(ks.pegRatio);
  out.yahoo_priceToBook           = yN(ks.priceToBook);
  out.yahoo_enterpriseToEbitda    = yN(ks.enterpriseToEbitda);
  out.yahoo_enterpriseToRevenue   = yN(ks.enterpriseToRevenue);
  out.yahoo_trailingEps           = yN(ks.trailingEps);
  out.yahoo_forwardEps            = yN(ks.forwardEps);
  out.yahoo_beta                  = yN(ks.beta);
  out.yahoo_sharesOutstanding     = yN(ks.sharesOutstanding);
  out.yahoo_floatShares           = yN(ks.floatShares);
  out.yahoo_heldPercentInsiders   = yN(ks.heldPercentInsiders);
  out.yahoo_shortRatio            = yN(ks.shortRatio);

  // ── incomeStatementHistory (most recent annual) ───────────────────────────
  const annualRev0 = yN(is0.totalRevenue);
  const annualRev1 = yN(is1.totalRevenue);

  out.yahoo_annualTotalRevenue = annualRev0;
  out.yahoo_annualGrossProfit  = yN(is0.grossProfit);
  out.yahoo_annualEbit         = yN(is0.ebit);
  out.yahoo_annualNetIncome    = yN(is0.netIncome);

  if (annualRev0 !== undefined && annualRev1 !== undefined && annualRev1 !== 0) {
    out.yahoo_annualRevenueYoy = (annualRev0 - annualRev1) / Math.abs(annualRev1);
  }

  // ── balanceSheetHistory (most recent annual) ──────────────────────────────
  out.yahoo_annualCash = yN(bs0.cash);
  const ltd  = yN(bs0.longTermDebt);
  const stlt = yN(bs0.shortLongTermDebt);
  if (ltd !== undefined || stlt !== undefined) {
    out.yahoo_annualTotalDebt = (ltd ?? 0) + (stlt ?? 0);
  }
  out.yahoo_annualTotalEquity = yN(bs0.totalStockholderEquity);

  // ── cashflowStatementHistory (most recent annual) ─────────────────────────
  const opCF  = yN(cf0.totalCashFromOperatingActivities);
  const capex = yN(cf0.capitalExpenditures);

  out.yahoo_annualOperatingCashFlow = opCF;
  out.yahoo_annualCapex = capex !== undefined ? Math.abs(capex) : undefined;
  if (opCF !== undefined && capex !== undefined) {
    out.yahoo_annualFreeCashFlow = opCF + capex;
  }

  return out;
}

// ── Self-test block ───────────────────────────────────────────────────────────
// Run directly: npx tsx artifacts/api-server/src/lib/yahoo-client.ts NVDA
if (
  process.argv[1]?.endsWith("yahoo-client.ts") ||
  process.argv[1]?.endsWith("yahoo-client.js")
) {
  const ticker = process.argv[2] ?? "NVDA";
  console.log(`\nFetching Yahoo fundamentals for: ${ticker}\n`);
  fetchYahooFundamentals(ticker)
    .then(data => {
      const filled = Object.entries(data).filter(([, v]) => v !== undefined);
      console.log(`Fields populated: ${filled.length} / ${Object.keys(data).length + filled.length}`);
      console.log(JSON.stringify(data, null, 2));
    })
    .catch(err => {
      console.error("Yahoo fetch failed:", err.message);
      process.exit(1);
    });
}
