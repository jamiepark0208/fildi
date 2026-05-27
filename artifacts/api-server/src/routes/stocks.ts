import { Router } from "express";
import yahooFinance from "yahoo-finance2";
import {
  CompareStocksQueryParams,
  SearchStocksQueryParams,
} from "@workspace/api-zod";

const router = Router();

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

  addItem("P/E Ratio", 2, s1.peRatio, s2.peRatio, false, fmtNum,
    "Lower P/E suggests a cheaper stock relative to earnings.");
  addItem("PEG Ratio", 2, s1.pegRatio, s2.pegRatio, false, fmtNum,
    "PEG < 1 signals undervalued growth. Lower is better.");
  addItem("Revenue Growth (YoY)", 2, s1.revenueGrowthYoY, s2.revenueGrowthYoY, true, fmtPct,
    "Higher revenue growth signals business expansion.");
  addItem("Projected Revenue Growth", 1.5, s1.revenueGrowthProjected, s2.revenueGrowthProjected, true, fmtPct,
    "Forward-looking growth expectation from analysts.");
  addItem("Net Margin", 2, s1.netMargin, s2.netMargin, true, fmtPct,
    "Higher net margin means more profit per dollar of revenue.");
  addItem("Gross Margin", 1, s1.grossMargin, s2.grossMargin, true, fmtPct,
    "Higher gross margin signals pricing power and efficiency.");
  addItem("Return on Equity (ROE)", 2, s1.returnOnEquity, s2.returnOnEquity, true, fmtPct,
    "ROE measures how efficiently equity generates profit.");
  addItem("Return on Assets (ROA)", 1, s1.returnOnAssets, s2.returnOnAssets, true, fmtPct,
    "ROA shows how effectively assets generate earnings.");
  addItem("EPS Growth", 2, s1.epsGrowth, s2.epsGrowth, true, fmtPct,
    "Higher EPS growth means rising per-share earnings power.");
  addItem("Free Cash Flow", 1.5, s1.freeCashFlow, s2.freeCashFlow, true, fmtLargeNum,
    "More free cash flow means more flexibility for growth and returns.");
  addItem("Debt-to-Equity", 1.5, s1.debtToEquity, s2.debtToEquity, false, fmtNum,
    "Lower D/E ratio means less financial leverage and risk.");
  addItem("Current Ratio", 1, s1.currentRatio, s2.currentRatio, true, fmtNum,
    "Current ratio > 1 means the company can cover short-term liabilities.");
  addItem("Price-to-Book", 1, s1.priceToBook, s2.priceToBook, false, fmtNum,
    "Lower P/B may indicate undervaluation relative to assets.");
  addItem("Fair Value vs. Price", 2, 
    s1.fairValueEstimate !== null && s1.currentPrice !== null ? (s1.fairValueEstimate - s1.currentPrice) / s1.currentPrice : null,
    s2.fairValueEstimate !== null && s2.currentPrice !== null ? (s2.fairValueEstimate - s2.currentPrice) / s2.currentPrice : null,
    true, fmtPct,
    "Positive margin of safety (fair value > price) suggests upside potential.");

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

function buildMetrics(quote: any, ticker: string) {
  const eps = safeNum(quote.epsTrailingTwelveMonths);
  const epsForward = safeNum(quote.epsForward);
  const epsGrowth = eps !== null && epsForward !== null && eps !== 0
    ? (epsForward - eps) / Math.abs(eps)
    : null;
  const peRatio = safeNum(quote.trailingPE) ?? safeNum(quote.forwardPE);
  const revenueGrowthYoY = safeNum(quote.revenueGrowth);
  const dividendYield = safeNum(quote.dividendYield);
  const pegRatio = safeNum(quote.pegRatio) ??
    (peRatio !== null && epsGrowth !== null && epsGrowth !== 0
      ? peRatio / (epsGrowth * 100)
      : null);
  const stockType = classifyStockType(peRatio, pegRatio, dividendYield, revenueGrowthYoY);
  const fairValue = computeFairValue(eps, epsGrowth, peRatio);

  return {
    ticker: ticker.toUpperCase(),
    companyName: quote.longName ?? quote.shortName ?? ticker.toUpperCase(),
    currentPrice: safeNum(quote.regularMarketPrice),
    marketCap: safeNum(quote.marketCap),
    peRatio,
    pegRatio,
    priceToBook: safeNum(quote.priceToBook),
    priceToSales: safeNum(quote.priceToSalesTrailing12Months),
    leverageRatio: safeNum(quote.debtToEquity) !== null ? (safeNum(quote.debtToEquity)! / 100) + 1 : null,
    debtToEquity: safeNum(quote.debtToEquity) !== null ? safeNum(quote.debtToEquity)! / 100 : null,
    totalRevenue: safeNum(quote.totalRevenue),
    revenueGrowthYoY,
    revenueGrowthProjected: safeNum(quote.revenueGrowth),
    netIncome: safeNum(quote.netIncomeToCommon),
    ebitda: safeNum(quote.ebitda),
    earningsPerShare: eps,
    epsGrowth,
    freeCashFlow: safeNum(quote.freeCashflow),
    dividendYield,
    returnOnEquity: safeNum(quote.returnOnEquity),
    returnOnAssets: safeNum(quote.returnOnAssets),
    currentRatio: safeNum(quote.currentRatio),
    grossMargin: safeNum(quote.grossMargins),
    operatingMargin: safeNum(quote.operatingMargins),
    netMargin: safeNum(quote.profitMargins),
    beta: safeNum(quote.beta),
    fiftyTwoWeekHigh: safeNum(quote.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: safeNum(quote.fiftyTwoWeekLow),
    analystTargetPrice: safeNum(quote.targetMeanPrice),
    fairValueEstimate: fairValue,
    stockType,
    sector: quote.sector ?? null,
    industry: quote.industry ?? null,
    exchange: quote.exchangeName ?? quote.exchange ?? null,
    currency: quote.currency ?? "USD",
    logoUrl: null,
    description: quote.longBusinessSummary?.slice(0, 300) ?? null,
  };
}

router.get("/stocks/compare", async (req, res) => {
  const parsed = CompareStocksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ticker1 and ticker2 are required" });
  }
  const { ticker1, ticker2 } = parsed.data;

  try {
    const [q1, q2] = await Promise.all([
      yahooFinance.quoteSummary(ticker1.toUpperCase(), {
        modules: [
          "price",
          "summaryDetail",
          "financialData",
          "defaultKeyStatistics",
          "assetProfile",
        ],
      }),
      yahooFinance.quoteSummary(ticker2.toUpperCase(), {
        modules: [
          "price",
          "summaryDetail",
          "financialData",
          "defaultKeyStatistics",
          "assetProfile",
        ],
      }),
    ]);

    const merged1 = {
      ...q1.price,
      ...q1.summaryDetail,
      ...q1.financialData,
      ...q1.defaultKeyStatistics,
      ...q1.assetProfile,
    };
    const merged2 = {
      ...q2.price,
      ...q2.summaryDetail,
      ...q2.financialData,
      ...q2.defaultKeyStatistics,
      ...q2.assetProfile,
    };

    const stock1 = buildMetrics(merged1, ticker1);
    const stock2 = buildMetrics(merged2, ticker2);
    const scorecard = buildScorecard(stock1, stock2, ticker1.toUpperCase(), ticker2.toUpperCase());

    return res.json({ stock1, stock2, scorecard });
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

  try {
    const results = await yahooFinance.search(q, { newsCount: 0, quotesCount: 8 });
    const quotes = (results.quotes ?? [])
      .filter((r: any) => r.isYahooFinance && r.symbol)
      .slice(0, 8)
      .map((r: any) => ({
        ticker: r.symbol,
        name: r.longname ?? r.shortname ?? r.symbol,
        exchange: r.exchange ?? "",
        type: r.quoteType ?? "EQUITY",
      }));
    return res.json(quotes);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
