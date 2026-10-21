/**
 * Model accountability: weekly snapshot of the model's judgments + grading them
 * against realized outcomes, so the model's credibility is measured, not assumed.
 *
 * Three judgment surfaces are tracked:
 *  - Best sell-put / sell-call rec per watchlist ticker (shared option scorer —
 *    the exact code path the options scanner runs client-side with default weights).
 *  - Live-tab hotlist GO/WATCH dip/rally calls.
 *  - Business-cycle regime calls (market_regime), graded multi-horizon vs SPY.
 *
 * Snapshot: Friday during market hours (scheduler). Grading: piggybacked on the
 * Saturday trade-idea expiry resolver. Universe: distinct union of all users'
 * watchlists — never the full DB universe.
 *
 * Learning loop: graded put/call recs feed a bounded aggressiveness tilt
 * (see @workspace/option-scoring tilt.ts) persisted to app_config.model_tilt.
 */
import { and, eq, lt, lte, sql, asc, gt, gte, desc } from "drizzle-orm";
import {
  db, appConfig, modelRecs, hotlistSnapshots, marketRegime,
  pricesHistorical, type InsertModelRec, type InsertHotlistSnapshot,
} from "@workspace/db";
import {
  pickBestStrike, applyPolicy,
  CALL_STRIKE_WEIGHTS, EMPTY_TILT_STATE, computeUnifiedScore,
  selectPremiumCandidates,
  buildCalibrationTable, walkForwardCalibration,
  shrinkTickerExpectancy, TILT_MIN_N,
  type StockContext, type TechnicalRow, type TiltState, type SideTiltStats, type MacroRegime,
  type CalibrationTable, type GradedRecForCalibration, type SidePolicy,
} from "@workspace/option-scoring";
import { type OptionsChainResult, type OptionRow } from "./options.js";
import { fetchChainsForTickers } from "./options-chain-batch.js";
import { computeAndPersistOptionScores } from "./option-score-snapshots.js";
import { getAllTechnicalsRows } from "./technicals-db.js";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { loadPutScoringInputs, loadShadowInputs, loadVolumeNodes, putTechScores, laneTechScores } from "./put-scoring-inputs.js";
import { scoreShadowOnChosenStrike } from "./option-score-shadow.js";
import { readPersistedScores, computeAndPersistFundamentalScores } from "./fundamentals-db.js";
import { deriveHotList } from "./live-hotlist.js";
import { getMacroRegimeResult } from "../routes/macro-regime.js";
import { getLatestRegime } from "../routes/regime.js";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";
import { computePathRisk, type PathRisk } from "./model-track-path-risk.js";
export {
  expectedDirectionFor,
  settleRec,
  gradeRegimeCall,
  maxDrawdownPct,
} from "./model-track-grade.js";

export { computePathRisk, type PathRisk } from "./model-track-path-risk.js";
export {
  fetchPathBars,
  pathRiskForRec,
  backfillPathRisk,
  closesAfterExpiry,
} from "./model-track-bars.js";
import { backfillPathRisk } from "./model-track-bars.js";
export {
  settleWithAssignment,
  assignmentStatus,
  type AssignmentSettle,
} from "./assignment-settle.js";

const CHAIN_CONCURRENCY = 3;       // Yahoo courtesy — optionsCache dedupes repeats

function todayStr(): string {
  return etDateKey(); // ET market date (was UTC: rolled to tomorrow after 5 PM PT, 10-20)
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ── Tilt state / recompute → model-track-tilt.ts (A83) ───────────────────────
export {
  MODEL_TILT_KEY,
  MODEL_CALIBRATION_KEY,
  getTiltState,
  getCalibrationTable,
  recomputeTilt,
} from "./model-track-tilt.js";
import {
  MODEL_TILT_KEY,
  MODEL_CALIBRATION_KEY,
  getTiltState,
  getCalibrationTable,
  setTiltState,
  recomputeTilt,
} from "./model-track-tilt.js";

/** Wipe graded history + tilt/calibration so a new policy starts clean. */
export async function resetModelTrackRecord(): Promise<{
  deletedRecs: number; deletedHotlist: number; tiltCleared: boolean; calibrationCleared: boolean;
}> {
  const recs = await db.delete(modelRecs).returning({ id: modelRecs.id });
  const hot = await db.delete(hotlistSnapshots).returning({ id: hotlistSnapshots.id });
  await setTiltState(EMPTY_TILT_STATE);
  const existingCal = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_CALIBRATION_KEY)).limit(1);
  if (existingCal.length > 0) {
    await db.delete(appConfig).where(eq(appConfig.key, MODEL_CALIBRATION_KEY));
  }
  logger.info({ deletedRecs: recs.length, deletedHotlist: hot.length }, "model-track-record: history wiped");
  return {
    deletedRecs: recs.length,
    deletedHotlist: hot.length,
    tiltCleared: true,
    calibrationCleared: true,
  };
}

// ── Weekly snapshot ───────────────────────────────────────────────────────────

export async function runModelSnapshot(snapshotDate: string = todayStr()): Promise<{
  recs: number; hotlist: number; regimeStubs: number; tickers: number; failures: number;
  liveBidRecs: number; degraded: boolean;
}> {
  // A172 columns (idempotent — drizzle 0030 also applies them).
  const { pool } = await import("@workspace/db");
  await pool.query(`
    ALTER TABLE model_recs ADD COLUMN IF NOT EXISTS shadow_score numeric;
    ALTER TABLE model_recs ADD COLUMN IF NOT EXISTS shadow_version text;
  `);

  const tickersWatch = await getUnionWatchlistTickers();
  const [techRows, volRegimeResult, macroRegimeName, tiltState, calibration] = await Promise.all([
    getAllTechnicalsRows(),
    getMacroRegimeResult(),
    getLatestRegime(),
    getTiltState(),
    getCalibrationTable(),
  ]);
  // Widen W/L universe: watchlist ∪ premium-IV candidates (capped) — same filter as Overall rankings.
  const premium = selectPremiumCandidates(
    (techRows as unknown as TechnicalRow[]).map((r) => ({
      ticker: r.ticker,
      atmPutIv: r.atmPutIv,
      ivVsRealizedVol: r.ivVsRealizedVol,
      technicalsCoverage: r.technicalsCoverage,
    })),
    80,
  );
  const tickers = [...new Set([...tickersWatch, ...premium].map((t) => t.toUpperCase()))];
  const volRegime: MacroRegime = volRegimeResult.regime;

  // Fundamental scores: same source the scanner's /fundamentals/rankings serves.
  let fundScoreMap = new Map<string, number>();
  try {
    const scores = (await readPersistedScores(macroRegimeName)) ?? (await computeAndPersistFundamentalScores(macroRegimeName));
    // totalScore is null when coverage is too thin to score honestly. Omit those
    // tickers rather than substituting a number — downstream treats an absent
    // fundamental score as "unknown", which is what it actually is.
    fundScoreMap = new Map(
      scores.filter((s): s is typeof s & { totalScore: number } => s.totalScore != null)
            .map(s => [s.ticker, s.totalScore]),
    );
  } catch (err) {
    logger.warn({ err }, "model-track-record: fundamentals scores unavailable, scoring without them");
  }

  // Technical totals per side — the model's own judgment, independent of any user's custom
  // weight overrides. A167: put side reads the options champion (same as option-score-snapshots).
  const rows = techRows as unknown as TechnicalRow[];
  const putInputs = await loadPutScoringInputs();
  const putRankings  = putTechScores(rows, putInputs.putTechWeights);
  const callRankings = laneTechScores(rows, putInputs.callTechWeights, "call");
  const techRowMap = new Map(rows.map(r => [r.ticker, r]));
  const shadowInputs = await loadShadowInputs();
  const shadowPutRankings = shadowInputs
    ? putTechScores(rows, shadowInputs.putTechWeights)
    : null;

  // Fetch chains (bounded concurrency; per-ticker failures don't kill the run).
  const { chainsByTicker, failures } = await fetchChainsForTickers(tickers, {
    concurrency: CHAIN_CONCURRENCY,
    logLabel: "model-track-record",
  });

  // Cross-watchlist IV distribution — mirrors use-top-options.ts exactly (put IVs only).
  const allWatchlistIVs: number[] = [];
  for (const chains of chainsByTicker.values()) {
    for (const c of chains) for (const p of c.puts) if (p.iv > 0) allWatchlistIVs.push(p.iv);
  }

  const volumeNodes = await loadVolumeNodes(tickers);
  const putPolicy  = applyPolicy(tiltState.put, putInputs.strikeWeights, { regime: macroRegimeName });
  const callPolicy = applyPolicy(tiltState.call, CALL_STRIKE_WEIGHTS, { regime: macroRegimeName });

  // Single query for the unified-score's regime component — same confidence
  // number the regime banner shows, not recomputed per ticker.
  const [latestRegimeRow] = await db.select({ confidence: marketRegime.confidence })
    .from(marketRegime).orderBy(desc(marketRegime.computedAt)).limit(1);
  const regimeConfidence = latestRegimeRow?.confidence ?? null;

  const recRows: InsertModelRec[] = [];
  for (const [ticker, chains] of chainsByTicker) {
    const techRow = techRowMap.get(ticker);
    if (!techRow || chains.length === 0) continue;

    for (const side of ["put", "call"] as const) {
      const isCall = side === "call";
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
        volumeNodes:           volumeNodes.get(ticker) ?? null,
      };
      const policy: SidePolicy = isCall ? callPolicy : putPolicy;
      // Per-ticker EB when available
      const tickerPolicy = applyPolicy(
        isCall ? tiltState.call : tiltState.put,
        isCall ? CALL_STRIKE_WEIGHTS : putInputs.strikeWeights,
        { regime: macroRegimeName, ticker },
      );
      const best = pickBestStrike(
        chains.map(c => ({ ...c, options: isCall ? c.calls : c.puts })),
        stockCtx, volRegime, allWatchlistIVs, undefined, tickerPolicy.weights, isCall,
        {
          minStockQuality: tickerPolicy.sqFloor,
          calibration,
          earningsHaircut: tickerPolicy.earningsHaircut,
        },
      );
      if (!best) continue;

      // Opt generic infers the constraint type; the runtime row is a full OptionRow
      // (same cast the client makes in use-top-options.ts).
      const opt = best.put as OptionRow;
      const chain = best.chain;
      const premium = opt.bid;
      if (!(premium > 0) || !opt.bidIsLive) continue; // never grade on lastPrice

      // 1-10 blended read (technical + option + regime), stored alongside the
      // option-scorer's own weight breakdown for this pick — see unified-score.ts.
      const unified = computeUnifiedScore({
        technicalScore: stockCtx.techTotalScore,
        optionScore: best.result.optionScore,
        regimeConfidence: regimeConfidence,
      });

      let shadowScore: string | null = null;
      let shadowVersion: string | null = null;
      if (!isCall && shadowInputs && shadowPutRankings) {
        const shadowPolicy = applyPolicy(
          tiltState.put, shadowInputs.strikeWeights, { regime: macroRegimeName, ticker },
        );
        const sh = scoreShadowOnChosenStrike({
          opt,
          chain,
          stockCtx: { ...stockCtx, techTotalScore: shadowPutRankings.get(ticker) ?? null },
          regime: volRegime,
          allWatchlistIVs,
          strikeWeights: shadowPolicy.weights,
          earningsHaircut: shadowPolicy.earningsHaircut,
          calibration,
        });
        if (sh != null) {
          shadowScore = String(sh);
          shadowVersion = shadowInputs.version;
        }
      }

      recRows.push({
        snapshotDate,
        ticker,
        side,
        expiry: chain.expiry,
        strike: String(opt.strike),
        spot: String(chain.spot),
        premium: String(premium),
        bidIsLive: opt.bidIsLive,
        incomePct: String(opt.incomePct),
        weeklyIncomePct: String(best.result.weeklyIncome),
        delta: opt.delta != null ? String(opt.delta) : null,
        strikeIv: opt.iv > 0 ? String(opt.iv) : null,
        dte: String(chain.exactDte),
        optionScore: String(best.result.optionScore),
        componentScores: { ...best.result.componentScores, unifiedScore: { score: unified.score, weight: 0 } },
        dataQuality: String(best.result.dataQuality),
        volRegime,
        macroRegime: macroRegimeName,
        tiltApplied: {
          factor: tickerPolicy.factor,
          weights: tickerPolicy.weights,
          sqFloor: tickerPolicy.sqFloor,
          earningsHaircut: tickerPolicy.earningsHaircut,
          version: tickerPolicy.version,
          globalFactor: policy.factor,
        },
        shadowScore,
        shadowVersion,
      });    }
  }

  let recs = 0;
  if (recRows.length > 0) {
    const inserted = await db.insert(modelRecs).values(recRows)
      .onConflictDoNothing({ target: [modelRecs.snapshotDate, modelRecs.ticker, modelRecs.side] })
      .returning({ id: modelRecs.id });
    recs = inserted.length;
  }

  // Hotlist GO/WATCH capture (both sides derive from the same cached indicators).
  const hotlistRows: InsertHotlistSnapshot[] = [];
  for (const side of ["dip", "rally"] as const) {
    try {
      const entries = await deriveHotList(side);
      for (const e of entries) {
        if (e.signal === "NO") continue;
        hotlistRows.push({
          snapshotDate, ticker: e.ticker, side, signal: e.signal,
          price: String(e.price),
          rsi: String(e.rsi), mfi: String(e.mfi),
          ivCurrent: e.ivCurrent > 0 ? String(e.ivCurrent) : null,
        });
      }
    } catch (err) {
      logger.warn({ err, side }, "model-track-record: hotlist derivation failed, skipping side");
    }
  }
  let hotlist = 0;
  if (hotlistRows.length > 0) {
    const inserted = await db.insert(hotlistSnapshots).values(hotlistRows)
      .onConflictDoNothing({ target: [hotlistSnapshots.snapshotDate, hotlistSnapshots.ticker, hotlistSnapshots.side] })
      .returning({ id: hotlistSnapshots.id });
    hotlist = inserted.length;
  }

  const regimeStubs = await insertRegimeGradeStubs();

  // Friday dual-write: persist Overall rankings from the same chain map (Mon–Thu
  // option-score job still runs alone; Fri skips that job — see scheduler).
  let snapshotPersisted = 0;
  try {
    const snap = await computeAndPersistOptionScores({
      asOf: snapshotDate,
      chainsByTicker,
    });
    snapshotPersisted = snap.persisted;
  } catch (err) {
    logger.warn({ err }, "model-track-record: option-score dual-write failed");
  }

  const liveBidRecs = recRows.filter(r => r.bidIsLive).length;
  const degraded = recs > 0 && liveBidRecs < Math.ceil(recs * 0.5);

  logger.info(
    { snapshotDate, tickers: tickers.length, recs, hotlist, regimeStubs, failures, liveBidRecs, degraded, snapshotPersisted },
    "model-track-record: snapshot complete",
  );
  return { recs, hotlist, regimeStubs, tickers: tickers.length, failures, liveBidRecs, degraded };
}

// ── Regime grade stubs / grading → model-track-regime.ts (A83) ───────────────
export {
  REGIME_HORIZONS,
  insertRegimeGradeStubs,
  gradeRegimeRows,
} from "./model-track-regime.js";
import {
  insertRegimeGradeStubs,
  gradeRegimeRows,
} from "./model-track-regime.js";

// ── Option rec grading → model-track-grade-recs.ts (A83) ─────────────────────
export { gradeModelRecs } from "./model-track-grade-recs.js";
import { gradeModelRecs } from "./model-track-grade-recs.js";

// ── Hotlist grading → model-track-hotlist.ts (A83) ────────────────────────────
export { gradeHotlistSnapshots } from "./model-track-hotlist.js";
import { gradeHotlistSnapshots } from "./model-track-hotlist.js";
import { etDateKey } from "./market-hours.js";

// ── Combined grading entry point (Saturday resolver add-on) ──────────────────

export async function runModelGrading(): Promise<void> {
  // Each stage isolated: one failure must not block the others or the resolver.
  await gradeModelRecs().catch(err => logger.error({ err }, "model-track-record: gradeModelRecs crashed"));
  await backfillPathRisk(120).catch(err => logger.error({ err }, "model-track-record: backfillPathRisk crashed"));
  await gradeHotlistSnapshots().catch(err => logger.error({ err }, "model-track-record: gradeHotlistSnapshots crashed"));
  await insertRegimeGradeStubs().catch(err => logger.error({ err }, "model-track-record: insertRegimeGradeStubs crashed"));
  await gradeRegimeRows().catch(err => logger.error({ err }, "model-track-record: gradeRegimeRows crashed"));
  await recomputeTilt().catch(err => logger.error({ err }, "model-track-record: recomputeTilt crashed"));
}
