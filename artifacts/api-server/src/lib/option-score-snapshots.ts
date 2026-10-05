/**
 * Nightly Overall options rankings: premium-rich DB filter → Yahoo chains →
 * pickBestStrike → persist option_score_snapshots.
 * UI Overall tab uses the same live scanner path as Watchlist (candidates API);
 * this job keeps persisted snapshots for track-record / offline reads.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, optionScoreSnapshots, type InsertOptionScoreSnapshot,
} from "@workspace/db";
import {
  pickBestStrike, computeTechnicalRankingsV2, selectPremiumCandidates,
  isViablePremiumIncome, CALL_STRIKE_WEIGHTS, CALL_INCOME_FLOOR, INCOME_FLOOR,
  applyPolicy,
  type StockContext, type TechnicalRow, type MacroRegime,
} from "@workspace/option-scoring";
import { type OptionsChainResult, type OptionRow } from "./options.js";
import { fetchChainsForTickers } from "./options-chain-batch.js";
import { getAllTechnicalsRows } from "./technicals-db.js";
import { readPersistedScores, computeAndPersistFundamentalScores } from "./fundamentals-db.js";
import { getMacroRegimeResult } from "../routes/macro-regime.js";
import { getLatestRegime } from "../routes/regime.js";
import { getTiltState, getCalibrationTable } from "./model-track-record.js";
import { logger } from "./logger.js";

const CHAIN_CONCURRENCY = 3;
/** Cap Yahoo chain fetches per nightly run — wide IV filter, not GO/WATCH. */
const CANDIDATE_LIMIT = 200;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function spotOtm(spot: number, strike: number, isCall: boolean): number {
  if (!(spot > 0)) return 0;
  return isCall ? (strike - spot) / spot : (spot - strike) / spot;
}

export interface OptionRankingRow {
  ticker: string;
  side: "put" | "call";
  asOf: string;
  strike: number;
  expiry: string;
  spot: number;
  premium: number;
  weeklyIncomePct: number | null;
  otmPct: number | null;
  delta: number | null;
  strikeIv: number | null;
  dte: number | null;
  optionScore: number;
  componentScores: Record<string, unknown>;
  earningsDaysOut: number | null;
  earningsRisk: boolean;
  bidIsLive: boolean;
  quoteStale: boolean;
  dataQuality: number | null;
  atmPutIv: number | null;
  ivVsRealized: number | null;
  computedAt: string;
  rank: number;
}

export async function readLatestOptionRankings(side: "put" | "call"): Promise<{
  rows: OptionRankingRow[];
  asOf: string | null;
  computedAt: string | null;
}> {
  const [latest] = await db
    .select({ asOf: optionScoreSnapshots.asOf })
    .from(optionScoreSnapshots)
    .where(eq(optionScoreSnapshots.side, side))
    .orderBy(desc(optionScoreSnapshots.asOf))
    .limit(1);

  if (!latest?.asOf) return { rows: [], asOf: null, computedAt: null };

  const raw = await db
    .select()
    .from(optionScoreSnapshots)
    .where(and(
      eq(optionScoreSnapshots.side, side),
      eq(optionScoreSnapshots.asOf, latest.asOf),
    ))
    .orderBy(desc(optionScoreSnapshots.optionScore));

  const rows: OptionRankingRow[] = raw.map((r, i) => ({
    ticker: r.ticker,
    side: r.side as "put" | "call",
    asOf: String(r.asOf),
    strike: Number(r.strike),
    expiry: String(r.expiry),
    spot: Number(r.spot),
    premium: Number(r.premium),
    weeklyIncomePct: num(r.weeklyIncomePct),
    otmPct: num(r.otmPct),
    delta: num(r.delta),
    strikeIv: num(r.strikeIv),
    dte: num(r.dte),
    optionScore: Number(r.optionScore),
    componentScores: (r.componentScores ?? {}) as Record<string, unknown>,
    earningsDaysOut: r.earningsDaysOut ?? null,
    earningsRisk: r.earningsRisk,
    bidIsLive: r.bidIsLive,
    quoteStale: r.quoteStale,
    dataQuality: num(r.dataQuality),
    atmPutIv: num(r.atmPutIv),
    ivVsRealized: num(r.ivVsRealized),
    computedAt: r.computedAt instanceof Date ? r.computedAt.toISOString() : String(r.computedAt),
    rank: i + 1,
  }));

  return {
    rows,
    asOf: String(latest.asOf),
    computedAt: rows[0]?.computedAt ?? null,
  };
}

export async function computeAndPersistOptionScores(opts?: {
  asOf?: string;
  limit?: number;
  dryRun?: boolean;
  /** Reuse chains from a sibling job (e.g. Friday model snapshot). */
  chainsByTicker?: Map<string, OptionsChainResult[]>;
}): Promise<{
  asOf: string;
  candidates: number;
  persisted: number;
  failures: number;
  liveBidCount: number;
  top: Array<{ ticker: string; side: string; score: number; weekly: number | null }>;
}> {
  const asOf = opts?.asOf ?? todayStr();
  const limit = opts?.limit ?? CANDIDATE_LIMIT;
  const dryRun = opts?.dryRun === true;

  const { getChampionScorecardParams } = await import("./scorecard-params.js");
  const optChamp = await getChampionScorecardParams("options");
  const { createHash } = await import("crypto");
  // Ensure A14 columns exist (idempotent)
  const { pool } = await import("@workspace/db");
  await pool.query(`
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS coverage numeric;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS confidence text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS model_version text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS inputs_digest text;
  `);

  const [techRows, volRegimeResult, macroRegimeName, tiltState, calibration] = await Promise.all([
    getAllTechnicalsRows(),
    getMacroRegimeResult(),
    getLatestRegime(),
    getTiltState(),
    getCalibrationTable(),
  ]);
  const volRegime: MacroRegime = volRegimeResult.regime;
  const rows = techRows as unknown as TechnicalRow[];
  const putPolicy = applyPolicy(tiltState.put, undefined, { regime: macroRegimeName });
  const callPolicy = applyPolicy(tiltState.call, CALL_STRIKE_WEIGHTS, { regime: macroRegimeName });

  const candidates = selectPremiumCandidates(
    rows.map((r) => ({
      ticker: r.ticker,
      atmPutIv: r.atmPutIv,
      ivVsRealizedVol: r.ivVsRealizedVol,
      technicalsCoverage: r.technicalsCoverage,
    })),
    limit,
  );

  let fundScoreMap = new Map<string, number>();
  try {
    const scores = (await readPersistedScores(macroRegimeName))
      ?? (await computeAndPersistFundamentalScores(macroRegimeName));
    fundScoreMap = new Map(
      scores
        .filter((s): s is typeof s & { totalScore: number } => s.totalScore != null)
        .map((s) => [s.ticker, s.totalScore]),
    );
  } catch (err) {
    logger.warn({ err }, "option-score-snapshots: fund scores unavailable");
  }

  const putRankings = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "put").map((s) => [s.ticker, s.totalScore]));
  const callRankings = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "call").map((s) => [s.ticker, s.totalScore]));
  const techRowMap = new Map(rows.map((r) => [r.ticker, r]));

  let chainsByTicker: Map<string, OptionsChainResult[]>;
  let failures: number;
  if (opts?.chainsByTicker) {
    chainsByTicker = opts.chainsByTicker;
    failures = 0;
  } else {
    const fetched = await fetchChainsForTickers(candidates, {
      concurrency: CHAIN_CONCURRENCY,
      logLabel: "option-score-snapshots",
    });
    chainsByTicker = fetched.chainsByTicker;
    failures = fetched.failures;
  }

  const allIVs: number[] = [];
  for (const chains of chainsByTicker.values()) {
    for (const c of chains) for (const p of c.puts) if (p.iv > 0) allIVs.push(p.iv);
  }

  const inserts: InsertOptionScoreSnapshot[] = [];
  let liveBidCount = 0;
  for (const [ticker, chains] of chainsByTicker) {
    const techRow = techRowMap.get(ticker);
    if (!techRow || chains.length === 0) continue;

    for (const side of ["put", "call"] as const) {
      const isCall = side === "call";
      const incomeFloor = isCall ? CALL_INCOME_FLOOR : INCOME_FLOOR;
      const stockCtx: StockContext = {
        ivRank:                num(techRow.ivRank),
        ivPercentile:          num(techRow.ivPercentile),
        ivVsRealizedVol:       num(techRow.ivVsRealizedVol),
        basicSkew:             num(techRow.basicSkew),
        swingLow20d:           num(techRow.swingLow20d),
        swingLow50d:           num(techRow.swingLow50d),
        pivotS1:               num(techRow.pivotS1),
        swingHigh20d:          num(techRow.swingHigh20d),
        swingHigh50d:          num(techRow.swingHigh50d),
        pivotR1:               num(techRow.pivotR1),
        nearestSupportDistPct: num(techRow.nearestSupportDistPct),
        techTotalScore:        (isCall ? callRankings : putRankings).get(ticker) ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
        earningsDaysOut:       num(techRow.earningsDaysOut),
      };
      const policy = isCall ? callPolicy : putPolicy;
      const best = pickBestStrike(
        chains.map((c) => ({ ...c, options: isCall ? c.calls : c.puts })),
        stockCtx, volRegime, allIVs, undefined,
        policy.weights, isCall,
        {
          minStockQuality: policy.sqFloor,
          calibration,
          earningsHaircut: policy.earningsHaircut,
        },
      );
      if (!best) continue;
      const otmCheck = spotOtm(best.chain.spot, best.put.strike, isCall);
      if (!isViablePremiumIncome(best.result.weeklyIncome, otmCheck, { incomeFloor: incomeFloor * 0.9 })) continue;

      const opt = best.put as OptionRow;
      const chain = best.chain;
      const premium = opt.bid;
      if (!(premium > 0) || !opt.bidIsLive) continue;
      liveBidCount++;

      const spot = chain.spot;
      const otm = otmCheck;

      inserts.push({
        ticker,
        side,
        asOf,
        strike: String(opt.strike),
        expiry: chain.expiry,
        spot: String(spot),
        premium: String(premium),
        weeklyIncomePct: String(best.result.weeklyIncome),
        otmPct: otm != null ? String(otm) : null,
        delta: opt.delta != null ? String(opt.delta) : null,
        strikeIv: opt.iv > 0 ? String(opt.iv) : null,
        dte: String(chain.exactDte),
        optionScore: String(best.result.optionScore),
        componentScores: best.result.componentScores,
        earningsDaysOut: techRow.earningsDaysOut ?? null,
        earningsRisk: best.result.earningsRisk,
        bidIsLive: best.result.bidIsLive,
        quoteStale: best.result.quoteStale,
        dataQuality: String(best.result.dataQuality),
        atmPutIv: techRow.atmPutIv != null ? String(techRow.atmPutIv) : null,
        ivVsRealized: techRow.ivVsRealizedVol != null ? String(techRow.ivVsRealizedVol) : null,
        coverage: String(best.result.dataQuality ?? 1),
        confidence: best.result.bidIsLive && !best.result.quoteStale ? "high" : "low",
        modelVersion: optChamp.version,
        inputsDigest: createHash("sha1")
          .update(JSON.stringify({ ticker, side, strike: opt.strike, expiry: chain.expiry, spot, premium }))
          .digest("hex")
          .slice(0, 16),
        computedAt: new Date(),
      });
    }
  }

  if (!dryRun && inserts.length > 0) {
    // Upsert only — never DELETE … WHERE as_of = today (partial runs wiped the day).
    const CHUNK = 50;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await db.insert(optionScoreSnapshots).values(inserts.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [optionScoreSnapshots.ticker, optionScoreSnapshots.side, optionScoreSnapshots.asOf],
          set: {
            strike: sql`excluded.strike`,
            expiry: sql`excluded.expiry`,
            spot: sql`excluded.spot`,
            premium: sql`excluded.premium`,
            weeklyIncomePct: sql`excluded.weekly_income_pct`,
            otmPct: sql`excluded.otm_pct`,
            delta: sql`excluded.delta`,
            strikeIv: sql`excluded.strike_iv`,
            dte: sql`excluded.dte`,
            optionScore: sql`excluded.option_score`,
            componentScores: sql`excluded.component_scores`,
            earningsDaysOut: sql`excluded.earnings_days_out`,
            earningsRisk: sql`excluded.earnings_risk`,
            bidIsLive: sql`excluded.bid_is_live`,
            quoteStale: sql`excluded.quote_stale`,
            dataQuality: sql`excluded.data_quality`,
            atmPutIv: sql`excluded.atm_put_iv`,
            ivVsRealized: sql`excluded.iv_vs_realized`,
            coverage: sql`excluded.coverage`,
            confidence: sql`excluded.confidence`,
            modelVersion: sql`excluded.model_version`,
            inputsDigest: sql`excluded.inputs_digest`,
            computedAt: sql`excluded.computed_at`,
          },
        });
    }
  }

  const top = inserts
    .slice()
    .sort((a, b) => Number(b.optionScore) - Number(a.optionScore))
    .slice(0, 15)
    .map((r) => ({
      ticker: r.ticker,
      side: r.side,
      score: Number(r.optionScore),
      weekly: num(r.weeklyIncomePct),
    }));

  logger.info(
    { asOf, candidates: candidates.length, persisted: dryRun ? 0 : inserts.length, failures, liveBidCount },
    "option-score-snapshots: complete",
  );

  return {
    asOf,
    candidates: candidates.length,
    persisted: dryRun ? 0 : inserts.length,
    failures,
    liveBidCount,
    top,
  };
}
