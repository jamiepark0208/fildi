import { eq, sql, inArray } from "drizzle-orm";
import {
  db, tickerFundamentals, tickerRegistry, peerGroups, finnhubFundamentals,
  type TickerFundamentalsRow, type TickerRegistryRow,
  peerGroupOverrides, peerGroupMembers,
} from "@workspace/db";
import { recordApiUsage } from "./api-usage.js";
import type { FMPFundamentalsData } from "./fmp-client.js";
import { logger } from "./logger.js";
import { isExcludedEtf } from "./etf-exclusions.js";
import {
  FMP_MAX_DAILY_CALLS,
  STALE_DAYS as DATA_OPS_STALE_DAYS,
} from "./data-ops-config.js";
import {
  scoreUniverse, withRanks, METRICS, missingDefaultOptionals, type FundRowInput,
  type ScoreUniverseParams,
} from "./fund-score-engine.js";
import { getChampionScorecardParams } from "./scorecard-params.js";
import { num as parseNum } from "./fund-derived-metrics.js";
import {
  upsertFundScoreSnapshots,
  pickTopMetrics,
  type ScoreTrigger,
} from "./fund-score-snapshots.js";
import {
  rowToFundInput, enrichMarketCap, loadHistoryByTicker, loadSurprisesByTicker, loadIbesSignalsByTicker,
} from "./fund-score-inputs.js";
import { attachPeerReviewed, peerReviewedKey } from "./fund-score-peer-reviewed.js";

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

// Compute cross-sectional fundamental scores for all tickers in DB and persist them.
const METRIC_FAMILY: Record<string, string> = Object.fromEntries(
  METRICS.map((m) => [m.key, m.family]),
);

export async function computeAndPersistFundamentalScores(
  regime: string | null,
  trigger: ScoreTrigger = "admin_recompute",
  /** Before/after tooling (scripts/compare-fund-params.ts): score with these params and/or skip all writes. */
  opts?: { paramsOverride?: { version: string; params: Record<string, unknown> }; dryRun?: boolean; peerReference?: boolean },
): Promise<FundScoreResult[]> {
  const rows = await getAllFundamentalsRows();
  if (rows.length === 0) return [];

  // Live book only — delisted/renamed (SQ, ADYEN, …) stay in TF history but must not
  // enter peer norms, group sizes, or the leaderboard.
  const liveRegs = await db
    .select({
      ticker: tickerRegistry.ticker,
      primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
    })
    .from(tickerRegistry)
    .where(sql`${tickerRegistry.isActive} = true AND ${tickerRegistry.fetchFundamentals} = true`);
  const liveSet = new Set(liveRegs.map((r) => r.ticker));

  const scoreRows = rows.filter((r) => !isExcludedEtf(r.ticker) && liveSet.has(r.ticker));
  if (scoreRows.length === 0) return [];

  const tickers = scoreRows.map(r => r.ticker);
  const regRows = liveRegs.filter((r) => tickers.includes(r.ticker));
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

  // A148: an override may pin a scoring mode across a group move (ZTO/TCOM keep 'chinese').
  const modeOverrideRows = await db.select({ ticker: peerGroupOverrides.ticker, mode: peerGroupOverrides.scoringMode })
    .from(peerGroupOverrides).where(inArray(peerGroupOverrides.ticker, tickers));
  const modeByTicker = new Map(modeOverrideRows.filter(r => r.mode).map(r => [r.ticker, r.mode as string]));

  // 10-27: reviewed mapping = seed taxonomy, manual, override, or scripts/watchlist_sync/peer_verify.py ('verified').
  // Auto-classified names are scored but don't set the cohort norms (fund-score-engine).
  // Must stay above inputs map (A285): map runs sync; reviewed* after map = TDZ crash.
  const reviewedRows = opts?.peerReference === false ? null : await db
    .select({ ticker: peerGroupMembers.ticker, groupId: peerGroupMembers.groupId })
    .from(peerGroupMembers)
    .where(sql`${peerGroupMembers.removedAt} IS NULL AND ${peerGroupMembers.source} IN ('taxonomy', 'manual', 'verified')`);
  const reviewed = new Set((reviewedRows ?? []).map(r => peerReviewedKey(r.ticker, r.groupId)));
  for (const r of modeOverrideRows) reviewed.add(peerReviewedKey(r.ticker, peerGroupByTicker.get(r.ticker) ?? null));

  const peerReferenceOn = reviewedRows != null;
  const inputs: FundRowInput[] = scoreRows.map(row => {
    const gid = peerGroupByTicker.get(row.ticker) ?? null;
    const mode = modeByTicker.get(row.ticker) ?? (gid ? (modeByGroup.get(gid) ?? null) : null);
    const input = enrichMarketCap(rowToFundInput(row, gid, mode), row, finnhubMcapByTicker.get(row.ticker));
    return attachPeerReviewed(input, peerReferenceOn, reviewed, row.ticker, gid);
  });

  const [history, surprises, ibesSignals, fundChamp] = await Promise.all([
    loadHistoryByTicker(tickers),
    loadSurprisesByTicker(tickers),
    loadIbesSignalsByTicker(tickers),
    opts?.paramsOverride ? Promise.resolve(opts.paramsOverride) : getChampionScorecardParams("fund"),
  ]);

  const fundParams: ScoreUniverseParams = {
    metricBaseIntra: fundChamp.params.metricBaseIntra as ScoreUniverseParams["metricBaseIntra"],
    styleFamilyWeights: fundChamp.params.styleFamilyWeights as ScoreUniverseParams["styleFamilyWeights"],
    megacapBlendFamilyWeights: fundChamp.params
      .megacapBlendFamilyWeights as ScoreUniverseParams["megacapBlendFamilyWeights"],
    totalMinCoverage:
      typeof fundChamp.params.totalMinCoverage === "number"
        ? fundChamp.params.totalMinCoverage
        : undefined,
    familyMinCoverage:
      typeof fundChamp.params.familyMinCoverage === "number"
        ? fundChamp.params.familyMinCoverage
        : undefined,
    optionalMetrics: Array.isArray(fundChamp.params.optionalMetrics)
      ? (fundChamp.params.optionalMetrics as ScoreUniverseParams["optionalMetrics"])
      : undefined,
  };
  const droppedOptionals = missingDefaultOptionals(fundParams.optionalMetrics);
  if (droppedOptionals.length > 0) {
    logger.warn(
      { version: fundChamp.version, droppedOptionals },
      "fund params optionalMetrics omits code-default optional metrics — they are required (coverage shrinks when missing)",
    );
  }
  const scored = withRanks(scoreUniverse(inputs, history, surprises, ibesSignals, fundParams));
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

  if (opts?.dryRun) return results;

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

  // Append/upsert daily history for Breakdown accountability chart
  try {
    const champ = fundChamp;
    const snapCount = await upsertFundScoreSnapshots(
      scored.map((s) => ({
        ticker: s.ticker,
        fundTotal: s.totalScore,
        fundValue: s.valueScore,
        fundGrowth: s.growthScore,
        fundQuality: s.qualityScore,
        fundSafety: s.safetyScore,
        styleBucket: s.styleBucket,
        coverage: s.coverage?.total ?? null,
        confidence: s.confidence,
        peerGroupId: s.peerGroupId,
        topMetrics: pickTopMetrics(
          Object.fromEntries(
            Object.entries(s.metricScores).map(([k, v]) => [
              k,
              { value: v.value, peerNorm: v.peerNorm, weightedScore: v.weightedScore },
            ]),
          ),
          METRIC_FAMILY,
          40,
        ),
        trigger,
        asOf: computedAt,
        modelVersion: champ.version,
        inputsDigest: null,
      })),
    );
    logger.info({ count: results.length, snapCount, regime, trigger, modelVersion: champ.version }, "fundamental scores + snapshots persisted");
  } catch (err) {
    logger.warn({ err: String(err) }, "fund_score_snapshots upsert failed (scores still persisted)");
  }

  // Blended fair value uses the same gold inputs + peer groups, so refresh it on every recompute
  // (nightly, Maintain post-merge-scores, peer overrides, admin). Never blocks scores.
  try {
    const { persistFairValueSnapshots } = await import("./fair-value-snapshots.js");
    await persistFairValueSnapshots({ trigger });
  } catch (err) {
    logger.warn({ err: String(err) }, "fair_value_snapshots persist failed (scores still persisted)");
  }

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

  // Unscored rows (e.g. ETF SCHD just added — no fund_score_computed_at) must not
  // invalidate the whole board. Old all-null / any-null check forced a full
  // computeAndPersist on every /fundamentals/rankings hit (~1s + 1.5MB).
  const scored = rows.filter((r) => r.fundScoreComputedAt != null);
  if (scored.length === 0) return null;

  // Freshness = last successful batch (newest), not the oldest orphan row.
  const newest = scored.reduce((max, r) => {
    const t = r.fundScoreComputedAt!.getTime();
    return t > max ? t : max;
  }, 0);
  const staleMs = SCORE_STALE_HOURS * 60 * 60 * 1000;
  if (Date.now() - newest > staleMs) return null;

  // Serve the latest batch only (within 2h of newest) so stale orphans left after
  // universe churn don't trip the regime check or pollute ranks.
  const batchMs = 2 * 60 * 60 * 1000;
  const batch = scored.filter((r) => newest - r.fundScoreComputedAt!.getTime() <= batchMs);
  if (currentRegime && batch.some((r) => r.regimeAtScore !== currentRegime)) return null;

  const regRows = await db
    .select({
      ticker: tickerRegistry.ticker,
      primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
      isActive: tickerRegistry.isActive,
      fetchFundamentals: tickerRegistry.fetchFundamentals,
    })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, batch.map(r => r.ticker)));
  const liveRegs = regRows.filter((r) => r.isActive && r.fetchFundamentals);
  const liveSet = new Set(liveRegs.map((r) => r.ticker));
  const liveBatch = batch.filter((r) => liveSet.has(r.ticker));
  const peerGroupByTicker = new Map(liveRegs.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
  const uniqueGroupIds = [...new Set(liveRegs.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const groupNameRows = uniqueGroupIds.length > 0
    ? await db.select({ id: peerGroups.id, name: peerGroups.name })
        .from(peerGroups).where(inArray(peerGroups.id, uniqueGroupIds))
    : [];
  const nameByGroup = new Map(groupNameRows.map(g => [g.id, g.name]));
  const groupSizeById = new Map<string, number>();
  liveRegs.forEach(r => {
    if (!r.primaryPeerGroupId) return;
    groupSizeById.set(r.primaryPeerGroupId, (groupSizeById.get(r.primaryPeerGroupId) ?? 0) + 1);
  });

  const numOrNull = (v: string | null | undefined) => (v == null ? null : parseFloat(v));
  const emptyCov: FamilyCoverage = { value: 0, quality: 0, growth: 0, safety: 0, total: 0 };

  return liveBatch.map(r => ({
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
