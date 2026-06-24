import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
const yahooFinance = new YahooFinanceClass();
import { eq } from "drizzle-orm";
import {
  CompareStocksQueryParams,
  SearchStocksQueryParams,
} from "@workspace/api-zod";
import {
  type TickerFundamentalsRow,
  db,
  indicatorCache,
} from "@workspace/db";
import { readFundamentalsRow } from "../lib/fundamentals-db.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { buildCatalysts, parseEarningsDate, yahooEpochToMs, yahooEpochToDateStr } from "../lib/catalysts.js";
import { resolvePeers, peersCache } from "../lib/peer-resolver.js";
import { logger } from "../lib/logger.js";

const router = Router();

export const searchCache = new TTLCache<object[]>(24 * 60 * 60 * 1000, 'search');
export const compareCache = new TTLCache<object>(60 * 60 * 1000, 'compare');

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined || typeof val === "object") return null;
  const n = Number(val);
  return isFinite(n) ? n : null;
}

function classifyStockType(
  peRatio: number | null,
  pegRatio: number | null,
  dividendYield: number | null,
  revenueGrowth: number | null
): string {
  if (dividendYield !== null && dividendYield > 0.03) return "Dividend";
  if (pegRatio !== null && pegRatio < 1.5 && (peRatio === null || peRatio < 20))
    return "Value";
  if (revenueGrowth !== null && revenueGrowth > 0.15) return "Growth";
  if (peRatio !== null && peRatio > 30) return "Growth";
  return "Blend";
}

function computeFairValue(
  eps: number | null,
  epsGrowth: number | null,
  peRatio: number | null
): number | null {
  if (eps === null || epsGrowth === null) return null;
  const growthPct = epsGrowth * 100;
  const fairPE = 2 * growthPct;
  if (fairPE <= 0) return null;
  return parseFloat((eps * fairPE).toFixed(2));
}

function scoreMetric(
  val1: number | null,
  val2: number | null,
  higherIsBetter: boolean
): [number, number] {
  if (val1 === null && val2 === null) return [0, 0];
  if (val1 === null) return [0, 1];
  if (val2 === null) return [1, 0];
  if (val1 === val2) return [0.5, 0.5];
  if (higherIsBetter) {
    return val1 > val2 ? [1, 0] : [0, 1];
  } else {
    return val1 < val2 ? [1, 0] : [0, 1];
  }
}

function fmtPct(val: number | null): string | null {
  if (val === null) return null;
  return `${(val * 100).toFixed(2)}%`;
}

function fmtNum(val: number | null, decimals = 2): string | null {
  if (val === null) return null;
  return val.toFixed(decimals);
}

function fmtLargeNum(val: number | null): string | null {
  if (val === null) return null;
  if (Math.abs(val) >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
  if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  return `$${val.toFixed(2)}`;
}

function fmtPrice(val: number | null): string | null {
  if (val === null) return null;
  return `$${val.toFixed(2)}`;
}

function buildScorecard(
  s1: ReturnType<typeof buildMetrics>,
  s2: ReturnType<typeof buildMetrics>,
  ticker1: string,
  ticker2: string
) {
  type ScorecardItem = {
    metric: string;
    weight: number;
    ticker1Score: number;
    ticker2Score: number;
    ticker1Value: string | null;
    ticker2Value: string | null;
    winner: string | null;
    explanation: string;
  };

  const items: ScorecardItem[] = [];

  function addItem(
    metric: string,
    weight: number,
    val1: number | null,
    val2: number | null,
    higherIsBetter: boolean,
    fmtFn: (v: number | null) => string | null,
    explanation: string
  ) {
    const [sc1, sc2] = scoreMetric(val1, val2, higherIsBetter);
    let winner: string | null = null;
    if (sc1 > sc2) winner = ticker1;
    else if (sc2 > sc1) winner = ticker2;
    items.push({
      metric,
      weight,
      ticker1Score: sc1,
      ticker2Score: sc2,
      ticker1Value: fmtFn(val1),
      ticker2Value: fmtFn(val2),
      winner,
      explanation,
    });
  }

  // ── Tier 1: Valuation (highest weight) ──────────────────────────────────
  // PEG is the gold standard: combines P/E with growth, penalising expensive growth
  addItem("PEG Ratio", 3.0, s1.pegRatio, s2.pegRatio, false, fmtNum,
    "The single best valuation shorthand. PEG < 1 = undervalued growth; > 2 = expensive. Invented by Peter Lynch.");

  // Price-to-FCF: harder to manipulate than earnings; Buffett's preferred metric
  const p2fcf1 = s1.marketCap !== null && s1.freeCashFlow !== null && s1.freeCashFlow > 0
    ? s1.marketCap / s1.freeCashFlow : null;
  const p2fcf2 = s2.marketCap !== null && s2.freeCashFlow !== null && s2.freeCashFlow > 0
    ? s2.marketCap / s2.freeCashFlow : null;
  addItem("Price / Free Cash Flow", 3.0, p2fcf1, p2fcf2, false, fmtNum,
    "How many dollars you pay per $1 of free cash flow. FCF is harder to manipulate than net income — pros treat this as the real earnings multiple.");

  // Analyst consensus upside: aggregated professional opinion on fair value
  const upside1 = s1.analystTargetPrice !== null && s1.currentPrice !== null
    ? (s1.analystTargetPrice / s1.currentPrice) - 1 : null;
  const upside2 = s2.analystTargetPrice !== null && s2.currentPrice !== null
    ? (s2.analystTargetPrice / s2.currentPrice) - 1 : null;
  addItem("Analyst Upside to Target", 2.5, upside1, upside2, true, fmtPct,
    "Wall Street consensus target price vs. today's price. Positive = analysts see upside; negative = stock is above consensus fair value.");

  // Trailing P/E: familiar benchmark, but penalise vs PEG for high-growth stocks
  addItem("P/E Ratio", 2.0, s1.peRatio, s2.peRatio, false, fmtNum,
    "Price-to-earnings: how much investors pay per $1 of trailing profit. Useful for stable earners; less meaningful for high-growth companies (use PEG instead).");

  // ── Tier 2: Growth quality ───────────────────────────────────────────────
  addItem("Revenue Growth (YoY)", 2.5, s1.revenueGrowthYoY, s2.revenueGrowthYoY, true, fmtPct,
    "Year-over-year revenue growth — the top-line engine. Sustained revenue growth above 20% is exceptional; below 5% for a growth stock is a red flag.");

  addItem("EPS Growth", 2.5, s1.epsGrowth, s2.epsGrowth, true, fmtPct,
    "Earnings-per-share growth (trailing vs. forward). The compounding driver of long-term stock price. Rising EPS with rising margins = quality growth.");

  // ── Tier 3: Profitability ────────────────────────────────────────────────
  addItem("Net Profit Margin", 2.0, s1.netMargin, s2.netMargin, true, fmtPct,
    "How many cents of every revenue dollar become profit. Buffett looks for durable margins >15%. Expanding margins over time = pricing power.");

  addItem("Return on Equity (ROE)", 2.0, s1.returnOnEquity, s2.returnOnEquity, true, fmtPct,
    "Profit generated per dollar of shareholder equity. ROE > 15% consistently signals a durable competitive advantage. Buffett's key quality screen.");

  addItem("Free Cash Flow", 2.0, s1.freeCashFlow, s2.freeCashFlow, true, fmtLargeNum,
    "Actual cash left after capital expenditures. The lifeblood of the business — funds buybacks, dividends, acquisitions, and R&D without diluting shareholders.");

  // ── Tier 4: Financial health ─────────────────────────────────────────────
  addItem("Gross Margin", 1.5, s1.grossMargin, s2.grossMargin, true, fmtPct,
    "Revenue minus direct costs. Software/platform companies typically run >60%; below 30% signals a commoditised business with little pricing power.");

  addItem("Debt-to-Equity", 1.5, s1.debtToEquity, s2.debtToEquity, false, fmtNum,
    "Total debt divided by shareholder equity. D/E < 0.5 is conservatively financed; > 2.0 warrants scrutiny. High leverage amplifies both gains and losses.");

  addItem("Current Ratio", 1.0, s1.currentRatio, s2.currentRatio, true, fmtNum,
    "Current assets ÷ current liabilities. > 1.5 is healthy; < 1.0 means the company cannot cover near-term obligations from existing assets alone.");

  const ticker1TotalScore = items.reduce((acc, it) => acc + it.ticker1Score * it.weight, 0);
  const ticker2TotalScore = items.reduce((acc, it) => acc + it.ticker2Score * it.weight, 0);
  const maxScore = items.reduce((acc, it) => acc + it.weight, 0);

  const winnerTicker = ticker1TotalScore >= ticker2TotalScore ? ticker1 : ticker2;
  const loserTicker = winnerTicker === ticker1 ? ticker2 : ticker1;
  const winnerName = winnerTicker === ticker1 ? s1.companyName : s2.companyName;
  const gap = Math.abs(ticker1TotalScore - ticker2TotalScore) / maxScore;
  const confidence = gap > 0.25 ? "High" : gap > 0.1 ? "Medium" : "Low";

  const winnerScore = Math.max(ticker1TotalScore, ticker2TotalScore);
  const loserScore = Math.min(ticker1TotalScore, ticker2TotalScore);

  const summary = `${winnerName} (${winnerTicker}) scores ${winnerScore.toFixed(1)} vs. ${loserScore.toFixed(1)} for ${loserTicker}, making it the stronger pick with ${confidence.toLowerCase()} conviction. ` +
    `${winnerTicker} shows advantages in ` +
    items.filter(i => i.winner === winnerTicker).slice(0, 3).map(i => i.metric).join(", ") + ".";

  return {
    ticker1TotalScore: parseFloat(ticker1TotalScore.toFixed(2)),
    ticker2TotalScore: parseFloat(ticker2TotalScore.toFixed(2)),
    winner: winnerName,
    winnerTicker,
    loserTicker,
    confidence,
    summary,
    items,
  };
}

// Convert a Drizzle numeric column value (stored as string) to number | null.
function fmpNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// Build StockMetrics from Yahoo quote data + optional FMP fundamentals DB row.
// FMP values take priority for all fundamental fields; Yahoo provides price/meta/fallback.
function buildMetrics(quote: any, fmp: TickerFundamentalsRow | null, ticker: string) {
  // ── Price & market data — always Yahoo ───────────────────────────────────────
  const currentPrice = safeNum(quote.regularMarketPrice);
  const marketCap    = safeNum(quote.marketCap);

  // ── Valuation ratios — FMP primary, Yahoo fallback ───────────────────────────
  const peRatio = fmpNum(fmp?.peRatio)
    ?? safeNum(quote.trailingPE)
    ?? safeNum(quote.forwardPE);

  const pegRatio = fmpNum(fmp?.pegRatio) ?? safeNum(quote.pegRatio);

  const priceToBook  = fmpNum(fmp?.priceToBook)  ?? safeNum(quote.priceToBook);
  const priceToSales = fmpNum(fmp?.priceToSales) ?? safeNum(quote.priceToSalesTrailing12Months);

  // D/E: FMP is raw ratio; Yahoo is ×100 (we divide only the Yahoo fallback).
  const debtToEquity = fmpNum(fmp?.debtToEquity)
    ?? (() => { const r = safeNum(quote.debtToEquity); return r !== null ? r / 100 : null; })();
  const leverageRatio = debtToEquity !== null ? debtToEquity + 1 : null;

  const dividendYield = fmpNum(fmp?.dividendYield) ?? safeNum(quote.dividendYield);

  const analystTargetPrice = fmpNum(fmp?.analystTargetPrice) ?? safeNum(quote.targetMeanPrice);

  // ── Growth — FMP primary, Yahoo fallback ─────────────────────────────────────
  const revenueGrowthYoY = fmpNum(fmp?.revenueGrowthYoY) ?? safeNum(quote.revenueGrowth);
  // revenueGrowthProjected has no FMP equivalent — Yahoo earningsGrowth is the proxy
  const revenueGrowthProjected = safeNum(quote.earningsGrowth);

  // EPS growth: prefer FMP; fall back to computed trailing→forward delta from Yahoo
  const epsGrowth = fmpNum(fmp?.epsGrowth) ?? (() => {
    const eps = safeNum(quote.trailingEps);
    const fwd = safeNum(quote.forwardEps);
    return eps !== null && fwd !== null && eps > 0 ? (fwd - eps) / Math.abs(eps) : null;
  })();

  const earningsPerShare = fmpNum(fmp?.earningsPerShare)
    ?? safeNum(quote.trailingEps);

  // ── Income statement — FMP primary, Yahoo fallback ───────────────────────────
  const totalRevenue = fmpNum(fmp?.totalRevenue) ?? safeNum(quote.totalRevenue);
  const netIncome    = fmpNum(fmp?.netIncome)    ?? safeNum(quote.netIncomeToCommon);
  const ebitda       = fmpNum(fmp?.ebitda)       ?? safeNum(quote.ebitda);
  // freeCashFlow: FMP doesn't fetch the annual cash-flow-statement, so Yahoo is primary here
  const freeCashFlow = safeNum(quote.freeCashflow) ?? fmpNum(fmp?.freeCashFlow);

  // ── Margins — FMP primary, Yahoo fallback ────────────────────────────────────
  const grossMargin     = fmpNum(fmp?.grossMargin)     ?? safeNum(quote.grossMargins);
  const operatingMargin = fmpNum(fmp?.operatingMargin) ?? safeNum(quote.operatingMargins);
  const netMargin       = fmpNum(fmp?.netMargin)       ?? safeNum(quote.profitMargins);
  const returnOnEquity  = fmpNum(fmp?.returnOnEquity)  ?? safeNum(quote.returnOnEquity);
  const returnOnAssets  = fmpNum(fmp?.returnOnAssets)  ?? safeNum(quote.returnOnAssets);
  const currentRatio    = fmpNum(fmp?.currentRatio)    ?? safeNum(quote.currentRatio);
  const beta            = fmpNum(fmp?.beta)            ?? safeNum(quote.beta);

  // ── Classification & fair value (computed locally) ───────────────────────────
  const stockType  = classifyStockType(peRatio, pegRatio, dividendYield, revenueGrowthYoY);
  const fairValue  = computeFairValue(earningsPerShare, epsGrowth, peRatio);

  // ── New Phase 3 Safety/Quality fields — FMP only ─────────────────────────────
  const wacc                    = fmpNum(fmp?.wacc);
  const roic                    = fmpNum(fmp?.roic);
  // NOTE: FMP income-statement reports net interest for companies where interest income
  // exceeds interest expense (e.g. Apple). In those cases interestExpense = 0, which causes
  // interestCoverage() to return MAX_INTEREST_COVERAGE (50) — directionally correct since
  // the company is net interest-positive, but not from a traditional debt-service perspective.
  const interestExpense         = fmpNum(fmp?.interestExpense);
  const totalDebt               = fmpNum(fmp?.totalDebt);
  const totalStockholdersEquity = fmpNum(fmp?.totalStockholdersEquity);
  const ebit                    = fmpNum(fmp?.ebit);
  const effectiveTaxRate        = fmpNum(fmp?.effectiveTaxRate);
  const cashAndEquivalents      = fmpNum(fmp?.cashAndEquivalents);
  const quarterlyOperatingCashFlow = fmpNum(fmp?.quarterlyOperatingCashFlow);
  const sharesOutstanding       = fmpNum(fmp?.sharesOutstanding);
  const sharesOutstandingPrior  = fmpNum(fmp?.sharesOutstandingPrior);

  const discrepancyFlags = fmp?.discrepancyFlags
    ? fmp.discrepancyFlags.split(",").filter(Boolean)
    : null;
  const fundamentalsLastFetched = fmp?.fundamentalsLastFetched
    ? fmp.fundamentalsLastFetched.toISOString()
    : null;

  return {
    ticker: ticker.toUpperCase(),
    companyName: quote.longName ?? quote.shortName ?? ticker.toUpperCase(),
    currentPrice,
    marketCap,
    peRatio,
    pegRatio,
    priceToBook,
    priceToSales,
    leverageRatio,
    debtToEquity,
    totalRevenue,
    revenueGrowthYoY,
    revenueGrowthProjected,
    netIncome,
    ebitda,
    earningsPerShare,
    epsGrowth,
    freeCashFlow,
    dividendYield,
    returnOnEquity,
    returnOnAssets,
    currentRatio,
    grossMargin,
    operatingMargin,
    netMargin,
    beta,
    fiftyTwoWeekHigh: safeNum(quote.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  safeNum(quote.fiftyTwoWeekLow),
    analystTargetPrice,
    fairValueEstimate: fairValue,
    stockType,
    sector:      quote.sector      ?? null,
    industry:    quote.industry    ?? null,
    exchange:    quote.exchangeName ?? quote.exchange ?? null,
    currency:    quote.currency    ?? "USD",
    logoUrl:     null,
    description: quote.longBusinessSummary?.slice(0, 500) ?? null,
    dayChange:        safeNum(quote.regularMarketChange),
    dayChangePercent: safeNum(quote.regularMarketChangePercent),
    // New FMP-sourced fields
    wacc,
    roic,
    interestExpense,
    totalDebt,
    totalStockholdersEquity,
    ebit,
    effectiveTaxRate,
    cashAndEquivalents,
    quarterlyOperatingCashFlow,
    sharesOutstanding,
    sharesOutstandingPrior,
    discrepancyFlags,
    fundamentalsLastFetched,
  };
}

router.get("/stocks/compare", async (req, res) => {
  const parsed = CompareStocksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ticker1 and ticker2 are required" });
  }
  const { ticker1, ticker2 } = parsed.data;
  const cacheKey = `${ticker1.toUpperCase()}:${ticker2.toUpperCase()}`;

  const cached = compareCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const t1 = ticker1.toUpperCase();
    const t2 = ticker2.toUpperCase();
    const [q1, q2, fmp1, fmp2] = await Promise.all([
      yahooFinance.quoteSummary(t1, {
        modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile"],
      }),
      yahooFinance.quoteSummary(t2, {
        modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile"],
      }),
      readFundamentalsRow(t1),
      readFundamentalsRow(t2),
    ]);

    const merged1 = { ...q1.price, ...q1.summaryDetail, ...q1.financialData, ...q1.defaultKeyStatistics, ...q1.assetProfile };
    const merged2 = { ...q2.price, ...q2.summaryDetail, ...q2.financialData, ...q2.defaultKeyStatistics, ...q2.assetProfile };

    const stock1 = buildMetrics(merged1, fmp1, t1);
    const stock2 = buildMetrics(merged2, fmp2, t2);
    const scorecard = buildScorecard(stock1, stock2, ticker1.toUpperCase(), ticker2.toUpperCase());

    const payload = { stock1, stock2, scorecard };
    compareCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("No fundamentals data") || msg.includes("Not Found")) {
      return res.status(404).json({ error: `Ticker not found: ${msg}` });
    }
    return res.status(500).json({ error: `Failed to fetch stock data: ${msg}` });
  }
});

router.get("/stocks/search", async (req, res) => {
  const parsed = SearchStocksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "q is required" });
  }
  const { q } = parsed.data;
  const cacheKey = q.toUpperCase();

  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const raw = await yahooFinance.search(q, { newsCount: 0, quotesCount: 8 }, { validateResult: false });
    const results = raw as { quotes?: unknown[] };
    const quotes = (results.quotes ?? [])
      .filter((r: any) => r.isYahooFinance && r.symbol)
      .slice(0, 8)
      .map((r: any) => ({
        ticker: r.symbol,
        name: r.longname ?? r.shortname ?? r.symbol,
        exchange: r.exchange ?? "",
        type: r.quoteType ?? "EQUITY",
      }));
    searchCache.set(cacheKey, quotes);
    return res.json(quotes);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export const historyCache = new TTLCache<object[]>(60 * 60 * 1000, 'history');
export const historyCache1D = new TTLCache<object[]>(15 * 60 * 1000, 'history-1d');

function getPeriod1(period: string): Date {
  const now = new Date();
  switch (period) {
    case "1D": return new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    case "1W": return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "1M": return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "3M": return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "1Y": return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    default:   return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

function getInterval(period: string): string {
  switch (period) {
    case "1D": return "5m";
    case "1W": return "1h";
    default:   return "1d";
  }
}

const VALID_PERIODS = new Set(["1D", "1W", "1M", "3M", "1Y"]);

router.get("/stocks/history", async (req, res) => {
  const { ticker, period } = req.query as { ticker?: string; period?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  if (!period || !VALID_PERIODS.has(period)) {
    return res.status(400).json({ error: "period must be one of: 1D, 1W, 1M, 3M, 1Y" });
  }
  const key = `${ticker.toUpperCase()}_${period}`;
  const cache = period === "1D" ? historyCache1D : historyCache;
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const result = await yahooFinance.chart(ticker.toUpperCase(), {
      period1: getPeriod1(period),
      interval: getInterval(period) as any,
    });
    const quotes = (result?.quotes ?? []).filter((q: any) => q.close != null);
    const data = quotes.map((q: any) => ({
      date: new Date(q.date).toISOString(),
      close: q.close,
      open: q.open ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      volume: q.volume ?? null,
    }));
    cache.set(key, data);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to fetch history: ${String(err?.message ?? err)}` });
  }
});

export const quoteCache = new TTLCache<object>(60 * 60 * 1000, 'quote');

async function fetchQuoteSummary(ticker: string) {
  return yahooFinance.quoteSummary(ticker.toUpperCase(), {
    modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile"],
  });
}

router.get("/stocks/quote", async (req, res) => {
  const { ticker } = req.query as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const key = ticker.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached) return res.json(cached);

  try {
    const [q, fmpRow] = await Promise.all([
      fetchQuoteSummary(key),
      readFundamentalsRow(key),
    ]);
    const merged = { ...q.price, ...q.summaryDetail, ...q.financialData, ...q.defaultKeyStatistics, ...q.assetProfile };
    const metrics = buildMetrics(merged, fmpRow, key);
    quoteCache.set(key, metrics);
    return res.json(metrics);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("No fundamentals data") || msg.includes("Not Found")) {
      return res.status(404).json({ error: `Ticker not found: ${key}` });
    }
    return res.status(500).json({ error: `Failed to fetch stock data: ${msg}` });
  }
});

function scoreValue(pe: number | null, peg: number | null, pb: number | null, ps: number | null): number {
  let sum = 0, n = 0;
  if (pe !== null) { sum += pe < 10 ? 5 : pe < 15 ? 4 : pe < 20 ? 3 : pe < 35 ? 2 : 1; n++; }
  if (peg !== null) { sum += peg < 0.5 ? 5 : peg < 1 ? 4 : peg < 1.5 ? 3 : peg < 2.5 ? 2 : 1; n++; }
  if (pb !== null) { sum += pb < 1 ? 5 : pb < 2 ? 4 : pb < 3 ? 3 : pb < 6 ? 2 : 1; n++; }
  if (ps !== null) { sum += ps < 1 ? 5 : ps < 3 ? 4 : ps < 6 ? 3 : ps < 12 ? 2 : 1; n++; }
  return n > 0 ? Math.round(sum / n) : 3;
}

function scoreGrowth(revGrowth: number | null, epsGrowth: number | null): number {
  let sum = 0, n = 0;
  if (revGrowth !== null) { sum += revGrowth > 0.3 ? 5 : revGrowth > 0.2 ? 4 : revGrowth > 0.1 ? 3 : revGrowth > 0.05 ? 2 : revGrowth > 0 ? 1 : 0; n++; }
  if (epsGrowth !== null) { sum += epsGrowth > 0.3 ? 5 : epsGrowth > 0.2 ? 4 : epsGrowth > 0.1 ? 3 : epsGrowth > 0.05 ? 2 : epsGrowth > 0 ? 1 : 0; n++; }
  return n > 0 ? Math.round(sum / n) : 2;
}

function scoreHealth(currentRatio: number | null, dte: number | null, netMargin: number | null): number {
  let sum = 0, n = 0;
  if (currentRatio !== null) { sum += currentRatio > 3 ? 5 : currentRatio > 2 ? 4 : currentRatio > 1.5 ? 3 : currentRatio > 1 ? 2 : 1; n++; }
  if (dte !== null) { sum += dte < 0.1 ? 5 : dte < 0.3 ? 4 : dte < 0.6 ? 3 : dte < 1.2 ? 2 : 1; n++; }
  if (netMargin !== null) { sum += netMargin > 0.25 ? 5 : netMargin > 0.15 ? 4 : netMargin > 0.08 ? 3 : netMargin > 0 ? 2 : 1; n++; }
  return n > 0 ? Math.round(sum / n) : 2;
}

function scorePast(roe: number | null, netMargin: number | null, fcf: number | null, marketCap: number | null): number {
  let sum = 0, n = 0;
  if (roe !== null) { sum += roe > 0.3 ? 5 : roe > 0.2 ? 4 : roe > 0.12 ? 3 : roe > 0.05 ? 2 : roe > 0 ? 1 : 0; n++; }
  if (netMargin !== null) { sum += netMargin > 0.25 ? 5 : netMargin > 0.15 ? 4 : netMargin > 0.08 ? 3 : netMargin > 0 ? 2 : 1; n++; }
  if (fcf !== null && marketCap !== null && marketCap > 0) {
    const y = fcf / marketCap;
    sum += y > 0.07 ? 5 : y > 0.04 ? 4 : y > 0.02 ? 3 : y > 0 ? 2 : 1; n++;
  }
  return n > 0 ? Math.round(sum / n) : 2;
}

function scoreDividend(yield_: number | null): number {
  if (!yield_ || yield_ <= 0) return 0;
  return yield_ > 0.06 ? 5 : yield_ > 0.04 ? 4 : yield_ > 0.025 ? 3 : yield_ > 0.01 ? 2 : 1;
}

function buildBullBullets(m: any): string[] {
  const out: string[] = [];
  if (m.revenueGrowthYoY != null && m.revenueGrowthYoY > 0.10)
    out.push(`Revenue growing ${(m.revenueGrowthYoY * 100).toFixed(0)}% YoY — above-average expansion`);
  if (m.epsGrowth != null && m.epsGrowth > 0.10)
    out.push(`EPS up ${(m.epsGrowth * 100).toFixed(0)}% — earnings momentum supports premium valuation`);
  if (m.netMargin != null && m.netMargin > 0.15)
    out.push(`${(m.netMargin * 100).toFixed(0)}% net margin signals durable pricing power`);
  if (m.returnOnEquity != null && m.returnOnEquity > 0.15)
    out.push(`ROE of ${(m.returnOnEquity * 100).toFixed(0)}% reflects efficient capital allocation`);
  if (m.freeCashFlow != null && m.freeCashFlow > 0)
    out.push("Positive free cash flow funds buybacks, dividends, or reinvestment without dilution");
  if (m.currentRatio != null && m.currentRatio > 1.5)
    out.push(`Current ratio ${m.currentRatio.toFixed(1)}x — near-term obligations comfortably covered`);
  if (m.analystTargetPrice != null && m.currentPrice != null && m.analystTargetPrice > m.currentPrice * 1.10)
    out.push(`Consensus target implies ${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(0)}%+ upside from current price`);
  return out.slice(0, 4);
}

function buildBearBullets(m: any): string[] {
  const out: string[] = [];
  if (m.debtToEquity != null && m.debtToEquity > 1.5)
    out.push(`D/E of ${m.debtToEquity.toFixed(1)}x — elevated leverage amplifies downside in a downturn`);
  if (m.peRatio != null && m.peRatio > 30)
    out.push(`P/E of ${m.peRatio.toFixed(0)}x prices in high growth; any miss could reprice sharply`);
  if (m.pegRatio != null && m.pegRatio > 2)
    out.push(`PEG of ${m.pegRatio.toFixed(1)}x suggests stock is running ahead of its growth rate`);
  if (m.revenueGrowthYoY != null && m.revenueGrowthYoY < 0.05)
    out.push(`Revenue growth of ${(m.revenueGrowthYoY * 100).toFixed(0)}% points to slowing demand`);
  if (m.netMargin != null && m.netMargin < 0.05 && m.netMargin >= 0)
    out.push(`${(m.netMargin * 100).toFixed(1)}% net margin leaves little buffer against cost pressure`);
  if (m.freeCashFlow != null && m.freeCashFlow < 0)
    out.push("Negative free cash flow requires external financing to sustain operations");
  if (m.currentRatio != null && m.currentRatio < 1.0)
    out.push(`Current ratio below 1x raises near-term liquidity concerns`);
  return out.slice(0, 4);
}

export const breakdownCache = new TTLCache<object>(2 * 60 * 60 * 1000, 'breakdown');

type BreakdownPayload = {
  metrics: unknown;
  recommendations: unknown;
  analystActions: Array<{ firm: string; toGrade: string; fromGrade: string; action: string; date: string | null }>;
  analystPriceTargets: unknown;
  priceTargetRange: unknown;
  bullBullets: string[];
  bearBullets: string[];
  news: Array<{ title: string; link?: string; publisher?: string; publishedAt: string | null }>;
  snowflake: unknown;
  earningsDate?: string | null;
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
};

function attachCatalysts(payload: BreakdownPayload): BreakdownPayload {
  payload.catalysts = buildCatalysts({
    earningsDate: payload.earningsDate ?? null,
    analystActions: payload.analystActions ?? [],
    news: payload.news ?? [],
  });
  return payload;
}

// Bump when breakdown payload shape or catalyst parsing changes (invalidates stale entries).
const BREAKDOWN_CACHE_VER = 4;

router.get("/stocks/breakdown", async (req, res) => {
  const { ticker } = req.query as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const upperTicker = ticker.toUpperCase();
  const key = `${upperTicker}:v${BREAKDOWN_CACHE_VER}`;
  const cached = breakdownCache.get(key) as BreakdownPayload | undefined;
  if (cached) {
    return res.json(attachCatalysts(cached));
  }

  try {
    const fmpApiKey = process.env.FMP_API_KEY ?? "";
    const [summary, newsRes, fmpRow, fmpTargetsRaw, earningsDbRows, peersPayload] = await Promise.all([
      yahooFinance.quoteSummary(upperTicker, {
        modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile", "recommendationTrend", "upgradeDowngradeHistory", "calendarEvents"] as any,
      }),
      yahooFinance.search(upperTicker, { newsCount: 6, quotesCount: 0 } as any, { validateResult: false }).catch(() => ({ news: [] })),
      readFundamentalsRow(upperTicker),
      fmpApiKey
        ? fetch(`https://financialmodelingprep.com/stable/price-target?symbol=${upperTicker}&apikey=${fmpApiKey}&limit=20`)
            .then(r => r.ok ? r.json() : [])
            .catch(() => [])
        : Promise.resolve([]),
      db.select({ earningsDate: indicatorCache.earningsDate })
        .from(indicatorCache)
        .where(eq(indicatorCache.ticker, upperTicker))
        .limit(1),
      resolvePeers(upperTicker).catch(err => {
        logger.warn({ ticker: upperTicker, err }, "resolvePeers in breakdown failed");
        return { ticker: upperTicker, sector: null, industry: null, peers: [] as string[] };
      }),
    ]);

    const merged = {
      ...summary.price,
      ...summary.summaryDetail,
      ...summary.financialData,
      ...summary.defaultKeyStatistics,
      ...summary.assetProfile,
    };
    const metrics = buildMetrics(merged, fmpRow, upperTicker);

    const recTrend = (summary as any).recommendationTrend?.trend?.[0];
    const recommendations = recTrend ? {
      strongBuy: recTrend.strongBuy ?? 0,
      buy: recTrend.buy ?? 0,
      hold: recTrend.hold ?? 0,
      sell: recTrend.sell ?? 0,
      strongSell: recTrend.strongSell ?? 0,
    } : null;

    // Per-firm analyst actions — most recent action per firm, sorted newest first
    const rawHistory: any[] = (summary as any).upgradeDowngradeHistory?.history ?? [];
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const firmMap = new Map<string, any>();
    for (const item of rawHistory) {
      const ts = yahooEpochToMs(item.epochGradeDate);
      if (!ts || ts < cutoff) continue;
      const firm = (item.firm ?? "Unknown") as string;
      if (!firmMap.has(firm)) firmMap.set(firm, item);
    }
    const analystActions = Array.from(firmMap.values())
      .sort((a, b) => yahooEpochToMs(b.epochGradeDate) - yahooEpochToMs(a.epochGradeDate))
      .slice(0, 10)
      .map(item => ({
        firm: item.firm ?? "Unknown",
        toGrade: item.toGrade ?? "",
        fromGrade: item.fromGrade ?? "",
        action: item.action ?? "maintain",
        date: yahooEpochToDateStr(item.epochGradeDate),
      }));

    // Aggregate price target range from financialData
    const fd = (summary as any).financialData ?? {};
    const priceTargetRange = {
      high:   safeNum(fd.targetHighPrice)   ?? null,
      low:    safeNum(fd.targetLowPrice)    ?? null,
      mean:   safeNum(fd.targetMeanPrice)   ?? null,
      median: safeNum(fd.targetMedianPrice) ?? null,
    };

    // Per-analyst price targets from FMP — deduplicate by firm, most recent first
    const rawTargets: any[] = Array.isArray(fmpTargetsRaw) ? fmpTargetsRaw : [];
    const targetFirmMap = new Map<string, any>();
    for (const t of rawTargets) {
      const firm = (t.analystCompany ?? t.newsPublisher ?? "Unknown") as string;
      if (!targetFirmMap.has(firm)) targetFirmMap.set(firm, t);
    }
    const analystPriceTargets = Array.from(targetFirmMap.values())
      .sort((a, b) => new Date(b.publishedDate ?? 0).getTime() - new Date(a.publishedDate ?? 0).getTime())
      .slice(0, 10)
      .map(t => ({
        firm: t.analystCompany ?? t.newsPublisher ?? "Unknown",
        analyst: t.analystName ?? null,
        priceTarget: typeof t.priceTarget === "number" ? t.priceTarget : null,
        date: t.publishedDate ?? null,
        priceWhenPosted: typeof t.priceWhenPosted === "number" ? t.priceWhenPosted : null,
        newsTitle: t.newsTitle ?? null,
      }));

    // Metric-driven bull/bear bullets
    const bullBullets = buildBullBullets(metrics);
    const bearBullets = buildBearBullets(metrics);

    const news = ((newsRes as any).news ?? []).slice(0, 6).map((n: any) => ({
      title: n.title ?? "",
      link: n.link ?? "",
      publisher: n.publisher ?? "",
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    }));

    const snowflake = {
      value: scoreValue(metrics.peRatio, metrics.pegRatio, metrics.priceToBook, metrics.priceToSales),
      growth: scoreGrowth(metrics.revenueGrowthYoY, metrics.epsGrowth),
      health: scoreHealth(metrics.currentRatio, metrics.debtToEquity, metrics.netMargin),
      past: scorePast(metrics.returnOnEquity, metrics.netMargin, metrics.freeCashFlow, metrics.marketCap),
      dividend: scoreDividend(metrics.dividendYield),
    };

    const earningsDate = parseEarningsDate(summary, earningsDbRows[0]?.earningsDate ?? null);

    const payload = attachCatalysts({
      metrics,
      recommendations,
      analystActions,
      analystPriceTargets,
      priceTargetRange,
      bullBullets,
      bearBullets,
      news,
      snowflake,
      earningsDate,
      peers: peersPayload.peers.slice(0, 8),
      peerIndustry: peersPayload.industry,
      peerSector: peersPayload.sector,
    });
    breakdownCache.set(key, payload);
    return res.json(payload);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("No fundamentals data") || msg.includes("Not Found")) {
      return res.status(404).json({ error: `Ticker not found: ${upperTicker}` });
    }
    return res.status(500).json({ error: `Failed to fetch stock data: ${msg}` });
  }
});

// GET /stocks/competitors/:ticker — DB-first peer tickers (no scoring)
router.get("/stocks/competitors/:ticker", async (req, res) => {
  const key = String(req.params["ticker"] ?? "").toUpperCase();
  if (!key) return res.status(400).json({ error: "ticker required" });

  try {
    const hadCache = peersCache.get(key) != null;
    const { sector, industry, peers } = await resolvePeers(key);
    return res.json({
      ticker: key,
      sector,
      industry,
      peers: peers.slice(0, 8),
      source: hadCache ? "cache" : "db",
    });
  } catch (err: any) {
    logger.error({ ticker: key, err }, "GET /stocks/competitors failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
