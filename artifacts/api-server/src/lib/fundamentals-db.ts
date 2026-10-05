import { eq, isNull, or, lt, sql, inArray, desc, and, isNotNull } from "drizzle-orm";
import {
  db, tickerFundamentals, tickerRegistry, peerGroups, fmpApiUsage,
  tickerFundamentalsHistory, earningsCalendar, finnhubFundamentals,
  type TickerFundamentalsRow, type TickerRegistryRow,
} from "@workspace/db";
import { recordApiUsage, checkDailyBudget } from "./api-usage.js";
import type { FMPFundamentalsData } from "./fmp-client.js";
import { logger } from "./logger.js";
import {
  NEUTRAL_SCORE, FAMILY_MIN_COVERAGE, TOTAL_MIN_COVERAGE, shrinkToNeutral, winsorizeValues,
} from "./fundamentals-scoring-math.js";
import { isExcludedEtf } from "./etf-exclusions.js";
import {
  FMP_MAX_DAILY_CALLS,
  STALE_DAYS as DATA_OPS_STALE_DAYS,
} from "./data-ops-config.js";
import {
  scoreUniverse, withRanks, avgEpsSurprise, type FundRowInput, type HistoryByTicker, type MetricKey,
} from "./fund-score-engine.js";
import { num as parseNum } from "./fund-derived-metrics.js";

const STALE_DAYS = DATA_OPS_STALE_DAYS;

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
// NOTE: this is the DATA FETCH path and deliberately does not touch regime_at_score.
// That column records the regime a *score* was computed under and is owned solely by
// computeAndPersistFundamentalScores(). Writing it here (as this function used to)
// clobbered the scorer's value with the fetch-time regime — or with null from the
// backfill script — which silently disabled the persisted-score cache entirely.
export async function writeFundamentalsRow(
  ticker: string,
  data: FMPFundamentalsData,
  discrepancyFlags: string[],
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

export async function readRegistryRow(ticker: string): Promise<Pick<TickerRegistryRow, 'name' | 'sector' | 'industryGroup'> | null> {
  const rows = await db
    .select({ name: tickerRegistry.name, sector: tickerRegistry.sector, industryGroup: tickerRegistry.industryGroup })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.ticker, ticker.toUpperCase()))
    .limit(1);
  return rows[0] ?? null;
}

// Return tickers whose fundamentals are missing or older than STALE_DAYS.
export async function getStaleTickers(allTickers: string[]): Promise<string[]> {
  if (allTickers.length === 0) return [];
  const normalized = allTickers.map(t => t.toUpperCase());
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  // Only scan rows for tickers we care about; let the index on fundamentalsLastFetched filter stale ones
  const freshRows = await db
    .select({ ticker: tickerFundamentals.ticker })
    .from(tickerFundamentals)
    .where(
      sql`${inArray(tickerFundamentals.ticker, normalized)} AND ${tickerFundamentals.fundamentalsLastFetched} > ${cutoff}`,
    );

  const freshSet = new Set(freshRows.map(r => r.ticker.toUpperCase()));
  return normalized.filter(t => !freshSet.has(t));
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
// Free tier ~250 calls/day. Each full FMP ticker fetch = DATA_OPS_CALLS.fmp endpoints.

const MAX_DAILY_CALLS = FMP_MAX_DAILY_CALLS;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Returns whether `additionalCalls` can be made without exceeding daily budget.
// Reads from unified api_usage table; fmp_api_usage is no longer the source of truth.
export async function checkFMPBudget(
  additionalCalls: number,
): Promise<{ allowed: boolean; callsToday: number; remaining: number }> {
  const today = todayISO();
  const rows = await db.execute<{ calls_made: number }>(
    sql`SELECT calls_made FROM api_usage WHERE source = 'fmp' AND date = ${today}::date`
  );
  const callsToday = rows.rows[0]?.calls_made ?? 0;
  const remaining = MAX_DAILY_CALLS - callsToday;
  return { allowed: callsToday + additionalCalls <= MAX_DAILY_CALLS, callsToday, remaining };
}

// Increment FMP daily call counter. Delegates to unified api_usage table.
export async function recordFMPCalls(calls: number): Promise<void> {
  await recordApiUsage("fmp", calls);
}

// ── Fundamental score computation ─────────────────────────────────────────────

export type FamilyCoverage = { value: number; quality: number; growth: number; safety: number; total: number };

export type FundScoreResult = {
  ticker: string;
  // null = not enough data to score honestly (see FAMILY_MIN_COVERAGE / TOTAL_MIN_COVERAGE).
  // Render as "n/a", never as a number — a placeholder 50 reads as a real middling score.
  totalScore: number | null;
  /** Company score before 10% sector-opportunity blend. */
  companyScore?: number | null;
  /** Calibrated peer-group sector opportunity score. */
  sectorScore?: number | null;
  valueScore: number | null;
  qualityScore: number | null;
  growthScore: number | null;
  safetyScore: number | null;
  // Fraction of each family's metric weight actually present for this ticker, [0,1].
  coverage: FamilyCoverage;
  // false → excluded from the leaderboard entirely (rank 0).
  ranked: boolean;
  rank: number;
  regime: string;
  computedAt: string;
  metricScores?: Record<string, { value: number | null; weightedScore: number }>;
  peerGroupId?: string | null;
  peerGroupName?: string | null;
  peerGroupSize?: number;
  styleBucket?: string | null;
  confidence?: "high" | "low" | null;
};

type Family = 'quality' | 'growth' | 'safety';
type Metric = {
  key: string;
  family: Family;
  weight: number;
  higherBetter: boolean;
  getValue: (r: TickerFundamentalsRow) => number | null;
};

function n(v: string | null | undefined): number | null {
  if (v == null) return null;
  const x = parseFloat(v);
  return isFinite(x) ? x : null;
}

const SCORING_METRICS: Metric[] = [
  { key: "grossMargin",     family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.grossMargin) },
  { key: "operatingMargin", family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.operatingMargin) },
  { key: "netMargin",       family: "quality", weight: 3.0, higherBetter: true,  getValue: r => n(r.netMargin) },
  { key: "roe",             family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.returnOnEquity) },
  { key: "roicWacc",        family: "quality", weight: 1.5, higherBetter: true,  getValue: r => {
    const roic = n(r.roic); const wacc = n(r.wacc);
    return roic !== null && wacc !== null ? roic - wacc : null;
  }},
  { key: "revGrowth",  family: "growth", weight: 3.0, higherBetter: true, getValue: r => n(r.revenueGrowthYoY) },
  { key: "epsGrowth",  family: "growth", weight: 3.0, higherBetter: true, getValue: r => n(r.epsGrowth) },
  { key: "currentRatio", family: "safety", weight: 1.5, higherBetter: true,  getValue: r => n(r.currentRatio) },
  { key: "debtToEquity", family: "safety", weight: 1.0, higherBetter: false, getValue: r => n(r.debtToEquity) },
  { key: "intCoverage",  family: "safety", weight: 2.5, higherBetter: true,  getValue: r => {
    const ebit = n(r.ebit); const ie = n(r.interestExpense);
    return ebit !== null && ie !== null && ie > 0 ? ebit / ie : null;
  }},
  { key: "cashRunway",   family: "safety", weight: 3.0, higherBetter: true,  getValue: r => {
    const cash = n(r.cashAndEquivalents); const ocf = n(r.quarterlyOperatingCashFlow);
    return cash !== null && ocf !== null && ocf > 0 ? cash / (ocf * 4) : null;
  }},
];

// Each regime's tilt away from the baseline is proportional to the original scheme, just
// rescaled so every row sums to exactly 100 (was 75-85 before, which made the "Why" panel's
// weight column look broken even though the score math already normalized by weightSum).
const REGIME_WEIGHTS: Record<string, Record<Family, number>> = {
  expansion:   { quality: 35, growth: 41, safety: 24 },
  late_cycle:  { quality: 44, growth: 25, safety: 31 },
  contraction: { quality: 44, growth: 19, safety: 37 },
  recession:   { quality: 35, growth: 12, safety: 53 },
  recovery:    { quality: 35, growth: 41, safety: 24 },
  stagflation: { quality: 47, growth: 13, safety: 40 },
};
const DEFAULT_WEIGHTS: Record<Family, number> = { quality: 40, growth: 35, safety: 25 };

// How much each metric's percentile leans on same-sector peers vs. the whole universe.
// Margins/leverage ratios are structurally sector-dependent (a utility's debt/equity means
// something different than a software company's), so they lean heavily sector-relative.
// Cash runway is mostly an absolute safety cushion regardless of sector, so it leans universe-wide.
const SECTOR_WEIGHT: Record<string, number> = {
  grossMargin: 0.70, operatingMargin: 0.70, netMargin: 0.65, roe: 0.55, roicWacc: 0.50,
  revGrowth: 0.60, epsGrowth: 0.55, currentRatio: 0.65, debtToEquity: 0.70, intCoverage: 0.65,
  cashRunway: 0.30,
};
const MIN_SECTOR_PEERS = 3; // below this, a sector percentile is too noisy to trust — fall back to universe-only

// Coverage gating + shrinkage constants live in fundamentals-scoring-math.ts (pure,
// unit-tested — see fundamentals-coverage.test.ts).

function percentileRanks(vals: (number | null)[], higherBetter: boolean): (number | null)[] {
  const nonNull = vals.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return vals.map(() => null);
  const sorted = [...nonNull].sort((a, b) => a - b);
  return vals.map(v => {
    if (v === null) return null;
    const idx = sorted.findIndex(s => s >= v);
    const pct = sorted.length === 1 ? 0.5 : idx / (sorted.length - 1);
    return higherBetter ? pct : 1 - pct;
  });
}

// Blends each metric's whole-universe percentile with its same-sector percentile per
// SECTOR_WEIGHT, so e.g. gross margin is judged mostly against sector peers while cash
// runway is judged mostly against the full universe.
// Within each peer group, values are winsorized at 2nd/98th before ranking (scoring guide)
// so one extreme outlier cannot dominate the cohort distribution.
function computeBlendedPctRanks(
  rows: TickerFundamentalsRow[],
  values: (number | null)[][],
  sectorByTicker: Map<string, string | null>,
): (number | null)[][] {
  const sectorGroups = new Map<string, number[]>();
  rows.forEach((row, ri) => {
    if (isExcludedEtf(row.ticker)) return;
    const sec = sectorByTicker.get(row.ticker) ?? null;
    if (sec === null) return;
    if (!sectorGroups.has(sec)) sectorGroups.set(sec, []);
    sectorGroups.get(sec)!.push(ri);
  });

  return SCORING_METRICS.map((m, mi) => {
    const vals = values[mi];
    const universePct = percentileRanks(vals, m.higherBetter);

    const sectorPct: (number | null)[] = vals.map(() => null);
    sectorGroups.forEach(indices => {
      if (indices.length < MIN_SECTOR_PEERS) return;
      const sectorVals = winsorizeValues(indices.map(ri => vals[ri]));
      const ranks = percentileRanks(sectorVals, m.higherBetter);
      indices.forEach((ri, k) => { sectorPct[ri] = ranks[k]; });
    });

    const sectorWeight = SECTOR_WEIGHT[m.key] ?? 0.5;
    return vals.map((_, ri) => {
      if (isExcludedEtf(rows[ri]!.ticker)) return null;
      const u = universePct[ri];
      if (u === null) return null;
      const s = sectorPct[ri];
      return s !== null ? s * sectorWeight + u * (1 - sectorWeight) : u;
    });
  });
}

// Per-family metric-weight coverage for each ticker, [0,1]. Shared by the compute path
// and the cached-read path so the coverage shown alongside a score always matches the
// coverage that produced it. Coverage is presence of the raw metric VALUE — the same
// basis computePerMetricScores uses, which (like it) does not apply peer-group metric
// exclusions; an excluded metric therefore reads as "present but unscored" here.
function computeCoverageByTicker(rows: TickerFundamentalsRow[]): Map<string, FamilyCoverage> {
  const FAMS: Family[] = ['quality', 'growth', 'safety'];
  const out = new Map<string, FamilyCoverage>();
  rows.forEach(row => {
    const cov: FamilyCoverage = { value: 0, quality: 0, growth: 0, safety: 0, total: 0 };
    let present = 0, total = 0;
    FAMS.forEach(fam => {
      const fm = SCORING_METRICS.filter(m => m.family === fam);
      const famTotal = fm.reduce((s, m) => s + m.weight, 0);
      const famPresent = fm.reduce((s, m) => s + (m.getValue(row) !== null ? m.weight : 0), 0);
      cov[fam] = famTotal > 0 ? parseFloat((famPresent / famTotal).toFixed(4)) : 0;
      present += famPresent;
      total   += famTotal;
    });
    cov.total = total > 0 ? parseFloat((present / total).toFixed(4)) : 0;
    out.set(row.ticker, cov);
  });
  return out;
}

const EMPTY_COVERAGE: FamilyCoverage = { value: 0, quality: 0, growth: 0, safety: 0, total: 0 };

function computePerMetricScores(
  rows: TickerFundamentalsRow[],
  familyWeights: Record<Family, number>,
  sectorByTicker: Map<string, string | null>,
): Map<string, Record<string, { value: number | null; weightedScore: number }>> {
  const values = SCORING_METRICS.map(m => rows.map(r => m.getValue(r)));
  const pctRanks = computeBlendedPctRanks(rows, values, sectorByTicker);

  const result = new Map<string, Record<string, { value: number | null; weightedScore: number }>>();
  rows.forEach((row, ri) => {
    const ms: Record<string, { value: number | null; weightedScore: number }> = {};
    SCORING_METRICS.forEach((m, mi) => {
      const pct = pctRanks[mi][ri];
      const famWeight = familyWeights[m.family];
      ms[m.key] = {
        value: values[mi][ri],
        weightedScore: pct !== null ? parseFloat((pct * m.weight * famWeight / 100).toFixed(4)) : 0,
      };
    });
    result.set(row.ticker, ms);
  });
  return result;
}

function rowToFundInput(
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
    peerGroupId,
    scoringMode,
  };
}

/** Prefer Finnhub mcap (stored in millions) → PE×EPS×shares → fwdPE×|EPS|×shares. */
function enrichMarketCap(
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

async function loadHistoryByTicker(tickers: string[]): Promise<HistoryByTicker> {
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

async function loadSurprisesByTicker(tickers: string[]): Promise<Record<string, number | null>> {
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

// Compute cross-sectional fundamental scores for all tickers in DB and persist them.
export async function computeAndPersistFundamentalScores(regime: string | null): Promise<FundScoreResult[]> {
  const rows = await getAllFundamentalsRows();
  if (rows.length === 0) return [];

  const scoreRows = rows.filter(r => !isExcludedEtf(r.ticker));
  if (scoreRows.length === 0) return [];

  const tickers = scoreRows.map(r => r.ticker);
  const regRows = await db
    .select({
      ticker: tickerRegistry.ticker,
      primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
    })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, tickers));
  const peerGroupByTicker = new Map(regRows.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
  const uniqueGroupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const groupRows = uniqueGroupIds.length > 0
    ? await db.select({
        id: peerGroups.id,
        name: peerGroups.name,
        scoringMode: peerGroups.scoringMode,
        metricExclusions: peerGroups.metricExclusions,
      }).from(peerGroups).where(inArray(peerGroups.id, uniqueGroupIds))
    : [];
  const nameByGroup = new Map(groupRows.map(g => [g.id, g.name]));
  const modeByGroup = new Map(groupRows.map(g => [g.id, g.scoringMode ?? null]));
  const groupSizeById = new Map<string, number>();
  regRows.forEach(r => {
    if (!r.primaryPeerGroupId) return;
    groupSizeById.set(r.primaryPeerGroupId, (groupSizeById.get(r.primaryPeerGroupId) ?? 0) + 1);
  });

  // Finnhub mcap (millions) preferred for sector-layer size + megacap gates
  const finnhubRows = await db
    .select({
      ticker: finnhubFundamentals.ticker,
      mcap: finnhubFundamentals.finnhubMarketCap,
    })
    .from(finnhubFundamentals)
    .where(inArray(finnhubFundamentals.ticker, tickers));
  const finnhubMcapByTicker = new Map<string, number>();
  for (const r of finnhubRows) {
    const m = parseNum(r.mcap);
    if (m != null && m > 0) finnhubMcapByTicker.set(r.ticker, m);
  }

  const inputs: FundRowInput[] = scoreRows.map(row => {
    const gid = peerGroupByTicker.get(row.ticker) ?? null;
    const mode = gid ? (modeByGroup.get(gid) ?? null) : null;
    return enrichMarketCap(rowToFundInput(row, gid, mode), row, finnhubMcapByTicker.get(row.ticker));
  });

  const [history, surprises] = await Promise.all([
    loadHistoryByTicker(tickers),
    loadSurprisesByTicker(tickers),
  ]);

  const scored = withRanks(scoreUniverse(inputs, history, surprises));
  const computedAt = new Date();

  const results: FundScoreResult[] = scored.map(s => ({
    ticker: s.ticker,
    totalScore: s.totalScore,
    companyScore: s.companyScore,
    sectorScore: s.sectorScore,
    valueScore: s.valueScore,
    qualityScore: s.qualityScore,
    growthScore: s.growthScore,
    safetyScore: s.safetyScore,
    coverage: s.coverage,
    ranked: s.ranked,
    rank: s.rank,
    regime: regime ?? "unknown",
    computedAt: computedAt.toISOString(),
    metricScores: Object.fromEntries(
      Object.entries(s.metricScores).map(([k, v]) => [k, { value: v.value, weightedScore: v.weightedScore }]),
    ),
    peerGroupId: s.peerGroupId,
    peerGroupName: s.peerGroupId ? (nameByGroup.get(s.peerGroupId) ?? null) : null,
    peerGroupSize: s.peerGroupId ? (groupSizeById.get(s.peerGroupId) ?? s.peerGroupSize) : s.peerGroupSize,
    styleBucket: s.styleBucket,
    confidence: s.confidence,
  }));

  await db.insert(tickerFundamentals)
    .values(results.map(r => ({
      ticker: r.ticker,
      fundTotalScore: r.totalScore != null ? String(r.totalScore) : null,
      fundCompanyScore: r.companyScore != null ? String(r.companyScore) : null,
      fundSectorScore: r.sectorScore != null ? String(r.sectorScore) : null,
      fundValueScore: r.valueScore != null ? String(r.valueScore) : null,
      fundQualityScore: r.qualityScore != null ? String(r.qualityScore) : null,
      fundGrowthScore: r.growthScore != null ? String(r.growthScore) : null,
      fundSafetyScore: r.safetyScore != null ? String(r.safetyScore) : null,
      fundRank: r.rank,
      fundScoreComputedAt: computedAt,
      regimeAtScore: regime ?? null,
      styleBucket: r.styleBucket ?? null,
      fundScoreConfidence: r.confidence ?? null,
    })))
    .onConflictDoUpdate({
      target: tickerFundamentals.ticker,
      set: {
        fundTotalScore: sql`excluded.fund_total_score`,
        fundCompanyScore: sql`excluded.fund_company_score`,
        fundSectorScore: sql`excluded.fund_sector_score`,
        fundValueScore: sql`excluded.fund_value_score`,
        fundQualityScore: sql`excluded.fund_quality_score`,
        fundGrowthScore: sql`excluded.fund_growth_score`,
        fundSafetyScore: sql`excluded.fund_safety_score`,
        fundRank: sql`excluded.fund_rank`,
        fundScoreComputedAt: sql`excluded.fund_score_computed_at`,
        regimeAtScore: sql`excluded.regime_at_score`,
        styleBucket: sql`excluded.style_bucket`,
        fundScoreConfidence: sql`excluded.fund_score_confidence`,
      },
    });

  logger.info({ count: results.length, regime }, "fundamental scores computed and persisted (v2 + sector layer)");
  return results;
}

const SCORE_STALE_HOURS = 48;

// Read persisted scores from DB. Returns null if scores are absent or stale.
export async function readPersistedScores(currentRegime: string | null): Promise<FundScoreResult[] | null> {
  const rows = await db
    .select({
      ticker: tickerFundamentals.ticker,
      fundTotalScore: tickerFundamentals.fundTotalScore,
      fundCompanyScore: tickerFundamentals.fundCompanyScore,
      fundSectorScore: tickerFundamentals.fundSectorScore,
      fundValueScore: tickerFundamentals.fundValueScore,
      fundQualityScore: tickerFundamentals.fundQualityScore,
      fundGrowthScore: tickerFundamentals.fundGrowthScore,
      fundSafetyScore: tickerFundamentals.fundSafetyScore,
      fundRank: tickerFundamentals.fundRank,
      regimeAtScore: tickerFundamentals.regimeAtScore,
      fundScoreComputedAt: tickerFundamentals.fundScoreComputedAt,
      styleBucket: tickerFundamentals.styleBucket,
      fundScoreConfidence: tickerFundamentals.fundScoreConfidence,
    })
    .from(tickerFundamentals);

  if (rows.length === 0) return null;
  if (rows.some(r => r.fundScoreComputedAt == null)) return null;

  const oldest = rows.reduce((min, r) => {
    const t = r.fundScoreComputedAt!.getTime();
    return t < min ? t : min;
  }, Infinity);
  const staleMs = SCORE_STALE_HOURS * 60 * 60 * 1000;
  if (Date.now() - oldest > staleMs) return null;
  if (currentRegime && rows.some(r => r.regimeAtScore !== currentRegime)) return null;

  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, rows.map(r => r.ticker)));
  const peerGroupByTicker = new Map(regRows.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
  const uniqueGroupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const groupNameRows = uniqueGroupIds.length > 0
    ? await db.select({ id: peerGroups.id, name: peerGroups.name })
        .from(peerGroups).where(inArray(peerGroups.id, uniqueGroupIds))
    : [];
  const nameByGroup = new Map(groupNameRows.map(g => [g.id, g.name]));
  const groupSizeById = new Map<string, number>();
  regRows.forEach(r => {
    if (!r.primaryPeerGroupId) return;
    groupSizeById.set(r.primaryPeerGroupId, (groupSizeById.get(r.primaryPeerGroupId) ?? 0) + 1);
  });

  const numOrNull = (v: string | null | undefined) => (v == null ? null : parseFloat(v));
  const emptyCov: FamilyCoverage = { value: 0, quality: 0, growth: 0, safety: 0, total: 0 };

  return rows.map(r => ({
    ticker: r.ticker,
    totalScore: numOrNull(r.fundTotalScore),
    companyScore: numOrNull(r.fundCompanyScore),
    sectorScore: numOrNull(r.fundSectorScore),
    valueScore: numOrNull(r.fundValueScore),
    qualityScore: numOrNull(r.fundQualityScore),
    growthScore: numOrNull(r.fundGrowthScore),
    safetyScore: numOrNull(r.fundSafetyScore),
    coverage: emptyCov,
    ranked: r.fundTotalScore != null && (r.fundRank ?? 0) > 0,
    rank: r.fundRank ?? 0,
    regime: r.regimeAtScore ?? currentRegime ?? "unknown",
    computedAt: r.fundScoreComputedAt!.toISOString(),
    peerGroupId: peerGroupByTicker.get(r.ticker) ?? null,
    peerGroupName: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (nameByGroup.get(gid) ?? null) : null;
    })(),
    peerGroupSize: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (groupSizeById.get(gid) ?? 0) : 0;
    })(),
    styleBucket: r.styleBucket ?? null,
    confidence: (r.fundScoreConfidence as "high" | "low" | null) ?? null,
  }));
}
