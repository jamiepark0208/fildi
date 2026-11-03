// Inputs for the fund score: ticker_fundamentals row → engine input, market cap, history, surprises, IBES.
// Used by computeAndPersistFundamentalScores (fundamentals-db.ts).
import { inArray, desc, and, isNotNull } from "drizzle-orm";
import {
  db, pool, tickerFundamentalsHistory, earningsCalendar, type TickerFundamentalsRow,
} from "@workspace/db";
import { logger } from "./logger.js";
import {
  avgEpsSurprise, type FundRowInput, type HistoryByTicker, type IbesSignalsByTicker, type MetricKey,
} from "./fund-score-engine.js";
import { num as parseNum, ibesRevBreadth, avgIbesSue } from "./fund-derived-metrics.js";

export function rowToFundInput(
  row: TickerFundamentalsRow,
  peerGroupId: string | null,
  scoringMode: string | null,
): FundRowInput {
  const n = (v: string | null | undefined) => parseNum(v);
  return {
    ticker: row.ticker,
    peRatio: n(row.peRatio),
    pegRatio: n(row.pegRatio),
    forwardPe: n(row.forwardPe),
    evEbitda: n(row.evEbitda),
    evRevenue: n(row.evRevenue),
    priceToBook: n(row.priceToBook),
    priceToSales: n(row.priceToSales),
    dividendYield: n(row.dividendYield),
    netIncome: n(row.netIncome),
    freeCashFlow: n(row.freeCashFlow),
    totalRevenue: n(row.totalRevenue),
    ebitda: n(row.ebitda),
    ebit: n(row.ebit),
    interestExpense: n(row.interestExpense),
    grossMargin: n(row.grossMargin),
    operatingMargin: n(row.operatingMargin),
    netMargin: n(row.netMargin),
    returnOnEquity: n(row.returnOnEquity),
    returnOnAssets: n(row.returnOnAssets),
    roic: n(row.roic),
    wacc: n(row.wacc),
    revenueGrowthYoY: n(row.revenueGrowthYoY),
    revenueGrowthYoyPrior: n(row.revenueGrowthYoyPrior),
    epsGrowth: n(row.epsGrowth),
    analystTargetPrice: n(row.analystTargetPrice),
    currentPrice: null,
    marketCap: null, // yields use NI/FCF over mcap — without live quote, skip EY/FCFY or use pe inverse
    currentRatio: n(row.currentRatio),
    debtToEquity: n(row.debtToEquity),
    totalDebt: n(row.totalDebt),
    cashAndEquivalents: n(row.cashAndEquivalents),
    quarterlyOperatingCashFlow: n(row.quarterlyOperatingCashFlow),
    sharesOutstanding: n(row.sharesOutstanding),
    sharesOutstandingPrior: n(row.sharesOutstandingPrior),
    beta: n(row.beta),
    grossProfit: n(row.grossProfit as string | null),
    totalAssets: n(row.totalAssets as string | null),
    annualOperatingCashFlow: n(row.annualOperatingCashFlow as string | null),
    tangibleBookValuePerShare: n((row as any).tangibleBookValuePerShare as string | null),
    ffoProxy: n((row as any).ffoProxy as string | null),
    totalStockholdersEquity: n(row.totalStockholdersEquity),
    negativeEquity: row.negativeEquity === true,
    peerGroupId,
    scoringMode,
  };
}

/** Prefer Finnhub mcap (stored in millions) → PE×EPS×shares → fwdPE×|EPS|×shares. */
export function enrichMarketCap(
  input: FundRowInput,
  row: TickerFundamentalsRow,
  finnhubMcapMillions?: number | null,
): FundRowInput {
  if (finnhubMcapMillions != null && Number.isFinite(finnhubMcapMillions) && finnhubMcapMillions > 0) {
    return { ...input, marketCap: finnhubMcapMillions * 1e6 };
  }
  const pe = parseNum(row.peRatio);
  const eps = parseNum(row.earningsPerShare);
  const sh = parseNum(row.sharesOutstanding);
  if (pe != null && eps != null && sh != null && pe > 0 && eps !== 0) {
    return { ...input, marketCap: pe * eps * sh };
  }
  const fpe = parseNum(row.forwardPe);
  if (fpe != null && fpe >= 5 && eps != null && sh != null && fpe > 0) {
    return { ...input, marketCap: fpe * Math.abs(eps) * sh };
  }
  return input;
}

const HISTORY_COL_TO_METRIC: Partial<Record<string, MetricKey>> = {
  peRatio: "fwdpe",
  priceToBook: "pb",
  roic: "roicwacc",
  grossMargin: "grossmgn",
  operatingMargin: "operatingmgn",
  netMargin: "netmgn",
  revenueGrowth: "revgrow",
  epsGrowth: "epsgrow",
  fcf: "fcfYield",
  roe: "roe",
  debtToEquity: "de",
  currentRatio: "cr",
  grossProfit: "gpa",
};

export async function loadHistoryByTicker(tickers: string[]): Promise<HistoryByTicker> {
  if (tickers.length === 0) return {};
  const rows = await db
    .select()
    .from(tickerFundamentalsHistory)
    .where(inArray(tickerFundamentalsHistory.ticker, tickers));
  const out: HistoryByTicker = {};
  for (const row of rows) {
    const t = row.ticker;
    if (!out[t]) out[t] = {};
    for (const [col, metricKey] of Object.entries(HISTORY_COL_TO_METRIC)) {
      if (!metricKey) continue;
      const v = parseNum((row as any)[col]);
      if (v == null) continue;
      if (!out[t]![metricKey]) out[t]![metricKey] = [];
      out[t]![metricKey]!.push(v);
    }
  }
  return out;
}

export async function loadSurprisesByTicker(tickers: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  if (tickers.length === 0) return out;
  const rows = await db
    .select({
      ticker: earningsCalendar.ticker,
      surprisePct: earningsCalendar.surprisePct,
      reportDate: earningsCalendar.reportDate,
    })
    .from(earningsCalendar)
    .where(and(inArray(earningsCalendar.ticker, tickers), isNotNull(earningsCalendar.epsActual)))
    .orderBy(desc(earningsCalendar.reportDate));
  const byTicker = new Map<string, number[]>();
  for (const r of rows) {
    const s = parseNum(r.surprisePct);
    if (s == null) continue;
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    const arr = byTicker.get(r.ticker)!;
    if (arr.length < 4) arr.push(s);
  }
  for (const t of tickers) {
    out[t] = avgEpsSurprise(byTicker.get(t) ?? []);
  }
  return out;
}

/**
 * WRDS IBES research cache → growth extras.
 * Schema absent or ticker missing → nulls (coverage shrinkage, no penalty).
 */
export async function loadIbesSignalsByTicker(tickers: string[]): Promise<IbesSignalsByTicker> {
  const out: IbesSignalsByTicker = {};
  for (const t of tickers) out[t] = { revBreadth: null, sue: null, fwdGrowth: null };
  if (tickers.length === 0) return out;

  try {
    const schema = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = 'wrds_research'
       ) AS exists`,
    );
    if (!schema.rows[0]?.exists) return out;

    const stats = await pool.query<{
      oftic: string;
      numup: number | null;
      numdown: number | null;
      numest: number | null;
    }>(
      `SELECT DISTINCT ON (oftic)
         oftic, numup, numdown, numest
       FROM wrds_research.ibes_statsum
       WHERE oftic = ANY($1::text[])
         AND measure = 'EPS'
         AND (fiscalp IS NULL OR fiscalp IN ('ANN', 'QTR', 'Y'))
       ORDER BY oftic,
         CASE WHEN fpi IN ('1', '1.0') THEN 0 ELSE 1 END,
         CASE WHEN fiscalp IN ('ANN', 'Y') THEN 0 ELSE 1 END,
         statpers DESC`,
      [tickers],
    );
    for (const r of stats.rows) {
      const t = r.oftic?.toUpperCase();
      if (!t || !out[t]) continue;
      out[t].revBreadth = ibesRevBreadth(r.numup, r.numdown, r.numest);
    }

    // Consensus FY1→FY2 EPS growth from the SAME statpers (ratio is split-invariant), fresh ≤ 120 days,
    // positive FY1 only (loss → profit has no meaningful growth rate); clamped like epsgrow.
    // One-off guard: FY1 jumping > 25% vs the prior statpers while FY2 moves < 10% means a non-recurring item
    // landed in FY1 (GOOGL 2026-08: FY1 14.21 → 20.60, FY2 14.68 → 14.97 ⇒ a fake −27%) → null.
    const fwd = await pool.query<{ oftic: string; e1: number; e2: number; p1: number | null; p2: number | null }>(
      `WITH pairs AS (
         SELECT a.oftic, a.statpers, a.meanest::float AS e1, b.meanest::float AS e2
         FROM wrds_research.ibes_statsum a
         JOIN wrds_research.ibes_statsum b
           ON b.oftic = a.oftic AND b.statpers = a.statpers AND b.measure = 'EPS' AND b.fpi = '2'
         WHERE a.oftic = ANY($1::text[]) AND a.measure = 'EPS' AND a.fpi = '1'
           AND a.meanest IS NOT NULL AND b.meanest IS NOT NULL
       ), cur AS (
         SELECT DISTINCT ON (oftic) * FROM pairs WHERE statpers >= CURRENT_DATE - 120 ORDER BY oftic, statpers DESC
       )
       SELECT c.oftic, c.e1, c.e2, p.e1 AS p1, p.e2 AS p2
       FROM cur c
       LEFT JOIN LATERAL (
         SELECT e1, e2 FROM pairs x WHERE x.oftic = c.oftic AND x.statpers <= c.statpers - 25
         ORDER BY x.statpers DESC LIMIT 1
       ) p ON true`,
      [tickers],
    );
    for (const r of fwd.rows) {
      const t = r.oftic?.toUpperCase();
      if (!t || !out[t] || !(r.e1 > 0) || !Number.isFinite(r.e2)) continue;
      if (r.p1 != null && r.p2 != null && r.p1 > 0 && r.p2 > 0
          && Math.abs(r.e1 / r.p1 - 1) > 0.25 && Math.abs(r.e2 / r.p2 - 1) < 0.10) continue;
      out[t].fwdGrowth = Math.max(-0.9, Math.min(3, r.e2 / r.e1 - 1));
    }

    const surp = await pool.query<{ oftic: string; suescore: number | null }>(
      `SELECT oftic, suescore
       FROM wrds_research.ibes_surpsum
       WHERE oftic = ANY($1::text[])
         AND suescore IS NOT NULL
       ORDER BY oftic, anndats DESC NULLS LAST`,
      [tickers],
    );
    const sueBy = new Map<string, number[]>();
    for (const r of surp.rows) {
      const t = r.oftic?.toUpperCase();
      if (!t || r.suescore == null || !Number.isFinite(Number(r.suescore))) continue;
      if (!sueBy.has(t)) sueBy.set(t, []);
      const arr = sueBy.get(t)!;
      if (arr.length < 4) arr.push(Number(r.suescore));
    }
    for (const t of tickers) {
      out[t].sue = avgIbesSue(sueBy.get(t) ?? []);
    }
  } catch (err) {
    logger.warn({ err }, "loadIbesSignalsByTicker: wrds_research unavailable — skipping IBES extras");
  }
  return out;
}
