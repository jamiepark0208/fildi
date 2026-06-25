import { eq, isNull, or, lt, sql } from "drizzle-orm";
import { db, tickerFundamentals, fmpApiUsage, type TickerFundamentalsRow } from "@workspace/db";
import type { FMPFundamentalsData } from "./fmp-client.js";
import { logger } from "./logger.js";

const STALE_DAYS = 7;

// Triangulation candidates: fields where we compare FMP vs Yahoo and flag >20% divergence.
// The Yahoo values are passed in from the existing quoteSummary response at query time.
export const TRIANGULATION_FIELDS = [
  "netMargin",
  "revenueGrowthYoY",
  "grossMargin",
  "returnOnEquity",
  "freeCashFlow",
] as const;

export type TriangulationField = (typeof TRIANGULATION_FIELDS)[number];

// Yahoo quote object field names corresponding to each triangulation field.
const YAHOO_FIELD_MAP: Record<TriangulationField, string> = {
  netMargin:        "profitMargins",
  revenueGrowthYoY: "revenueGrowth",
  grossMargin:      "grossMargins",
  returnOnEquity:   "returnOnEquity",
  freeCashFlow:     "freeCashflow",
};

// Compare FMP values against Yahoo values. Returns a list of field names where
// the relative divergence exceeds 20%. Uses FMP as primary regardless.
export function checkTriangulation(
  fmp: FMPFundamentalsData,
  yahooQuote: Record<string, unknown>,
): string[] {
  const flags: string[] = [];
  const fmpByField: Record<string, number | undefined> = {
    netMargin:        fmp.netMargin,
    revenueGrowthYoY: fmp.revenueGrowthYoY,
    grossMargin:      fmp.grossMargin,
    returnOnEquity:   fmp.returnOnEquity,
    freeCashFlow:     fmp.freeCashFlow,
  };

  for (const field of TRIANGULATION_FIELDS) {
    const fmpVal = fmpByField[field];
    const yahooRaw = yahooQuote[YAHOO_FIELD_MAP[field]];
    const yahooVal = yahooRaw != null ? Number(yahooRaw) : NaN;

    if (fmpVal === undefined || !isFinite(fmpVal) || !isFinite(yahooVal)) continue;
    if (Math.abs(fmpVal) < 1e-9) continue; // avoid divide-by-zero on near-zero values

    const relDiff = Math.abs(fmpVal - yahooVal) / Math.abs(fmpVal);
    if (relDiff > 0.2) {
      logger.warn({ field, fmpVal, yahooVal, relDiff: relDiff.toFixed(2) }, "fmp: triangulation discrepancy");
      flags.push(field);
    }
  }
  return flags;
}

// Upsert a fundamentals row. Called by the refresh job.
export async function writeFundamentalsRow(
  ticker: string,
  data: FMPFundamentalsData,
  discrepancyFlags: string[],
  regimeAtScore?: string | null,
): Promise<void> {
  const expectedFields = 30; // approximate count of optional numeric fields
  const nonNullCount = Object.values(data).filter(v => v !== undefined).length;
  const coveragePct = Math.round((nonNullCount / expectedFields) * 100);

  await db
    .insert(tickerFundamentals)
    .values({
      ticker:                     ticker.toUpperCase(),
      fundamentalsLastFetched:    new Date(),
      discrepancyFlags:           discrepancyFlags.length ? discrepancyFlags.join(",") : null,
      fmpCoveragePercent:         String(coveragePct),
      peRatio:                    num(data.peRatio),
      pegRatio:                   num(data.pegRatio),
      forwardPe:                  num(data.forwardPe),
      evEbitda:                   num(data.evEbitda),
      evRevenue:                  num(data.evRevenue),
      priceToBook:                num(data.priceToBook),
      priceToSales:               num(data.priceToSales),
      debtToEquity:               num(data.debtToEquity),
      totalRevenue:               num(data.totalRevenue),
      revenueGrowthYoY:           num(data.revenueGrowthYoY),
      revenueGrowthYoyPrior:      num(data.revenueGrowthYoyPrior),
      netIncome:                  num(data.netIncome),
      ebitda:                     num(data.ebitda),
      earningsPerShare:           num(data.earningsPerShare),
      epsGrowth:                  num(data.epsGrowth),
      freeCashFlow:               num(data.freeCashFlow),
      dividendYield:              num(data.dividendYield),
      returnOnEquity:             num(data.returnOnEquity),
      returnOnAssets:             num(data.returnOnAssets),
      currentRatio:               num(data.currentRatio),
      grossMargin:                num(data.grossMargin),
      operatingMargin:            num(data.operatingMargin),
      netMargin:                  num(data.netMargin),
      beta:                       num(data.beta),
      analystTargetPrice:         num(data.analystTargetPrice),
      wacc:                       num(data.wacc),
      roic:                       num(data.roic),
      interestExpense:            num(data.interestExpense),
      totalDebt:                  num(data.totalDebt),
      totalStockholdersEquity:    num(data.totalStockholdersEquity),
      ebit:                       num(data.ebit),
      effectiveTaxRate:           num(data.effectiveTaxRate),
      cashAndEquivalents:         num(data.cashAndEquivalents),
      quarterlyOperatingCashFlow: num(data.quarterlyOperatingCashFlow),
      sharesOutstanding:          num(data.sharesOutstanding),
      sharesOutstandingPrior:     num(data.sharesOutstandingPrior),
      regimeAtScore:              regimeAtScore ?? null,
    })
    .onConflictDoUpdate({
      target: tickerFundamentals.ticker,
      set: {
        fundamentalsLastFetched:    new Date(),
        discrepancyFlags:           discrepancyFlags.length ? discrepancyFlags.join(",") : null,
        fmpCoveragePercent:         String(coveragePct),
        peRatio:                    num(data.peRatio),
        pegRatio:                   num(data.pegRatio),
        forwardPe:                  num(data.forwardPe),
        evEbitda:                   num(data.evEbitda),
        evRevenue:                  num(data.evRevenue),
        priceToBook:                num(data.priceToBook),
        priceToSales:               num(data.priceToSales),
        debtToEquity:               num(data.debtToEquity),
        totalRevenue:               num(data.totalRevenue),
        revenueGrowthYoY:           num(data.revenueGrowthYoY),
        revenueGrowthYoyPrior:      num(data.revenueGrowthYoyPrior),
        netIncome:                  num(data.netIncome),
        ebitda:                     num(data.ebitda),
        earningsPerShare:           num(data.earningsPerShare),
        epsGrowth:                  num(data.epsGrowth),
        freeCashFlow:               num(data.freeCashFlow),
        dividendYield:              num(data.dividendYield),
        returnOnEquity:             num(data.returnOnEquity),
        returnOnAssets:             num(data.returnOnAssets),
        currentRatio:               num(data.currentRatio),
        grossMargin:                num(data.grossMargin),
        operatingMargin:            num(data.operatingMargin),
        netMargin:                  num(data.netMargin),
        beta:                       num(data.beta),
        analystTargetPrice:         num(data.analystTargetPrice),
        wacc:                       num(data.wacc),
        roic:                       num(data.roic),
        interestExpense:            num(data.interestExpense),
        totalDebt:                  num(data.totalDebt),
        totalStockholdersEquity:    num(data.totalStockholdersEquity),
        ebit:                       num(data.ebit),
        effectiveTaxRate:           num(data.effectiveTaxRate),
        cashAndEquivalents:         num(data.cashAndEquivalents),
        quarterlyOperatingCashFlow: num(data.quarterlyOperatingCashFlow),
        sharesOutstanding:          num(data.sharesOutstanding),
        sharesOutstandingPrior:     num(data.sharesOutstandingPrior),
        regimeAtScore:              regimeAtScore ?? null,
      },
    });
}

// Read one ticker's fundamentals row. Returns null if not yet populated.
export async function readFundamentalsRow(ticker: string): Promise<TickerFundamentalsRow | null> {
  const rows = await db
    .select()
    .from(tickerFundamentals)
    .where(eq(tickerFundamentals.ticker, ticker.toUpperCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllFundamentalsRows(): Promise<TickerFundamentalsRow[]> {
  return db.select().from(tickerFundamentals);
}

// Return tickers whose fundamentals are missing or older than STALE_DAYS.
export async function getStaleTickers(allTickers: string[]): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const freshRows = await db
    .select({ ticker: tickerFundamentals.ticker })
    .from(tickerFundamentals)
    .where(
      sql`${tickerFundamentals.fundamentalsLastFetched} > ${cutoff}`,
    );

  const freshSet = new Set(freshRows.map(r => r.ticker.toUpperCase()));
  return allTickers.map(t => t.toUpperCase()).filter(t => !freshSet.has(t));
}

// Get last-fetched status for all tickers (for the /fundamentals/status endpoint).
export async function getAllFundamentalsStatus(): Promise<
  Array<{ ticker: string; lastFetched: Date | null; coveragePct: number | null; discrepancyFlags: string[] }>
> {
  const rows = await db.select({
    ticker:                  tickerFundamentals.ticker,
    fundamentalsLastFetched: tickerFundamentals.fundamentalsLastFetched,
    fmpCoveragePercent:      tickerFundamentals.fmpCoveragePercent,
    discrepancyFlags:        tickerFundamentals.discrepancyFlags,
  }).from(tickerFundamentals);

  return rows.map(r => ({
    ticker:          r.ticker,
    lastFetched:     r.fundamentalsLastFetched ?? null,
    coveragePct:     r.fmpCoveragePercent != null ? parseFloat(r.fmpCoveragePercent) : null,
    discrepancyFlags: r.discrepancyFlags ? r.discrepancyFlags.split(",") : [],
  }));
}

function num(v: number | undefined): string | null {
  return v !== undefined ? String(v) : null;
}

// ── FMP API daily budget guard ────────────────────────────────────────────────
// Free tier limit: ~250 calls/day. Each ticker refresh = 7 endpoints.
// MAX_DAILY_CALLS set conservatively at 220 to leave headroom.

const MAX_DAILY_CALLS = 220;
const CALLS_PER_TICKER = 7;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Returns true if `additionalCalls` can be made without exceeding daily budget.
// Resets counter automatically when the date changes.
export async function checkFMPBudget(
  additionalCalls: number,
): Promise<{ allowed: boolean; callsToday: number; remaining: number }> {
  const today = todayISO();
  const rows = await db.select().from(fmpApiUsage).where(eq(fmpApiUsage.id, 1)).limit(1);
  const row = rows[0];

  const callsToday = (!row || row.resetDate !== today) ? 0 : row.callsToday;
  const remaining = MAX_DAILY_CALLS - callsToday;
  return { allowed: callsToday + additionalCalls <= MAX_DAILY_CALLS, callsToday, remaining };
}

// Increment daily call counter by `calls`. Upserts the singleton row.
// Resets to `calls` if the date has changed.
export async function recordFMPCalls(calls: number): Promise<void> {
  const today = todayISO();
  const rows = await db.select().from(fmpApiUsage).where(eq(fmpApiUsage.id, 1)).limit(1);
  const existing = rows[0];

  if (!existing || existing.resetDate !== today) {
    await db.insert(fmpApiUsage)
      .values({ id: 1, callsToday: calls, resetDate: today })
      .onConflictDoUpdate({ target: fmpApiUsage.id, set: { callsToday: calls, resetDate: today } });
  } else {
    await db.update(fmpApiUsage)
      .set({ callsToday: existing.callsToday + calls })
      .where(eq(fmpApiUsage.id, 1));
  }
}
