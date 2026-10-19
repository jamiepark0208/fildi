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
  db, appConfig, modelRecs, hotlistSnapshots, regimeGrades, marketRegime,
  pricesHistorical, type InsertModelRec, type InsertHotlistSnapshot,
} from "@workspace/db";
import {
  pickBestStrike, computeTechnicalRankingsV2, applyPolicy,
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
import { loadPutScoringInputs, loadVolumeNodes, putTechScores } from "./put-scoring-inputs.js";
import { readPersistedScores, computeAndPersistFundamentalScores } from "./fundamentals-db.js";
import { deriveHotList } from "./live-hotlist.js";
import { getMacroRegimeResult } from "../routes/macro-regime.js";
import { getLatestRegime } from "../routes/regime.js";
import { closeOnOrBeforeExpiryChecked } from "./trade-post-expiry.js";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";
import { computePathRisk, type PathRisk } from "./model-track-path-risk.js";
import {
  assignmentStatus,
  settleWithAssignment,
  type AssignmentSide,
} from "./assignment-settle.js";
import {
  expectedDirectionFor,
  settleRec,
  gradeRegimeCall,
  maxDrawdownPct,
} from "./model-track-grade.js";
export {
  expectedDirectionFor,
  settleRec,
  gradeRegimeCall,
  maxDrawdownPct,
} from "./model-track-grade.js";

export { computePathRisk, type PathRisk } from "./model-track-path-risk.js";
export {
  settleWithAssignment,
  assignmentStatus,
  type AssignmentSettle,
} from "./assignment-settle.js";

export const MODEL_TILT_KEY = "model_tilt";
export const MODEL_CALIBRATION_KEY = "model_calibration";
const CHAIN_CONCURRENCY = 3;       // Yahoo courtesy — optionsCache dedupes repeats
const TILT_WINDOW_DAYS = 84;       // trailing 12 weeks of graded recs feed the tilt
const NO_DATA_GRACE_DAYS = 14;     // no price this long past expiry → NO_DATA (delisted)
const SPLIT_GUARD_MOVE = 0.6;      // |close/spot - 1| beyond this looks like a split, not a move
const TICKER_MIN_N = 8;            // below this, no per-ticker EB offset
const TICKER_PRIOR = 12;           // EB pseudo-counts toward global mean

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ── Tilt state (app_config) ───────────────────────────────────────────────────

export async function getTiltState(): Promise<TiltState> {
  try {
    const rows = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_TILT_KEY)).limit(1);
    const v = rows[0]?.value as TiltState | undefined;
    if (v && v.put && v.call) return v;
  } catch (err) {
    logger.warn({ err }, "model-track-record: failed to load tilt state, using neutral");
  }
  return EMPTY_TILT_STATE;
}

async function setTiltState(state: TiltState): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_TILT_KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: MODEL_TILT_KEY, value: state });
  } else {
    await db.update(appConfig).set({ value: state, updatedAt: new Date() }).where(eq(appConfig.key, MODEL_TILT_KEY));
  }
}

export async function getCalibrationTable(): Promise<CalibrationTable | null> {
  try {
    const rows = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_CALIBRATION_KEY)).limit(1);
    const v = rows[0]?.value as CalibrationTable | undefined;
    if (v?.put?.buckets && v?.call?.buckets) return v;
  } catch (err) {
    logger.warn({ err }, "model-track-record: failed to load calibration");
  }
  return null;
}

async function setCalibrationTable(table: CalibrationTable): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_CALIBRATION_KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: MODEL_CALIBRATION_KEY, value: table });
  } else {
    await db.update(appConfig).set({ value: table, updatedAt: new Date() }).where(eq(appConfig.key, MODEL_CALIBRATION_KEY));
  }
}

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
  const callRankings = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "call").map(s => [s.ticker, s.totalScore]));
  const techRowMap = new Map(rows.map(r => [r.ticker, r]));

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

// ── Regime grade stubs ────────────────────────────────────────────────────────
// Denormalized pending rows inserted long before grading so the 90-row
// market_regime retention can't prune a call before its 12w horizon matures.
// One graded call per UTC day: the LAST market_regime row of that day.

export const REGIME_HORIZONS = [
  { horizon: "1w",  days: 7  },
  { horizon: "4w",  days: 28 },
  { horizon: "12w", days: 84 },
] as const;


export async function insertRegimeGradeStubs(): Promise<number> {
  // Last row per UTC day, via DISTINCT ON over computed_at::date.
  const rows = await db.execute<{ id: number; regime: string; confidence: number; computed_at: Date }>(sql`
    SELECT DISTINCT ON (computed_at::date) id, regime, confidence, computed_at
    FROM market_regime
    ORDER BY computed_at::date DESC, computed_at DESC
  `);
  let inserted = 0;
  for (const r of rows.rows) {
    if (r.regime === "insufficient_data") continue;
    const values = REGIME_HORIZONS.map(h => ({
      regimeRowId: r.id,
      regime: r.regime,
      confidence: r.confidence,
      classifiedAt: new Date(r.computed_at),
      horizon: h.horizon,
      expectedDirection: expectedDirectionFor(r.regime),
    }));
    const res = await db.insert(regimeGrades).values(values)
      .onConflictDoNothing({ target: [regimeGrades.regimeRowId, regimeGrades.horizon] })
      .returning({ id: regimeGrades.id });
    inserted += res.length;
  }
  return inserted;
}

// ── Grading: option recs ──────────────────────────────────────────────────────
// Settle-at-expiry from stock closes (no historical option prices exist):
// put intrinsic = max(strike - close, 0); call = max(close - strike, 0).
// pnlPerShare = premium - intrinsic (we always model SELL). WIN iff > 0.
// pnlPct basis: put → strike (cash-secured collateral); call → spot (covered stock).


export async function fetchPathBars(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<Array<{ high: number; low: number }>> {
  const rows = await db
    .select({
      high: pricesHistorical.high,
      low: pricesHistorical.low,
    })
    .from(pricesHistorical)
    .where(and(
      eq(pricesHistorical.ticker, ticker),
      gte(pricesHistorical.date, fromDate),
      lte(pricesHistorical.date, toDate),
    ))
    .orderBy(asc(pricesHistorical.date));
  return rows.flatMap((r) => {
    const high = r.high != null ? Number(r.high) : NaN;
    const low = r.low != null ? Number(r.low) : NaN;
    if (!Number.isFinite(high) || !Number.isFinite(low)) return [];
    return [{ high, low }];
  });
}

export async function pathRiskForRec(input: {
  ticker: string;
  side: string;
  spot: number;
  strike: number;
  snapshotDate: string;
  endDate: string;
  /** When false, skip Yahoo OHLCV fill — request paths must stay fast. Default true for backfill jobs. */
  allowFetch?: boolean;
}): Promise<PathRisk | null> {
  let bars = await fetchPathBars(input.ticker, input.snapshotDate, input.endDate);
  if (bars.length === 0 && input.allowFetch !== false) {
    await fetchAndStoreOHLCV(input.ticker).catch(() => {});
    bars = await fetchPathBars(input.ticker, input.snapshotDate, input.endDate);
  }
  if (bars.length === 0) return null;
  return computePathRisk({
    side: input.side,
    spot: input.spot,
    strike: input.strike,
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
  });
}

/** Backfill _pathRisk on graded WIN/LOSS rows missing it (idempotent). */
export async function backfillPathRisk(limit = 80): Promise<{ updated: number; skipped: number }> {
  const rows = await db.select({
    id: modelRecs.id,
    ticker: modelRecs.ticker,
    side: modelRecs.side,
    spot: modelRecs.spot,
    strike: modelRecs.strike,
    snapshotDate: modelRecs.snapshotDate,
    expiry: modelRecs.expiry,
    componentScores: modelRecs.componentScores,
  }).from(modelRecs)
    .where(sql`${modelRecs.status} IN ('WIN','LOSS')`)
    .orderBy(desc(modelRecs.expiry))
    .limit(limit * 3); // oversample; many already filled

  let updated = 0, skipped = 0;
  for (const rec of rows) {
    if (updated >= limit) break;
    const prev = (rec.componentScores && typeof rec.componentScores === "object")
      ? rec.componentScores as Record<string, unknown>
      : {};
    if (prev["_pathRisk"] && typeof (prev["_pathRisk"] as { maxAdversePct?: unknown }).maxAdversePct === "number") {
      skipped++;
      continue;
    }
    const path = await pathRiskForRec({
      ticker: rec.ticker,
      side: rec.side,
      spot: Number(rec.spot),
      strike: Number(rec.strike),
      snapshotDate: rec.snapshotDate,
      endDate: rec.expiry,
    });
    if (!path) { skipped++; continue; }
    await db.update(modelRecs).set({
      componentScores: { ...prev, _pathRisk: path },
    }).where(eq(modelRecs.id, rec.id));
    updated++;
  }
  if (updated > 0) logger.info({ updated, skipped }, "model-track-record: path-risk backfill");
  return { updated, skipped };
}

/** Next N trading-day closes after expiry (for A92 day-10 assignment window). */
export async function closesAfterExpiry(
  ticker: string,
  expiry: string,
  n = 10,
): Promise<number[]> {
  const bars = await db.select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, ticker), gt(pricesHistorical.date, expiry)))
    .orderBy(asc(pricesHistorical.date))
    .limit(n);
  return bars.flatMap((b) => {
    const c = b.close != null ? Number(b.close) : NaN;
    return Number.isFinite(c) && c > 0 ? [c] : [];
  });
}

export async function gradeModelRecs(): Promise<{ graded: number; noData: number; pending: number; assigned: number }> {
  // PENDING = never settled; ASSIGNED = ITM waiting day-10; also regrade old ITM
  // WIN/LOSS missing `_settlement.assignment` (A92 backfill).
  const due = await db.select().from(modelRecs)
    .where(and(
      sql`(
        ${modelRecs.status} IN ('PENDING','ASSIGNED')
        OR (
          ${modelRecs.status} IN ('WIN','LOSS')
          AND COALESCE(${modelRecs.intrinsic}::float8, 0) > 0
          AND (${modelRecs.componentScores}->'_settlement'->'assignment') IS NULL
        )
      )`,
      lt(modelRecs.expiry, todayStr()),
    ));

  let graded = 0, noData = 0, pending = 0, assigned = 0;
  for (const rec of due) {
    try {
      let close = (await closeOnOrBeforeExpiryChecked(rec.ticker, rec.expiry))?.close ?? null;
      if (close == null) {
        await fetchAndStoreOHLCV(rec.ticker).catch(() => {});
        close = (await closeOnOrBeforeExpiryChecked(rec.ticker, rec.expiry))?.close ?? null;
      }

      const daysPast = (Date.now() - new Date(rec.expiry).getTime()) / 86_400_000;
      const spot = Number(rec.spot);
      // Split guard: Yahoo backfills split-adjusted closes, which would corrupt
      // strike-vs-close settlement — a >60% "move" with huge intrinsic is far more
      // likely a split than a real crash/melt-up. Same limitation as trade-post-expiry.
      const looksLikeSplit = close != null && spot > 0 && Math.abs(close / spot - 1) > SPLIT_GUARD_MOVE;

      if (close == null || looksLikeSplit) {
        if (looksLikeSplit || daysPast > NO_DATA_GRACE_DAYS) {
          await db.update(modelRecs).set({ status: "NO_DATA", gradedAt: new Date() }).where(eq(modelRecs.id, rec.id));
          noData++;
          if (looksLikeSplit) logger.warn({ ticker: rec.ticker, recId: rec.id, spot, close }, "model-track-record: split-like move, marked NO_DATA");
        } else {
          pending++; // retry next week
        }
        continue;
      }

      const s = settleRec({ side: rec.side, strike: Number(rec.strike), spot, premium: Number(rec.premium), close });
      const side = (rec.side === "call" ? "call" : "put") as AssignmentSide;
      let postCloses = await closesAfterExpiry(rec.ticker, rec.expiry, 10);
      if (postCloses.length < 10) {
        await fetchAndStoreOHLCV(rec.ticker).catch(() => {});
        postCloses = await closesAfterExpiry(rec.ticker, rec.expiry, 10);
      }
      const a = settleWithAssignment({
        side,
        strike: Number(rec.strike),
        premium: Number(rec.premium),
        window: { expiryClose: close, closes: postCloses },
      });
      const finalStatus = assignmentStatus(a);
      const basis = side === "put" ? Number(rec.strike) : spot;
      // Headline columns: all-in when window complete; premium while ASSIGNED/OTM.
      const headlinePnl = a.allInPnlPerShare ?? a.premiumPnlPerShare;
      const headlinePct = basis > 0 ? (headlinePnl / basis) * 100 : 0;

      const prevComponents = (rec.componentScores && typeof rec.componentScores === "object")
        ? rec.componentScores as Record<string, unknown>
        : {};
      const path = await pathRiskForRec({
        ticker: rec.ticker,
        side: rec.side,
        spot,
        strike: Number(rec.strike),
        snapshotDate: rec.snapshotDate,
        endDate: rec.expiry,
      });
      await db.update(modelRecs).set({
        status: finalStatus,
        settleClose: String(close),
        intrinsic: String(s.intrinsic),
        pnlPerShare: String(headlinePnl),
        pnlPct: String(headlinePct),
        componentScores: {
          ...prevComponents,
          _settlement: {
            hold: { pnlPct: s.pnlPct, status: s.status, pnlPerShare: s.pnlPerShare },
            managed: {
              pnlPct: s.managedPnlPct,
              status: s.managedStatus,
              pnlPerShare: s.managedPnlPerShare,
              rule: "take_50pct_credit_or_stop_2x",
            },
            assignment: {
              assigned: a.assigned,
              windowComplete: a.windowComplete,
              windowDays: a.windowDays,
              day10Close: a.day10Close,
              stockPnlPerShare: a.stockPnlPerShare,
              premiumPnlPerShare: a.premiumPnlPerShare,
              allInPnlPerShare: a.allInPnlPerShare,
              bestPnlPerShare: a.bestPnlPerShare,
              worstPnlPerShare: a.worstPnlPerShare,
              rule: "day10_close_after_expiry",
              status: finalStatus,
            },
          },
          ...(path ? { _pathRisk: path } : {}),
        },
        gradedAt: new Date(),
      }).where(eq(modelRecs.id, rec.id));
      if (finalStatus === "ASSIGNED") assigned++;
      else graded++;
    } catch (err) {
      logger.error({ err, recId: rec.id, ticker: rec.ticker }, "model-track-record: rec grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending, assigned }, "model-track-record: rec grading complete");
  return { graded, noData, pending, assigned };
}

// ── Grading: hotlist calls ────────────────────────────────────────────────────
// 5th trading close after snapshotDate. Dip expects a bounce (fwd > 0);
// rally expects a fade (fwd < 0).

export async function gradeHotlistSnapshots(): Promise<{ graded: number; noData: number; pending: number }> {
  const due = await db.select().from(hotlistSnapshots).where(eq(hotlistSnapshots.status, "PENDING"));

  let graded = 0, noData = 0, pending = 0;
  for (const snap of due) {
    try {
      const bars = await db.select({ close: pricesHistorical.close })
        .from(pricesHistorical)
        .where(and(eq(pricesHistorical.ticker, snap.ticker), gt(pricesHistorical.date, snap.snapshotDate)))
        .orderBy(asc(pricesHistorical.date))
        .limit(5);

      const daysPast = (Date.now() - new Date(snap.snapshotDate).getTime()) / 86_400_000;
      if (bars.length < 5 || bars[4]!.close == null) {
        if (daysPast > NO_DATA_GRACE_DAYS + 7) {
          await db.update(hotlistSnapshots).set({ status: "NO_DATA", gradedAt: new Date() }).where(eq(hotlistSnapshots.id, snap.id));
          noData++;
        } else {
          pending++; // bars not mature yet (needs ≥5 trading days + enrichment backfill)
        }
        continue;
      }

      const close5 = Number(bars[4]!.close);
      const price = Number(snap.price);
      if (!(price > 0)) { pending++; continue; }
      const fwd = (close5 / price - 1) * 100;
      const win = snap.side === "dip" ? fwd > 0 : fwd < 0;
      await db.update(hotlistSnapshots).set({
        status: win ? "WIN" : "LOSS",
        fwdReturn5d: String(fwd),
        gradedAt: new Date(),
      }).where(eq(hotlistSnapshots.id, snap.id));
      graded++;
    } catch (err) {
      logger.error({ err, snapId: snap.id, ticker: snap.ticker }, "model-track-record: hotlist grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending }, "model-track-record: hotlist grading complete");
  return { graded, noData, pending };
}

// ── Grading: regime calls (multi-horizon vs SPY) ──────────────────────────────
// Pure helpers: model-track-grade.ts (expectedDirectionFor / gradeRegimeCall / maxDrawdownPct).

async function spyClosesBetween(startDate: string, endDate: string): Promise<Array<{ date: string; close: number }>> {
  const rows = await db.select({ date: pricesHistorical.date, close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(
      eq(pricesHistorical.ticker, "SPY"),
      gte(pricesHistorical.date, startDate),
      lte(pricesHistorical.date, endDate),
    ))
    .orderBy(asc(pricesHistorical.date));
  return rows.filter(r => r.close != null).map(r => ({ date: r.date, close: Number(r.close) }));
}


export async function gradeRegimeRows(): Promise<{ graded: number; noData: number; pending: number }> {
  const now = Date.now();
  const due = await db.select().from(regimeGrades).where(eq(regimeGrades.grade, "pending"));

  let graded = 0, noData = 0, pending = 0;
  let spyFetched = false;
  for (const row of due) {
    const days = REGIME_HORIZONS.find(h => h.horizon === row.horizon)?.days ?? 28;
    const startMs = new Date(row.classifiedAt).getTime();
    const endMs = startMs + days * 86_400_000;
    if (endMs > now) { pending++; continue; } // horizon not mature yet

    try {
      const startStr = new Date(startMs).toISOString().slice(0, 10);
      const endStr = new Date(endMs).toISOString().slice(0, 10);
      let closes = await spyClosesBetween(startStr, endStr);
      if (closes.length < 2 && !spyFetched) {
        spyFetched = true; // one backfill attempt per run, not per row
        await fetchAndStoreOHLCV("SPY").catch(() => {});
        closes = await spyClosesBetween(startStr, endStr);
      }
      if (closes.length < 2) {
        if (now - endMs > NO_DATA_GRACE_DAYS * 86_400_000) {
          await db.update(regimeGrades).set({ grade: "no_data", gradedAt: new Date() }).where(eq(regimeGrades.id, row.id));
          noData++;
        } else {
          pending++;
        }
        continue;
      }

      const spyStart = closes[0]!.close;
      const spyEnd = closes[closes.length - 1]!.close;
      const fwd = (spyEnd / spyStart - 1) * 100;
      const dd = maxDrawdownPct(closes.map(c => c.close));
      const grade = gradeRegimeCall({ expectedDirection: row.expectedDirection, horizon: row.horizon, fwdReturnPct: fwd, maxDrawdownPct: dd });
      await db.update(regimeGrades).set({
        grade,
        spyStart: String(spyStart),
        spyEnd: String(spyEnd),
        fwdReturnPct: String(fwd),
        maxDrawdownPct: String(dd),
        gradedAt: new Date(),
      }).where(eq(regimeGrades.id, row.id));
      graded++;
    } catch (err) {
      logger.error({ err, gradeId: row.id }, "model-track-record: regime grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending }, "model-track-record: regime grading complete");
  return { graded, noData, pending };
}

// ── Tilt + calibration recompute ──────────────────────────────────────────────

async function sideStats(side: "put" | "call"): Promise<SideTiltStats> {
  const sinceStr = new Date(Date.now() - TILT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({
    status: modelRecs.status,
    pnlPct: modelRecs.pnlPct,
    ticker: modelRecs.ticker,
    macroRegime: modelRecs.macroRegime,
    expiry: modelRecs.expiry,
  })
    .from(modelRecs)
    .where(and(
      eq(modelRecs.side, side),
      gte(modelRecs.snapshotDate, sinceStr),
      sql`${modelRecs.status} IN ('WIN','LOSS')`,
    ));
  const n = rows.length;
  if (n === 0) return { winRate: null, avgPnlPct: null, n: 0, updatedAt: new Date().toISOString() };
  const wins = rows.filter(r => r.status === "WIN").length;
  const pnls = rows.map(r => num(r.pnlPct)).filter((v): v is number => v != null);
  const avgPnlPct = pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : null;
  const nExpiries = new Set(rows.map(r => String(r.expiry))).size;

  // Regime slices
  const byRegime: NonNullable<SideTiltStats["byRegime"]> = {};
  const regimeGroups = new Map<string, { pnls: number[]; expiries: Set<string> }>();
  for (const r of rows) {
    const reg = r.macroRegime;
    const p = num(r.pnlPct);
    if (!reg || p == null) continue;
    if (!regimeGroups.has(reg)) regimeGroups.set(reg, { pnls: [], expiries: new Set() });
    regimeGroups.get(reg)!.pnls.push(p);
    regimeGroups.get(reg)!.expiries.add(String(r.expiry));
  }
  for (const [reg, { pnls: vals, expiries }] of regimeGroups) {
    byRegime[reg] = { n: vals.length, nExpiries: expiries.size, avgPnlPct: vals.reduce((a, b) => a + b, 0) / vals.length };
  }

  // Per-ticker EB toward global
  const byTicker: NonNullable<SideTiltStats["byTicker"]> = {};
  if (avgPnlPct != null) {
    const tickerGroups = new Map<string, number[]>();
    for (const r of rows) {
      const p = num(r.pnlPct);
      if (p == null) continue;
      if (!tickerGroups.has(r.ticker)) tickerGroups.set(r.ticker, []);
      tickerGroups.get(r.ticker)!.push(p);
    }
    for (const [ticker, vals] of tickerGroups) {
      if (vals.length < TICKER_MIN_N) continue;
      const tAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const shrunk = shrinkTickerExpectancy(tAvg, vals.length, avgPnlPct, TICKER_PRIOR);
      byTicker[ticker] = { n: vals.length, avgPnlPct: tAvg, shrunkDelta: shrunk - avgPnlPct };
    }
  }

  return {
    winRate: wins / n,
    avgPnlPct,
    n,
    nExpiries,
    updatedAt: new Date().toISOString(),
    byRegime: Object.keys(byRegime).length ? byRegime : undefined,
    byTicker: Object.keys(byTicker).length ? byTicker : undefined,
  };
}

async function loadGradedForCalibration(): Promise<GradedRecForCalibration[]> {
  const sinceStr = new Date(Date.now() - TILT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({
    side: modelRecs.side,
    optionScore: modelRecs.optionScore,
    pnlPct: modelRecs.pnlPct,
    snapshotDate: modelRecs.snapshotDate,
  }).from(modelRecs).where(and(
    gte(modelRecs.snapshotDate, sinceStr),
    sql`${modelRecs.status} IN ('WIN','LOSS')`,
  ));
  return rows.flatMap((r) => {
    const side = r.side === "call" ? "call" as const : r.side === "put" ? "put" as const : null;
    const score = num(r.optionScore);
    const pnl = num(r.pnlPct);
    if (!side || score == null || pnl == null) return [];
    return [{ side, optionScore: score, pnlPct: pnl, snapshotDate: r.snapshotDate }];
  });
}

export async function recomputeTilt(): Promise<TiltState> {
  const [put, call] = await Promise.all([sideStats("put"), sideStats("call")]);
  const state: TiltState = { put, call };
  await setTiltState(state);

  const graded = await loadGradedForCalibration();
  if (graded.length >= TILT_MIN_N) {
    // Walk-forward: train ending 28d before latest snapshot when possible
    const dates = [...new Set(graded.map((g) => g.snapshotDate).filter(Boolean) as string[])].sort();
    const foldEnd = dates.length >= 4 ? dates[Math.floor(dates.length * 0.7)]! : null;
    const table = buildCalibrationTable(graded, { trainEndDate: foldEnd });
    await setCalibrationTable(table);
    if (foldEnd) {
      const wf = walkForwardCalibration(graded, [foldEnd]);
      logger.info({ foldEnd, holdout: wf[0]?.holdoutExpectancy, putN: table.put.n, callN: table.call.n },
        "model-track-record: calibration walk-forward");
    }
  }

  logger.info({ put: { n: put.n, avgPnlPct: put.avgPnlPct }, call: { n: call.n, avgPnlPct: call.avgPnlPct } },
    "model-track-record: tilt+calibration recomputed");
  return state;
}

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
