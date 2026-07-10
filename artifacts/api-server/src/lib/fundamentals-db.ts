import { eq, isNull, or, lt, sql, inArray } from "drizzle-orm";
import { db, tickerFundamentals, tickerRegistry, peerGroups, fmpApiUsage, type TickerFundamentalsRow, type TickerRegistryRow } from "@workspace/db";
import { recordApiUsage, checkDailyBudget } from "./api-usage.js";
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
      sql`${tickerFundamentals.ticker} = ANY(${normalized}) AND ${tickerFundamentals.fundamentalsLastFetched} > ${cutoff}`,
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
// Free tier limit: ~250 calls/day. Each ticker refresh = 7 endpoints.
// MAX_DAILY_CALLS set conservatively at 220 to leave headroom.

const MAX_DAILY_CALLS = 220;
const CALLS_PER_TICKER = 7;

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

export type FundScoreResult = {
  ticker: string;
  totalScore: number;
  qualityScore: number;
  growthScore: number;
  safetyScore: number;
  rank: number;
  regime: string;
  computedAt: string;
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

const REGIME_WEIGHTS: Record<string, Record<Family, number>> = {
  expansion:   { quality: 30, growth: 35, safety: 20 },
  late_cycle:  { quality: 35, growth: 20, safety: 25 },
  contraction: { quality: 35, growth: 15, safety: 30 },
  recession:   { quality: 30, growth: 10, safety: 45 },
  recovery:    { quality: 30, growth: 35, safety: 20 },
  stagflation: { quality: 35, growth: 10, safety: 30 },
};
const DEFAULT_WEIGHTS: Record<Family, number> = { quality: 35, growth: 25, safety: 20 };

// Compute cross-sectional fundamental scores for all tickers in DB and persist them.
// Must be called with the current macro regime so score weights are applied correctly.
export async function computeAndPersistFundamentalScores(regime: string | null): Promise<FundScoreResult[]> {
  const rows = await getAllFundamentalsRows();
  if (rows.length === 0) return [];

  const familyWeights: Record<Family, number> =
    (regime && REGIME_WEIGHTS[regime]) ? REGIME_WEIGHTS[regime] : DEFAULT_WEIGHTS;

  // Load peer group metric exclusions
  const tickers = rows.map(r => r.ticker);
  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, tickers));
  const peerGroupByTicker = new Map(regRows.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
  const uniqueGroupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const groupExclusionRows = uniqueGroupIds.length > 0
    ? await db.select({ id: peerGroups.id, metricExclusions: peerGroups.metricExclusions })
        .from(peerGroups).where(inArray(peerGroups.id, uniqueGroupIds))
    : [];
  const exclusionsByGroup = new Map(groupExclusionRows.map(g => [g.id, new Set(g.metricExclusions ?? [])]));

  // Raw metric values with peer-group exclusions and ROE structural null applied
  const values = SCORING_METRICS.map(m => rows.map(r => m.getValue(r)));
  rows.forEach((row, ri) => {
    const groupId = peerGroupByTicker.get(row.ticker);
    const excl = groupId ? (exclusionsByGroup.get(groupId) ?? new Set<string>()) : new Set<string>();
    SCORING_METRICS.forEach((m, mi) => {
      if (excl.has(m.key)) { values[mi][ri] = null; return; }
      if (m.key === "roe" && row.totalStockholdersEquity !== null && row.netIncome !== null) {
        const eq_ = parseFloat(row.totalStockholdersEquity ?? "");
        const ni  = parseFloat(row.netIncome ?? "");
        if (isFinite(eq_) && isFinite(ni) && eq_ < 0 && ni > 0) values[mi][ri] = null;
      }
    });
  });

  // Percentile ranks per metric
  const pctRanks: (number | null)[][] = SCORING_METRICS.map((m, mi) => {
    const vals = values[mi];
    const nonNull = vals.filter(v => v !== null) as number[];
    if (nonNull.length === 0) return vals.map(() => null);
    const sorted = [...nonNull].sort((a, b) => a - b);
    return vals.map(v => {
      if (v === null) return null;
      const idx = sorted.findIndex(s => s >= v);
      const pct = sorted.length === 1 ? 0.5 : idx / (sorted.length - 1);
      return m.higherBetter ? pct : 1 - pct;
    });
  });

  const FAMILIES: Family[] = ['quality', 'growth', 'safety'];
  const computedAt = new Date();

  const rawResults = rows.map((row, ri) => {
    const familyScores: Record<Family, number> = { quality: 50, growth: 50, safety: 50 };
    let totalNum = 0, totalDen = 0;
    FAMILIES.forEach(fam => {
      const famMetrics = SCORING_METRICS.map((m, mi) => ({ m, mi })).filter(({ m }) => m.family === fam);
      let famNum = 0, famDen = 0;
      famMetrics.forEach(({ m, mi }) => {
        const pct = pctRanks[mi][ri];
        if (pct !== null) { famNum += pct * m.weight; famDen += m.weight; }
      });
      if (famDen > 0) {
        familyScores[fam] = (famNum / famDen) * 100;
        totalNum += (famNum / famDen) * familyWeights[fam];
        totalDen += familyWeights[fam];
      }
    });
    return {
      ticker: row.ticker,
      totalScore: parseFloat((totalDen > 0 ? (totalNum / totalDen) * 100 : 0).toFixed(2)),
      qualityScore: parseFloat(familyScores.quality.toFixed(2)),
      growthScore:  parseFloat(familyScores.growth.toFixed(2)),
      safetyScore:  parseFloat(familyScores.safety.toFixed(2)),
    };
  });

  // Rank by totalScore descending (1 = best)
  const sorted = [...rawResults].sort((a, b) => b.totalScore - a.totalScore);
  const rankMap = new Map(sorted.map((r, i) => [r.ticker, i + 1]));

  const results: FundScoreResult[] = rawResults.map(r => ({
    ...r,
    rank: rankMap.get(r.ticker) ?? 0,
    regime: regime ?? "unknown",
    computedAt: computedAt.toISOString(),
  }));

  // Persist scores back to DB — single batch upsert instead of one UPDATE per ticker
  await db.insert(tickerFundamentals)
    .values(results.map(r => ({
      ticker:              r.ticker,
      fundTotalScore:      String(r.totalScore),
      fundQualityScore:    String(r.qualityScore),
      fundGrowthScore:     String(r.growthScore),
      fundSafetyScore:     String(r.safetyScore),
      fundRank:            r.rank,
      fundScoreComputedAt: computedAt,
    })))
    .onConflictDoUpdate({
      target: tickerFundamentals.ticker,
      set: {
        fundTotalScore:      sql`excluded.fund_total_score`,
        fundQualityScore:    sql`excluded.fund_quality_score`,
        fundGrowthScore:     sql`excluded.fund_growth_score`,
        fundSafetyScore:     sql`excluded.fund_safety_score`,
        fundRank:            sql`excluded.fund_rank`,
        fundScoreComputedAt: sql`excluded.fund_score_computed_at`,
      },
    });

  logger.info({ count: results.length, regime }, "fundamental scores computed and persisted");
  return results;
}

const SCORE_STALE_HOURS = 48;

// Read persisted scores from DB. Returns null if scores are absent or stale.
export async function readPersistedScores(currentRegime: string | null): Promise<FundScoreResult[] | null> {
  const rows = await db
    .select({
      ticker:          tickerFundamentals.ticker,
      fundTotalScore:  tickerFundamentals.fundTotalScore,
      fundQualityScore: tickerFundamentals.fundQualityScore,
      fundGrowthScore: tickerFundamentals.fundGrowthScore,
      fundSafetyScore: tickerFundamentals.fundSafetyScore,
      fundRank:        tickerFundamentals.fundRank,
      regimeAtScore:   tickerFundamentals.regimeAtScore,
      fundScoreComputedAt: tickerFundamentals.fundScoreComputedAt,
    })
    .from(tickerFundamentals);

  if (rows.length === 0) return null;

  const anyNull = rows.some(r => r.fundTotalScore == null || r.fundScoreComputedAt == null);
  if (anyNull) return null;

  // Stale if oldest score is >48h old or regime changed
  const oldest = rows.reduce((min, r) => {
    const t = r.fundScoreComputedAt!.getTime();
    return t < min ? t : min;
  }, Infinity);
  const staleMs = SCORE_STALE_HOURS * 60 * 60 * 1000;
  if (Date.now() - oldest > staleMs) return null;
  if (currentRegime && rows.some(r => r.regimeAtScore !== currentRegime)) return null;

  return rows.map(r => ({
    ticker:       r.ticker,
    totalScore:   parseFloat(r.fundTotalScore!),
    qualityScore: parseFloat(r.fundQualityScore ?? "50"),
    growthScore:  parseFloat(r.fundGrowthScore  ?? "50"),
    safetyScore:  parseFloat(r.fundSafetyScore  ?? "50"),
    rank:         r.fundRank ?? 0,
    regime:       r.regimeAtScore ?? currentRegime ?? "unknown",
    computedAt:   r.fundScoreComputedAt!.toISOString(),
  }));
}
