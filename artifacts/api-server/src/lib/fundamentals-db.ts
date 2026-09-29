import { eq, isNull, or, lt, sql, inArray } from "drizzle-orm";
import { db, tickerFundamentals, tickerRegistry, peerGroups, fmpApiUsage, type TickerFundamentalsRow, type TickerRegistryRow } from "@workspace/db";
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

export type FamilyCoverage = { quality: number; growth: number; safety: number; total: number };

export type FundScoreResult = {
  ticker: string;
  // null = not enough data to score honestly (see FAMILY_MIN_COVERAGE / TOTAL_MIN_COVERAGE).
  // Render as "n/a", never as a number — a placeholder 50 reads as a real middling score.
  totalScore: number | null;
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
    const cov: FamilyCoverage = { quality: 0, growth: 0, safety: 0, total: 0 };
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

const EMPTY_COVERAGE: FamilyCoverage = { quality: 0, growth: 0, safety: 0, total: 0 };

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

// Compute cross-sectional fundamental scores for all tickers in DB and persist them.
// Must be called with the current macro regime so score weights are applied correctly.
export async function computeAndPersistFundamentalScores(regime: string | null): Promise<FundScoreResult[]> {
  const rows = await getAllFundamentalsRows();
  if (rows.length === 0) return [];

  const familyWeights: Record<Family, number> =
    (regime && REGIME_WEIGHTS[regime]) ? REGIME_WEIGHTS[regime] : DEFAULT_WEIGHTS;

  // Load peer group metric exclusions + peer group (for sector-relative percentiles).
  // primaryPeerGroupId (e.g. "technology.semiconductors_design") is populated for 273/276
  // tickers via the curated sector_taxonomy.json import — tickerRegistry.sector itself is
  // only set for ~17, so peer group is the field to group by, not the flat sector column.
  const tickers = rows.map(r => r.ticker).filter(t => !isExcludedEtf(t));
  // Exclude ETFs from the scoring universe entirely (no peer percentiles, no leaderboard).
  const scoreRows = rows.filter(r => !isExcludedEtf(r.ticker));
  if (scoreRows.length === 0) return [];

  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, tickers));
  const peerGroupByTicker = new Map(regRows.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
  const uniqueGroupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const groupExclusionRows = uniqueGroupIds.length > 0
    ? await db.select({ id: peerGroups.id, name: peerGroups.name, metricExclusions: peerGroups.metricExclusions })
        .from(peerGroups).where(inArray(peerGroups.id, uniqueGroupIds))
    : [];
  const exclusionsByGroup = new Map(groupExclusionRows.map(g => [g.id, new Set(g.metricExclusions ?? [])]));
  const nameByGroup = new Map(groupExclusionRows.map(g => [g.id, g.name]));
  const groupSizeById = new Map<string, number>();
  regRows.forEach(r => {
    if (!r.primaryPeerGroupId) return;
    groupSizeById.set(r.primaryPeerGroupId, (groupSizeById.get(r.primaryPeerGroupId) ?? 0) + 1);
  });

  // Raw metric values with peer-group exclusions and ROE structural null applied
  const values = SCORING_METRICS.map(m => scoreRows.map(r => m.getValue(r)));
  scoreRows.forEach((row, ri) => {
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

  // Percentile ranks per metric (blended universe-wide + peer-group-relative, see SECTOR_WEIGHT)
  const pctRanks = computeBlendedPctRanks(scoreRows, values, peerGroupByTicker);

  const FAMILIES: Family[] = ['quality', 'growth', 'safety'];
  const computedAt = new Date();

  const round2 = (v: number) => parseFloat(v.toFixed(2));

  const rawResults = scoreRows.map((row, ri) => {
    const familyScores: Record<Family, number | null> = { quality: null, growth: null, safety: null };
    const familyCoverage: Record<Family, number> = { quality: 0, growth: 0, safety: 0 };
    let totalNum = 0, totalDen = 0;
    let weightPresent = 0, weightTotal = 0;

    FAMILIES.forEach(fam => {
      const famMetrics = SCORING_METRICS.map((m, mi) => ({ m, mi })).filter(({ m }) => m.family === fam);
      const famWeightTotal = famMetrics.reduce((s, { m }) => s + m.weight, 0);
      let famNum = 0, famDen = 0;
      famMetrics.forEach(({ m, mi }) => {
        const pct = pctRanks[mi][ri];
        if (pct !== null) { famNum += pct * m.weight; famDen += m.weight; }
      });

      weightPresent += famDen;
      weightTotal   += famWeightTotal;

      const coverage = famWeightTotal > 0 ? famDen / famWeightTotal : 0;
      familyCoverage[fam] = parseFloat(coverage.toFixed(4));

      // Too thin to be worth a number at all — stays null and contributes nothing
      // to the total (rather than silently voting with a placeholder 50).
      if (famDen === 0) return;
      const shrunk = shrinkToNeutral((famNum / famDen) * 100, coverage);
      if (shrunk === null) return;
      familyScores[fam] = shrunk;
      totalNum += shrunk * familyWeights[fam];
      totalDen += familyWeights[fam];
    });

    const totalCoverage = weightTotal > 0 ? weightPresent / weightTotal : 0;
    const ranked = totalCoverage >= TOTAL_MIN_COVERAGE && totalDen > 0;

    return {
      ticker: row.ticker,
      totalScore:   ranked ? round2(totalNum / totalDen) : null,
      qualityScore: familyScores.quality !== null ? round2(familyScores.quality) : null,
      growthScore:  familyScores.growth  !== null ? round2(familyScores.growth)  : null,
      safetyScore:  familyScores.safety  !== null ? round2(familyScores.safety)  : null,
      coverage: { ...familyCoverage, total: parseFloat(totalCoverage.toFixed(4)) },
      ranked,
    };
  });

  // Rank by totalScore descending (1 = best). Unranked tickers (insufficient coverage)
  // are excluded from the ordering entirely and carry rank 0 — they must not occupy a
  // leaderboard slot on the strength of one or two metrics.
  const sorted = rawResults
    .filter(r => r.ranked && r.totalScore !== null)
    .sort((a, b) => (b.totalScore as number) - (a.totalScore as number));
  const rankMap = new Map(sorted.map((r, i) => [r.ticker, i + 1]));

  const perMetric = computePerMetricScores(scoreRows, familyWeights, peerGroupByTicker);

  const results: FundScoreResult[] = rawResults.map(r => ({
    ...r,
    rank: rankMap.get(r.ticker) ?? 0,
    regime: regime ?? "unknown",
    computedAt: computedAt.toISOString(),
    metricScores: perMetric.get(r.ticker),
    peerGroupId: peerGroupByTicker.get(r.ticker) ?? null,
    peerGroupName: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (nameByGroup.get(gid) ?? null) : null;
    })(),
    peerGroupSize: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (groupSizeById.get(gid) ?? 0) : 0;
    })(),
  }));

  // Persist scores back to DB — single batch upsert instead of one UPDATE per ticker
  await db.insert(tickerFundamentals)
    .values(results.map(r => ({
      ticker:              r.ticker,
      // null (insufficient coverage) must persist as SQL NULL, not the string "null".
      fundTotalScore:      r.totalScore   != null ? String(r.totalScore)   : null,
      fundQualityScore:    r.qualityScore != null ? String(r.qualityScore) : null,
      fundGrowthScore:     r.growthScore  != null ? String(r.growthScore)  : null,
      fundSafetyScore:     r.safetyScore  != null ? String(r.safetyScore)  : null,
      fundRank:            r.rank,
      fundScoreComputedAt: computedAt,
      // regime_at_score is the regime THIS SCORE was computed under — it is the key
      // readPersistedScores() compares against to decide the cache is still valid.
      // It must be written here, by the scorer. It was previously only ever written by
      // writeFundamentalsRow() (the FMP *data fetch* path, which defaults it to null),
      // so it sat NULL for 552/554 rows and the `regimeAtScore !== currentRegime`
      // staleness check below never passed — every read fell through to a full
      // cross-sectional recompute of the whole universe.
      regimeAtScore:       regime ?? null,
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
        regimeAtScore:       sql`excluded.regime_at_score`,
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

  // A NULL fundTotalScore is now a legitimate, intentional result (insufficient
  // coverage — see FAMILY_MIN_COVERAGE), so it must NOT invalidate the whole cache.
  // Only a missing computedAt means "this row was never scored".
  if (rows.some(r => r.fundScoreComputedAt == null)) return null;

  // Stale if oldest score is >48h old or regime changed
  const oldest = rows.reduce((min, r) => {
    const t = r.fundScoreComputedAt!.getTime();
    return t < min ? t : min;
  }, Infinity);
  const staleMs = SCORE_STALE_HOURS * 60 * 60 * 1000;
  if (Date.now() - oldest > staleMs) return null;
  if (currentRegime && rows.some(r => r.regimeAtScore !== currentRegime)) return null;

  const rawRows = await getAllFundamentalsRows();
  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, rawRows.map(r => r.ticker)));
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
  const familyWeights: Record<Family, number> =
    (currentRegime && REGIME_WEIGHTS[currentRegime]) ? REGIME_WEIGHTS[currentRegime] : DEFAULT_WEIGHTS;
  const perMetric = computePerMetricScores(rawRows, familyWeights, peerGroupByTicker);
  const coverageByTicker = computeCoverageByTicker(rawRows);

  // A persisted NULL means "insufficient coverage to score" and must stay null all the
  // way to the UI. The old `?? "50"` turned that into a real-looking middling score.
  const numOrNull = (v: string | null) => (v == null ? null : parseFloat(v));

  return rows.map(r => ({
    ticker:       r.ticker,
    totalScore:   numOrNull(r.fundTotalScore),
    qualityScore: numOrNull(r.fundQualityScore),
    growthScore:  numOrNull(r.fundGrowthScore),
    safetyScore:  numOrNull(r.fundSafetyScore),
    coverage:     coverageByTicker.get(r.ticker) ?? EMPTY_COVERAGE,
    ranked:       r.fundTotalScore != null && (r.fundRank ?? 0) > 0,
    rank:         r.fundRank ?? 0,
    regime:       r.regimeAtScore ?? currentRegime ?? "unknown",
    computedAt:   r.fundScoreComputedAt!.toISOString(),
    metricScores: perMetric.get(r.ticker),
    peerGroupId:  peerGroupByTicker.get(r.ticker) ?? null,
    peerGroupName: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (nameByGroup.get(gid) ?? null) : null;
    })(),
    peerGroupSize: (() => {
      const gid = peerGroupByTicker.get(r.ticker);
      return gid ? (groupSizeById.get(gid) ?? 0) : 0;
    })(),
  }));
}
