import { Router } from "express";
import { yahooFinance } from "../lib/yahoo-client.js";
import { readLatestFairValue, type LatestFairValue } from "../lib/fair-value-snapshots.js";
import { eq, inArray, sql } from "drizzle-orm";
import {
  CompareStocksQueryParams,
  SearchStocksQueryParams,
} from "@workspace/api-zod";
import {
  type TickerFundamentalsRow,
  db,
  indicatorCache,
  tickerFundamentals,
  tickerTechnicals,
  edgarStatementHistory,
  type EdgarStatementHistoryRow,
  tickerEventBullets,
} from "@workspace/db";
import { readFundamentalsRow, readRegistryRow } from "../lib/fundamentals-db.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { buildCatalystItems, mergeCaseBullets, parseEarningsDate } from "../lib/catalysts.js";
import { resolvePeers, peersCache } from "../lib/peer-resolver.js";
import { getTaxonomyPeers } from "../lib/peer-classifier.js";
import { rankCompetitors } from "../lib/peer-rankings.js";
import { isAnalystDataFresh, parseAnalystHistory, readAnalystEventsFromDb, writeAnalystEvents, readFmpAnalystEventsFromDb } from "../lib/analyst-events.js";
import { parseAnalystHeadlines } from "../lib/analyst-headline-parser.js";
import { isEarningsDataFresh, readEarningsHistoryFromDb, writeEarningsHistory, fetchLiveEarningsHistory, ensureUpcomingEarnings, type EarningsQuarter } from "../lib/earnings-history.js";
import { logger } from "../lib/logger.js";
import { getLivePrices } from "../lib/live-quote.js";
import { fetchEdgarStatementHistory, fetchFiscalYearEnd } from "../lib/edgar-client.js";
import {
  resolvePegGrowth,
  isUsablePegGrowth,
  computeCanonicalPeg,
  computeForwardPeg,
} from "../lib/derived-metrics.js";
import {
  buildScoreEvidence,
  buildStreetSynthesis,
  buildTradeOverlay,
  ensureTodaySnapshot,
  loadScoreHistory,
  readFundPeerGroupId,
} from "../lib/breakdown-enrichment.js";

const router = Router();

/** Z-score of subject's PEG growth vs peer-group gold EPS growth (higher = better). */
async function pegGrowthPeerZScore(
  ticker: string,
  pegGrowth: number | null | undefined,
): Promise<{
  z: number | null;
  n: number;
  groupName: string | null;
  mean: number | null;
  std: number | null;
  members: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
  display: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
}> {
  const empty = {
    z: null as number | null,
    n: 0,
    groupName: null as string | null,
    mean: null as number | null,
    std: null as number | null,
    members: [] as Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>,
    display: [] as Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>,
  };
  if (pegGrowth == null || !isFinite(pegGrowth)) return empty;

  const taxonomy = await getTaxonomyPeers(ticker, 500);
  if (!taxonomy || taxonomy.peers.length < 3) {
    return { ...empty, groupName: taxonomy?.groupName ?? null };
  }

  const subject = ticker.toUpperCase();
  const tickers = [subject, ...taxonomy.peers.map((t) => t.toUpperCase())];
  const rows = await db
    .select({
      ticker: tickerFundamentals.ticker,
      epsGrowth: tickerFundamentals.epsGrowth,
      totalRevenue: tickerFundamentals.totalRevenue,
    })
    .from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, tickers));

  type Raw = { ticker: string; growth: number; isSubject: boolean; size: number | null };
  const raw: Raw[] = [];
  for (const r of rows) {
    const upper = r.ticker.toUpperCase();
    const size = fmpNum(r.totalRevenue);
    if (upper === subject) {
      raw.push({ ticker: upper, growth: pegGrowth, isSubject: true, size });
      continue;
    }
    const v = fmpNum(r.epsGrowth);
    if (v != null && isFinite(v)) {
      raw.push({ ticker: upper, growth: v, isSubject: false, size });
    }
  }
  if (raw.length < 4) {
    return { ...empty, n: raw.length, groupName: taxonomy.groupName };
  }

  const vals = raw.map((r) => r.growth);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance);
  const zOf = (g: number) => (std > 1e-12 ? (g - mean) / std : 0);
  const members = raw
    .map((r) => ({
      ticker: r.ticker,
      growth: r.growth,
      z: zOf(r.growth),
      isSubject: r.isSubject,
      marketCap: r.size, // size proxy = total revenue (gold has no marketCap)
    }))
    .sort((a, b) => a.growth - b.growth);

  const subjectZ = zOf(pegGrowth);
  // Representatives when the peer set is large: subject + growth extremes + largest names
  const display = pickPeerGrowthRepresentatives(members, 9);

  return {
    z: subjectZ,
    n: members.length,
    groupName: taxonomy.groupName,
    mean,
    std,
    members,
    display,
  };
}

/** Subject + lowest/highest growth + largest-revenue peers (cap labeled points). */
function pickPeerGrowthRepresentatives<
  T extends { ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null },
>(members: T[], max = 9): T[] {
  if (members.length <= max) return members;
  const byGrowth = [...members].sort((a, b) => a.growth - b.growth);
  const bySize = [...members]
    .filter((m) => !m.isSubject)
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const picked = new Map<string, T>();
  const add = (m: T | undefined) => {
    if (m && !picked.has(m.ticker)) picked.set(m.ticker, m);
  };
  add(byGrowth.find((m) => m.isSubject));
  add(byGrowth[0]);
  add(byGrowth[byGrowth.length - 1]);
  add(byGrowth[Math.floor(byGrowth.length * 0.25)]);
  add(byGrowth[Math.floor(byGrowth.length * 0.5)]);
  add(byGrowth[Math.floor(byGrowth.length * 0.75)]);
  for (const m of bySize) {
    if (picked.size >= max) break;
    add(m);
  }
  return [...picked.values()].sort((a, b) => a.growth - b.growth);
}

export const searchCache = new TTLCache<object[]>(24 * 60 * 60 * 1000, 'search', 2000);
export const compareCache = new TTLCache<object>(60 * 60 * 1000, 'compare', 2000); // key = "TICKER1:TICKER2", combinatorial — cap well above realistic pair traffic

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
function buildMetrics(quote: any, fmp: TickerFundamentalsRow | null, ticker: string, reg?: { name: string | null; sector: string | null; industryGroup: string | null } | null, fv?: LatestFairValue | null) {
  // ── Price & market data — always Yahoo ───────────────────────────────────────
  const currentPrice = safeNum(quote.regularMarketPrice);
  const marketCap    = safeNum(quote.marketCap);

  // ── Valuation ratios — FMP primary, Yahoo fallback ───────────────────────────
  const peRatio = fmpNum(fmp?.peRatio)
    ?? safeNum(quote.trailingPE)
    ?? safeNum(quote.forwardPE);

  const pegRatio = fmpNum(fmp?.pegRatio) ?? (() => {
    // Prefer gold-derived PEG; never Yahoo quote pegRatio (5yr expected — different metric).
    const pe = fmpNum(fmp?.peRatio) ?? safeNum(quote.trailingPE);
    const g = fmpNum(fmp?.epsGrowth);
    if (pe != null && g != null && g > 0.05 && g < 3 && pe > 0) return pe / (g * 100);
    return null;
  })();

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

  // EPS growth: prefer gold; fall back to computed trailing→forward delta from Yahoo
  const goldEpsGrowth = fmpNum(fmp?.epsGrowth);
  const earningsPerShare = fmpNum(fmp?.earningsPerShare)
    ?? safeNum(quote.trailingEps);
  const forwardEps =
    safeNum(quote.forwardEps) ??
    (() => {
      // Reverse from gold forwardPe when Yahoo forwardEps missing
      const fp = fmpNum(fmp?.forwardPe);
      if (fp != null && currentPrice != null && fp !== 0) return currentPrice / fp;
      return null;
    })();
  const epsGrowth = goldEpsGrowth ?? (() => {
    const eps = earningsPerShare;
    const fwd = forwardEps;
    return eps !== null && fwd !== null && eps !== 0
      ? (fwd - eps) / Math.abs(eps)
      : null;
  })();
  // Same resolver merge-trusted / FactSet use for PEG — expose for UI explainability
  const pegGrowth = resolvePegGrowth({
    epsGrowth: goldEpsGrowth,
    trailingEps: earningsPerShare,
    forwardEps,
  });
  const pegGrowthSource: "trailing_yoy" | "forward_implied" | null =
    isUsablePegGrowth(goldEpsGrowth)
      ? "trailing_yoy"
      : pegGrowth != null
        ? "forward_implied"
        : null;

  // ── Income statement — FMP primary, Yahoo fallback ───────────────────────────
  const totalRevenue = fmpNum(fmp?.totalRevenue) ?? safeNum(quote.totalRevenue);
  const netIncome    = fmpNum(fmp?.netIncome)    ?? safeNum(quote.netIncomeToCommon);
  const ebitda       = fmpNum(fmp?.ebitda)       ?? safeNum(quote.ebitda);
  // freeCashFlow: FMP annual cash-flow-statement is now primary; Yahoo is fallback
  const freeCashFlow = fmpNum(fmp?.freeCashFlow) ?? safeNum(quote.freeCashflow);

  // ── Margins — FMP primary, Yahoo fallback ────────────────────────────────────
  const grossMargin     = fmpNum(fmp?.grossMargin)     ?? safeNum(quote.grossMargins);
  const operatingMargin = fmpNum(fmp?.operatingMargin) ?? safeNum(quote.operatingMargins);
  const netMargin       = fmpNum(fmp?.netMargin)       ?? safeNum(quote.profitMargins);
  const returnOnEquity  = fmpNum(fmp?.returnOnEquity)  ?? safeNum(quote.returnOnEquity);
  const returnOnAssets  = fmpNum(fmp?.returnOnAssets)  ?? safeNum(quote.returnOnAssets);
  const currentRatio    = fmpNum(fmp?.currentRatio)    ?? safeNum(quote.currentRatio);
  const beta            = fmpNum(fmp?.beta)            ?? safeNum(quote.beta);

  // ── Classification ─────────────────────────────────────────────────────────────
  // Fair value is the nightly blended snapshot (lib/fair-value.ts), not computed per request.
  const stockType  = classifyStockType(peRatio, pegRatio, dividendYield, revenueGrowthYoY);

  // ── Phase 4 value / acceleration fields — FMP only ──────────────────────────
  const forwardPe               = fmpNum(fmp?.forwardPe);
  const forwardPeg              = fmpNum(fmp?.forwardPeg)
    ?? computeForwardPeg(forwardPe, pegGrowth);
  const derivedPeg              = fmpNum(fmp?.pegRatio)
    ?? computeCanonicalPeg(peRatio, pegGrowth);
  const evEbitda                = fmpNum(fmp?.evEbitda);
  const evRevenue               = fmpNum(fmp?.evRevenue);
  const revenueGrowthYoyPrior   = fmpNum(fmp?.revenueGrowthYoyPrior);

  const pegGrowthExplain =
    pegGrowthSource === "trailing_yoy" && pegGrowth != null
      ? `PEG uses trailing YoY EPS growth (${(pegGrowth * 100).toFixed(1)}%). Formula: PEG = P/E ÷ (growth × 100). This matches FactSet Full-Ratio style — what the company already earned, not Street 5yr forecasts.`
      : pegGrowthSource === "forward_implied" && pegGrowth != null
        ? `Trailing YoY growth was missing or zero, so PEG falls back to near-term Street growth: (forward EPS − trailing EPS) ÷ |trailing EPS| = ${(pegGrowth * 100).toFixed(1)}%. That embeds consensus estimates for the next year, not a long-term CAGR.`
        : `No usable EPS growth yet — PEG stays empty until we have trailing YoY growth or both trailing and forward EPS.`;

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
    companyName: reg?.name ?? quote.longName ?? quote.shortName ?? ticker.toUpperCase(),
    currentPrice,
    marketCap,
    peRatio,
    pegRatio: pegRatio ?? derivedPeg,
    priceToBook,
    priceToSales,
    leverageRatio,
    debtToEquity,
    totalRevenue,
    revenueGrowthYoY,
    revenueGrowthYoyPrior,
    revenueGrowthProjected,
    netIncome,
    ebitda,
    earningsPerShare,
    forwardEps,
    epsGrowth,
    pegGrowth,
    pegGrowthSource,
    pegGrowthExplain,
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
    fairValueEstimate:      fv?.fairValue ?? null,
    fairValueLow:           fv?.low ?? null,
    fairValueHigh:          fv?.high ?? null,
    fairValueConfidence:    fv?.confidence ?? null,
    fairValueImpliedGrowth: fv?.impliedGrowth ?? null,
    fairValueVotes:         fv?.votes ?? [],
    fairValueAsOf:          fv?.asOf ?? null,
    fairValueChange3m:      fv?.change3m ?? null,
    fairValueCyclical:      fv?.cyclical ?? false,
    fairValueValueTrap:     fv?.valueTrap ?? false,
    stockType,
    sector:      reg?.sector        ?? quote.sector   ?? null,
    industry:    reg?.industryGroup ?? quote.industry ?? null,
    exchange:    quote.exchangeName ?? quote.exchange ?? null,
    currency:    quote.currency    ?? "USD",
    logoUrl:     null,
    description: quote.longBusinessSummary?.slice(0, 500) ?? null,
    dayChange:        safeNum(quote.regularMarketChange),
    dayChangePercent: safeNum(quote.regularMarketChangePercent),
    forwardPe,
    forwardPeg,
    evEbitda,
    evRevenue,
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
    const [q1, q2, fmp1, fmp2, reg1, reg2, fv1, fv2] = await Promise.all([
      yahooFinance.quoteSummary(t1, {
        modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics"],
      }),
      yahooFinance.quoteSummary(t2, {
        modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics"],
      }),
      readFundamentalsRow(t1),
      readFundamentalsRow(t2),
      readRegistryRow(t1),
      readRegistryRow(t2),
      readLatestFairValue(t1),
      readLatestFairValue(t2),
    ]);

    const merged1 = { ...q1.price, ...q1.summaryDetail, ...q1.financialData, ...q1.defaultKeyStatistics };
    const merged2 = { ...q2.price, ...q2.summaryDetail, ...q2.financialData, ...q2.defaultKeyStatistics };

    const stock1 = buildMetrics(merged1, fmp1, t1, reg1, fv1);
    const stock2 = buildMetrics(merged2, fmp2, t2, reg2, fv2);
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

export const historyCache = new TTLCache<object[]>(60 * 60 * 1000, 'history', 2000); // key = "TICKER_PERIOD", ~250 tickers x periods, cap covers off-universe symbols too
export const historyCache1D = new TTLCache<object[]>(15 * 60 * 1000, 'history-1d', 1000); // key = ticker only

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

type QuoteMetrics = ReturnType<typeof buildMetrics> & { earningsDate: ReturnType<typeof parseEarningsDate> };

export const quoteCache = new TTLCache<QuoteMetrics>(60 * 60 * 1000, 'quote', 1000); // key = ticker

async function fetchQuoteSummary(ticker: string) {
  return yahooFinance.quoteSummary(ticker.toUpperCase(), {
    modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile", "calendarEvents"],
  });
}

async function fetchQuoteMetrics(ticker: string): Promise<QuoteMetrics> {
  const key = ticker.toUpperCase();
  // getOrCompute coalesces concurrent misses for the same ticker into one Yahoo call.
  return quoteCache.getOrCompute(key, async () => {
    const [q, fmpRow, regRow, fv] = await Promise.all([
      fetchQuoteSummary(key),
      readFundamentalsRow(key),
      readRegistryRow(key),
      readLatestFairValue(key),
    ]);
    // assetProfile carries sector/industry — price/summaryDetail/financialData/
    // defaultKeyStatistics never do, so quote.sector was always undefined without it.
    const merged = { ...q.price, ...q.summaryDetail, ...q.financialData, ...q.defaultKeyStatistics, ...q.assetProfile };
    return { ...buildMetrics(merged, fmpRow, key, regRow, fv), earningsDate: parseEarningsDate(q, null) };
  });
}

// Overlays the golden-source live price (same cache Live Monitor reads) onto a metrics
// object built by buildMetrics(), so currentPrice matches exactly across breakdown/quote/live.
async function withLivePrice<T extends { currentPrice: number | null }>(ticker: string, metrics: T): Promise<T> {
  const live = await getLivePrices([ticker]);
  const price = live.get(ticker.toUpperCase())?.price;
  return price != null ? { ...metrics, currentPrice: price } : metrics;
}

router.get("/stocks/quote", async (req, res) => {
  const { ticker } = req.query as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const key = ticker.toUpperCase();
  try {
    const metrics = await fetchQuoteMetrics(key);
    return res.json(await withLivePrice(key, metrics));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("No fundamentals data") || msg.includes("Not Found")) {
      return res.status(404).json({ error: `Ticker not found: ${key}` });
    }
    return res.status(500).json({ error: `Failed to fetch stock data: ${msg}` });
  }
});

// GET /stocks/quotes?tickers=A,B,C — batched quote fetch, per-ticker quoteCache reuse.
// Caps concurrent Yahoo calls so a large watchlist doesn't fan out N simultaneous requests.
const QUOTES_BATCH_CONCURRENCY = 6;

router.get("/stocks/quotes", async (req, res) => {
  const { tickers } = req.query as { tickers?: string };
  if (!tickers || typeof tickers !== "string") {
    return res.status(400).json({ error: "tickers is required" });
  }
  const keys = [...new Set(tickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean))];
  if (keys.length === 0) {
    return res.status(400).json({ error: "tickers is required" });
  }

  const results: Record<string, object | { error: string }> = {};
  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try {
        results[key] = await fetchQuoteMetrics(key);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        results[key] = { error: msg.includes("No fundamentals data") || msg.includes("Not Found") ? `Ticker not found: ${key}` : `Failed to fetch stock data: ${msg}` };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(QUOTES_BATCH_CONCURRENCY, keys.length) }, worker));

  const live = await getLivePrices(keys);
  for (const key of keys) {
    const r = results[key];
    const livePrice = live.get(key)?.price;
    if (r && !("error" in r) && livePrice != null) {
      results[key] = { ...r, currentPrice: livePrice };
    }
  }

  return res.json(results);
});

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

export const breakdownCache = new TTLCache<object>(2 * 60 * 60 * 1000, 'breakdown', 1000); // key = "TICKER:vN"

type BreakdownPayload = {
  metrics: unknown;
  recommendations: unknown;
  analystActions: Array<{
    firm: string; toGrade: string; fromGrade: string; action: string; date: string | null;
    priceTarget?: number | null; source?: "yahoo" | "fmp" | "headline";
  }>;
  analystPriceTargets: Array<{
    firm: string; analyst: string | null; priceTarget: number | null; date: string | null;
    priceWhenPosted: number | null; newsTitle: string | null; source: "fmp" | "headline";
  }>;
  priceTargetRange: unknown;
  bullBullets: string[];
  bearBullets: string[];
  news: Array<{ title: string; link?: string; publisher?: string; publishedAt: string | null; source?: "desk" | "yahoo" }>;
  /** @deprecated legacy 1–5 snowflake — prefer scoreEvidence */
  snowflake?: unknown;
  scoreEvidence?: unknown;
  scoreHistory?: unknown;
  street?: unknown;
  tradeOverlay?: unknown;
  earningsDate?: string | null;
  earningsHistory?: EarningsQuarter[];
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
};

function attachCatalysts(payload: BreakdownPayload): BreakdownPayload {
  const items = buildCatalystItems({
    earningsDate: payload.earningsDate ?? null,
    analystActions: payload.analystActions ?? [],
    news: payload.news ?? [],
  });
  // Lean analyst (and rare news) lines fold into bull/bear; true neutrals stay in catalysts.
  // Earnings stay neutral here too, but the Trade row already shows ER — UI may hide them.
  payload.catalysts = items.filter(i => i.lean === "neutral").map(i => i.text);
  payload.bullBullets = mergeCaseBullets(
    items.filter(i => i.lean === "bull").map(i => i.text),
    payload.bullBullets ?? [],
  );
  payload.bearBullets = mergeCaseBullets(
    items.filter(i => i.lean === "bear").map(i => i.text),
    payload.bearBullets ?? [],
  );
  return payload;
}

// Bump when breakdown payload shape or catalyst parsing changes (invalidates stale entries).
const BREAKDOWN_CACHE_VER = 14; // 14: blended fair value fields

// Overlays the golden-source live price onto the (possibly 2h-stale, cached) breakdown
// payload's metrics.currentPrice, so it matches exactly what Live Monitor / quote show.
async function overlayBreakdownPrice(ticker: string, payload: BreakdownPayload): Promise<BreakdownPayload> {
  const live = await getLivePrices([ticker]);
  const price = live.get(ticker)?.price;
  if (price != null && payload.metrics && typeof payload.metrics === "object") {
    (payload.metrics as any).currentPrice = price;
  }
  return payload;
}

router.get("/stocks/breakdown", async (req, res) => {
  const { ticker } = req.query as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const upperTicker = ticker.toUpperCase();
  const key = `${upperTicker}:v${BREAKDOWN_CACHE_VER}`;

  try {
    // getOrCompute coalesces concurrent misses for the same ticker into one build
    // (breakdown is the heaviest fan-out: Yahoo summary + news + peers + fundamentals).
    const payload = (await breakdownCache.getOrCompute(key, async () => {
    const analystFresh = await isAnalystDataFresh(upperTicker);
    const modules = ["price", "summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile", "recommendationTrend", "calendarEvents"];
    if (!analystFresh) modules.push("upgradeDowngradeHistory");

    const [summary, newsRes, fmpRow, regRow, earningsDbRows, peersPayload, fv] = await Promise.all([
      yahooFinance.quoteSummary(upperTicker, { modules: modules as any }),
      yahooFinance.search(upperTicker, { newsCount: 15, quotesCount: 0 } as any, { validateResult: false }).catch(() => ({ news: [] })),
      readFundamentalsRow(upperTicker),
      readRegistryRow(upperTicker),
      db.select({ earningsDate: indicatorCache.earningsDate })
        .from(indicatorCache)
        .where(eq(indicatorCache.ticker, upperTicker))
        .limit(1),
      resolvePeers(upperTicker).catch(err => {
        logger.warn({ ticker: upperTicker, err }, "resolvePeers in breakdown failed");
        return { ticker: upperTicker, sector: null, industry: null, peers: [] as string[] };
      }),
      readLatestFairValue(upperTicker),
    ]);

    const merged = {
      ...summary.price,
      ...summary.summaryDetail,
      ...summary.financialData,
      ...summary.defaultKeyStatistics,
      ...summary.assetProfile,
    };
    const metrics = buildMetrics(merged, fmpRow, upperTicker, regRow, fv) as ReturnType<typeof buildMetrics> & {
      pegGrowthPeerZ?: number | null;
      pegGrowthPeerN?: number;
      pegGrowthPeerGroup?: string | null;
      pegGrowthPeerMean?: number | null;
      pegGrowthPeerStd?: number | null;
      pegGrowthPeerMembers?: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
      pegGrowthPeerDisplay?: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
    };
    const peerZ = await pegGrowthPeerZScore(upperTicker, metrics.pegGrowth);
    metrics.pegGrowthPeerZ = peerZ.z;
    metrics.pegGrowthPeerN = peerZ.n;
    metrics.pegGrowthPeerGroup = peerZ.groupName;
    metrics.pegGrowthPeerMean = peerZ.mean;
    metrics.pegGrowthPeerStd = peerZ.std;
    metrics.pegGrowthPeerMembers = peerZ.members;
    metrics.pegGrowthPeerDisplay = peerZ.display;

    const recTrend = (summary as any).recommendationTrend?.trend?.[0];
    const recommendations = recTrend ? {
      strongBuy: recTrend.strongBuy ?? 0,
      buy: recTrend.buy ?? 0,
      hold: recTrend.hold ?? 0,
      sell: recTrend.sell ?? 0,
      strongSell: recTrend.strongSell ?? 0,
    } : null;

    // Per-firm analyst actions — DB-first when fresh (<7d), else live Yahoo + write-through
    let analystActions;
    if (analystFresh) {
      analystActions = await readAnalystEventsFromDb(upperTicker);
    } else {
      const rawHistory: any[] = (summary as any).upgradeDowngradeHistory?.history ?? [];
      analystActions = parseAnalystHistory(rawHistory);
      writeAnalystEvents(upperTicker, rawHistory).catch(err => {
        logger.warn({ ticker: upperTicker, err }, "analyst events write-through failed");
      });
    }

    // Historical EPS actual-vs-estimate — DB-first when fresh (<30d), else live
    // FMP (falling back to Finnhub for tickers FMP's plan 402s on) + write-through.
    // The nightly runEarningsHistoryBackfill job (scheduler.ts) proactively keeps the
    // whole ticker universe fresh, so this live path is a rare cold-start/edge case,
    // not the normal way the tab gets populated.
    let earningsHistory: EarningsQuarter[] = [];
    if (await isEarningsDataFresh(upperTicker)) {
      // Reported actuals are fresh, but that check doesn't cover the upcoming
      // (unreported) quarter — top that up separately (cheap no-op once a future
      // row already exists) so the tab always shows through the next scheduled report.
      await ensureUpcomingEarnings(upperTicker, "breakdown").catch(err => {
        logger.warn({ ticker: upperTicker, err }, "ensureUpcomingEarnings failed");
      });
      earningsHistory = await readEarningsHistoryFromDb(upperTicker);
    } else {
      const liveRows = await fetchLiveEarningsHistory(upperTicker, "breakdown");
      if (liveRows.length > 0) {
        writeEarningsHistory(upperTicker, liveRows).catch(err => {
          logger.warn({ ticker: upperTicker, err }, "earnings history write-through failed");
        });
      }
      earningsHistory = liveRows
        .map(r => ({
          reportDate: r.reportDate,
          epsEstimate: r.epsEstimate,
          epsActual: r.epsActual,
          surprisePct: r.epsActual != null && r.epsEstimate != null && r.epsEstimate !== 0
            ? ((r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate)) * 100
            : null,
        }))
        .sort((a, b) => b.reportDate.localeCompare(a.reportDate))
        .slice(0, 9);
      if (earningsHistory.length === 0) {
        earningsHistory = await readEarningsHistoryFromDb(upperTicker);
      }
    }

    // Aggregate price target range from financialData
    const fd = (summary as any).financialData ?? {};
    const priceTargetRange = {
      high:   safeNum(fd.targetHighPrice)   ?? null,
      low:    safeNum(fd.targetLowPrice)    ?? null,
      mean:   safeNum(fd.targetMeanPrice)   ?? null,
      median: safeNum(fd.targetMedianPrice) ?? null,
    };

    // Merge in FMP's daily-archived per-firm rows (fmp-grade/fmp-target — see
    // fmp-analyst-feed.ts for why they're two separate row types) plus a heuristic
    // pass over the news headlines already fetched above. Both are best-effort
    // supplements to the Yahoo-sourced analystActions above, not replacements —
    // tagged with `source` so the UI can show a confidence indicator.
    const fmpEvents = await readFmpAnalystEventsFromDb(upperTicker);
    const fmpTargetByFirmDate = new Map(
      fmpEvents.filter(e => e.priceTarget != null).map(e => [`${e.firm}|${e.eventDate}`, e.priceTarget]),
    );

    const yahooActionsTagged = analystActions.map(a => ({ ...a, source: "yahoo" as const }));

    const fmpGradeActions = fmpEvents
      .filter(e => e.action !== "price-target")
      .map(e => ({
        firm: e.firm,
        toGrade: e.toGrade ?? "",
        fromGrade: e.fromGrade ?? "",
        action: e.action,
        date: e.eventDate,
        priceTarget: fmpTargetByFirmDate.get(`${e.firm}|${e.eventDate}`) ?? null,
        source: "fmp" as const,
      }));

    const headlineEvents = parseAnalystHeadlines(
      ((newsRes as any).news ?? []).map((n: any) => ({
        title: n.title ?? "",
        publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      })),
    );
    const headlineActions = headlineEvents
      .filter(e => e.action !== "price-target")
      .map(e => ({
        firm: e.firm, toGrade: e.toGrade ?? "", fromGrade: e.fromGrade ?? "", action: e.action,
        date: e.date, priceTarget: e.priceTarget, source: "headline" as const,
      }));

    analystActions = [...yahooActionsTagged, ...fmpGradeActions, ...headlineActions];

    const fmpPriceTargets = fmpEvents
      .filter(e => e.action === "price-target" && e.priceTarget != null)
      .map(e => ({
        firm: e.firm, analyst: null, priceTarget: e.priceTarget, date: e.eventDate,
        priceWhenPosted: null, newsTitle: null, source: "fmp" as const,
      }));
    const headlinePriceTargets = headlineEvents
      .filter(e => e.action === "price-target" && e.priceTarget != null)
      .map(e => ({
        firm: e.firm, analyst: null, priceTarget: e.priceTarget, date: e.date,
        priceWhenPosted: null, newsTitle: null, source: "headline" as const,
      }));
    const analystPriceTargets = [...fmpPriceTargets, ...headlinePriceTargets];

    // Metric-driven bull/bear bullets, with same-day event bullets (earnings beat/miss,
    // analyst upgrade/downgrade, large price move ex-macro) from the daily trigger check
    // (event-bullets.ts) prepended so timely info wins the capped slots over static ratios.
    const eventBulletsRow = (await db.select().from(tickerEventBullets)
      .where(eq(tickerEventBullets.ticker, upperTicker)).limit(1))[0];
    const bullBullets = [...(eventBulletsRow?.bullBullets as string[] ?? []), ...buildBullBullets(metrics)].slice(0, 4);
    const bearBullets = [...(eventBulletsRow?.bearBullets as string[] ?? []), ...buildBearBullets(metrics)].slice(0, 4);

    const news = ((newsRes as any).news ?? []).slice(0, 6).map((n: any) => ({
      title: n.title ?? "",
      link: n.link ?? "",
      publisher: n.publisher ?? "",
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      source: "yahoo" as const,
    }));

    await ensureTodaySnapshot(upperTicker, fmpRow);
    const [scoreEvidence, scoreHistory, street, peerGroupId] = await Promise.all([
      buildScoreEvidence(upperTicker, fmpRow),
      loadScoreHistory(upperTicker),
      buildStreetSynthesis({
        ticker: upperTicker,
        recommendations,
        targetMean: priceTargetRange.mean,
        price: metrics.currentPrice ?? null,
      }),
      readFundPeerGroupId(upperTicker),
    ]);
    if (!scoreEvidence.peerGroupId) scoreEvidence.peerGroupId = peerGroupId;
    const tradeOverlay = await buildTradeOverlay(upperTicker, street.eventRisk);

    const earningsDate = parseEarningsDate(summary, earningsDbRows[0]?.earningsDate ?? null);

    return attachCatalysts({
      metrics,
      recommendations,
      analystActions,
      analystPriceTargets,
      priceTargetRange,
      bullBullets,
      bearBullets,
      news,
      scoreEvidence,
      scoreHistory,
      street,
      tradeOverlay,
      earningsDate,
      earningsHistory,
      peers: peersPayload.peers.slice(0, 8),
      peerIndustry: peersPayload.industry,
      peerSector: peersPayload.sector,
    });
    })) as BreakdownPayload;
    return res.json(await overlayBreakdownPrice(upperTicker, attachCatalysts(payload)));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("No fundamentals data") || msg.includes("Not Found")) {
      return res.status(404).json({ error: `Ticker not found: ${upperTicker}` });
    }
    return res.status(500).json({ error: `Failed to fetch stock data: ${msg}` });
  }
});

// GET /stocks/edgar-statements/:ticker — multi-year income/balance/cash-flow
// statements from SEC EDGAR (edgar-client.ts fetchEdgarStatementHistory), an
// independent free source from the FMP-derived fundamentals used elsewhere, plus
// rule-based trend findings and a cross-check against the FMP numbers already
// shown on the breakdown tab.
const EDGAR_STATEMENTS_STALE_MS = 100 * 24 * 60 * 60 * 1000; // ~1 quarter — 10-Ks refresh annually

interface EdgarFinding { text: string; tone: "positive" | "negative" | "neutral"; }

function cagr(first: number, last: number, years: number): number | null {
  if (first <= 0 || years <= 0) return null;
  return Math.pow(last / first, 1 / years) - 1;
}

function computeEdgarFindings(
  rows: EdgarStatementHistoryRow[],
  fmpRow: TickerFundamentalsRow | null,
): EdgarFinding[] {
  const findings: EdgarFinding[] = [];
  // rows can carry 6 fiscal years per item (5 displayed + 1 extra as a YoY baseline for
  // the oldest displayed year — see fetchEdgarStatementHistory). Drop that extra oldest
  // year here so findings describe the same 5-year window the UI shows.
  const byItem = (lineItem: string) => {
    const arr = rows
      .filter(r => r.lineItem === lineItem)
      .map(r => ({ year: r.fiscalYear, value: Number(r.value) }))
      .sort((a, b) => a.year - b.year);
    return arr.length > 5 ? arr.slice(1) : arr;
  };

  const revenue = byItem("revenue");
  const netIncome = byItem("netIncome");
  const grossProfit = byItem("grossProfit");
  const operatingIncome = byItem("operatingIncome");
  const operatingCF = byItem("operatingCashFlow");
  const capex = byItem("capex");
  const longTermDebt = byItem("longTermDebt");
  const equity = byItem("stockholdersEquity");

  if (revenue.length >= 2) {
    const c = cagr(revenue[0].value, revenue[revenue.length - 1].value, revenue.length - 1);
    if (c != null) {
      findings.push({
        text: `Revenue ${c >= 0 ? "grew" : "declined"} at a ${(c * 100).toFixed(1)}% annual rate over the last ${revenue.length} filed years (SEC 10-K).`,
        tone: c > 0.03 ? "positive" : c < -0.03 ? "negative" : "neutral",
      });
    }
  }

  if (grossProfit.length >= 2 && revenue.length >= 2) {
    const marginAt = (year: number) => {
      const gp = grossProfit.find(g => g.year === year)?.value;
      const rev = revenue.find(r => r.year === year)?.value;
      return gp != null && rev ? gp / rev : null;
    };
    const first = marginAt(grossProfit[0].year);
    const last = marginAt(grossProfit[grossProfit.length - 1].year);
    if (first != null && last != null) {
      const delta = last - first;
      findings.push({
        text: `Gross margin ${delta >= 0 ? "expanded" : "compressed"} from ${(first * 100).toFixed(1)}% to ${(last * 100).toFixed(1)}% over the filed history.`,
        tone: delta > 0.005 ? "positive" : delta < -0.005 ? "negative" : "neutral",
      });
    }
  }

  if (operatingCF.length > 0 && netIncome.length > 0) {
    const latestYear = Math.max(...operatingCF.map(o => o.year));
    const opCF = operatingCF.find(o => o.year === latestYear)?.value;
    const capexVal = Math.abs(capex.find(c => c.year === latestYear)?.value ?? 0);
    const ni = netIncome.find(n => n.year === latestYear)?.value;
    if (opCF != null && ni != null) {
      const fcf = opCF - capexVal;
      const gap = ni !== 0 ? (fcf - ni) / Math.abs(ni) : 0;
      if (gap < -0.25) {
        findings.push({
          text: `FY${latestYear} free cash flow ($${(fcf / 1e6).toFixed(0)}M) is well below reported net income ($${(ni / 1e6).toFixed(0)}M) — an earnings-quality flag worth digging into (accruals, working-capital swings, or capex timing).`,
          tone: "negative",
        });
      } else if (gap > 0.1) {
        findings.push({
          text: `FY${latestYear} free cash flow ($${(fcf / 1e6).toFixed(0)}M) comfortably exceeds net income ($${(ni / 1e6).toFixed(0)}M) — earnings are being backed by real cash generation.`,
          tone: "positive",
        });
      }
    }
  }

  if (longTermDebt.length >= 2 && equity.length >= 2) {
    const ratioAt = (year: number) => {
      const d = longTermDebt.find(x => x.year === year)?.value;
      const e = equity.find(x => x.year === year)?.value;
      return d != null && e ? d / e : null;
    };
    const first = ratioAt(longTermDebt[0].year);
    const last = ratioAt(longTermDebt[longTermDebt.length - 1].year);
    if (first != null && last != null) {
      const delta = last - first;
      if (Math.abs(delta) > 0.1) {
        findings.push({
          text: `Long-term debt / equity ${delta > 0 ? "rose" : "fell"} from ${first.toFixed(2)}x to ${last.toFixed(2)}x over the filed history.`,
          tone: delta > 0 ? "negative" : "positive",
        });
      }
    }
  }

  // Cross-check against the FMP-derived numbers already shown elsewhere in the app —
  // this is the actual "second layer of validation" against the existing pipeline.
  if (fmpRow && revenue.length > 0) {
    const fmpRevenue = fmpRow.totalRevenue != null ? Number(fmpRow.totalRevenue) : null;
    if (fmpRevenue && fmpRevenue > 0) {
      // FMP's figure can lag one fiscal year behind EDGAR's most recently filed 10-K (e.g.
      // MSFT's FY ends in June — EDGAR reflects the new FY within weeks of filing, but FMP's
      // annual revenue can still show the prior FY for a while). Compare against whichever of
      // the last two EDGAR years is the closer match so a one-year lag isn't misreported as a
      // genuine data-quality issue.
      const candidates = revenue.slice(-2);
      const best = candidates.reduce((a, b) =>
        Math.abs(a.value - fmpRevenue) <= Math.abs(b.value - fmpRevenue) ? a : b);
      const diff = Math.abs(best.value - fmpRevenue) / fmpRevenue;
      if (diff > 0.05) {
        findings.push({
          text: `Data discrepancy: SEC-filed FY${best.year} revenue ($${(best.value / 1e6).toFixed(0)}M) differs from the FMP-sourced figure shown on this page ($${(fmpRevenue / 1e6).toFixed(0)}M) by ${(diff * 100).toFixed(1)}% — worth checking which period each source is reporting.`,
          tone: "negative",
        });
      }
    }
  }

  return findings;
}

function groupStatementRows(rows: EdgarStatementHistoryRow[]) {
  const group = (type: string) => {
    const byLineItem = new Map<string, { fiscalYear: number; value: number }[]>();
    for (const r of rows.filter(x => x.statementType === type)) {
      const arr = byLineItem.get(r.lineItem) ?? [];
      arr.push({ fiscalYear: r.fiscalYear, value: Number(r.value) });
      byLineItem.set(r.lineItem, arr);
    }
    return Object.fromEntries(
      [...byLineItem.entries()].map(([k, v]) => [k, v.sort((a, b) => b.fiscalYear - a.fiscalYear)]),
    );
  };
  return { income: group("income"), balance: group("balance"), cashflow: group("cashflow") };
}

export const edgarStatementsCache = new TTLCache<object>(60 * 60 * 1000, 'edgar-statements', 500);

router.get("/stocks/edgar-statements/:ticker", async (req, res) => {
  const upperTicker = String(req.params["ticker"] ?? "").toUpperCase();
  if (!upperTicker) return res.status(400).json({ error: "ticker required" });

  try {
    const payload = await edgarStatementsCache.getOrCompute(upperTicker, async () => {
      let rows: EdgarStatementHistoryRow[] = await db
        .select()
        .from(edgarStatementHistory)
        .where(eq(edgarStatementHistory.ticker, upperTicker));

      const isStale = rows.length === 0 || rows.every(
        r => Date.now() - new Date(r.fetchedAt).getTime() > EDGAR_STATEMENTS_STALE_MS,
      );

      if (isStale) {
        const fresh = await fetchEdgarStatementHistory(upperTicker);
        if (fresh && fresh.length > 0) {
          await db.insert(edgarStatementHistory)
            .values(fresh.map(r => ({
              ticker: upperTicker,
              fiscalYear: r.fiscalYear,
              statementType: r.statementType,
              lineItem: r.lineItem,
              value: String(r.value),
              filedDate: r.filedDate,
            })))
            .onConflictDoUpdate({
              target: [edgarStatementHistory.ticker, edgarStatementHistory.fiscalYear, edgarStatementHistory.statementType, edgarStatementHistory.lineItem],
              set: { value: sql`excluded.value`, filedDate: sql`excluded.filed_date`, fetchedAt: sql`now()` },
            });
          rows = await db
            .select()
            .from(edgarStatementHistory)
            .where(eq(edgarStatementHistory.ticker, upperTicker));
        }
      }

      if (rows.length === 0) {
        return { available: false, income: {}, balance: {}, cashflow: {}, findings: [], asOf: null, fiscalYearEnd: null };
      }

      const fmpRow = await readFundamentalsRow(upperTicker);
      const findings = computeEdgarFindings(rows, fmpRow);
      const asOf = rows.reduce((max, r) => (r.filedDate > max ? r.filedDate : max), rows[0].filedDate);
      const fiscalYearEnd = await fetchFiscalYearEnd(upperTicker).catch(() => null);

      return { available: true, ...groupStatementRows(rows), findings, asOf, fiscalYearEnd };
    });

    return res.json(payload);
  } catch (err: any) {
    logger.error({ ticker: upperTicker, err: String(err?.message ?? err) }, "edgar-statements route failed");
    return res.status(500).json({ error: `Failed to fetch EDGAR statements: ${String(err?.message ?? err)}` });
  }
});

// GET /stocks/competitors/:ticker — taxonomy peer group first (curated, same
// classification used for fundamental peer-group scoring), DB/Finnhub/FMP chain
// as fallback for tickers with no/thin taxonomy group. Returns fund/tech-ranked peers.
router.get("/stocks/competitors/:ticker", async (req, res) => {
  const key = String(req.params["ticker"] ?? "").toUpperCase();
  if (!key) return res.status(400).json({ error: "ticker required" });

  try {
    const taxonomy = await getTaxonomyPeers(key);
    let peers = taxonomy?.peers ?? [];
    let sector: string | null = null;
    let industry: string | null = null;
    let groupName: string | null = taxonomy?.groupName ?? null;
    let source: "taxonomy" | "legacy" = "taxonomy";

    if (peers.length < 5) {
      const legacy = await resolvePeers(key);
      sector = legacy.sector;
      industry = legacy.industry;
      if (peers.length === 0) {
        peers = legacy.peers;
        groupName = null;
        source = "legacy";
      }
    }
    peers = peers.slice(0, 15);

    const allTickers = [key, ...peers];
    const [techRows, fundRows] = await Promise.all([
      db.select().from(tickerTechnicals).where(inArray(tickerTechnicals.ticker, allTickers)),
      db.select().from(tickerFundamentals).where(inArray(tickerFundamentals.ticker, allTickers)),
    ]);

    const ranked = rankCompetitors(key, peers, techRows, fundRows, {
      limit: 12,
      includeSubject: true,
    });

    return res.json({
      ticker: key,
      groupId: taxonomy?.groupId ?? null,
      groupName,
      sector,
      industry,
      source,
      ranked,
    });
  } catch (err: any) {
    logger.error({ ticker: key, err }, "GET /stocks/competitors failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
