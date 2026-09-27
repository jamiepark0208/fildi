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
  pickBestStrike, computeTechnicalRankingsV2, applyTilt,
  CALL_STRIKE_WEIGHTS, EMPTY_TILT_STATE, computeUnifiedScore,
  type StockContext, type TechnicalRow, type TiltState, type SideTiltStats, type MacroRegime,
} from "@workspace/option-scoring";
import { getOptionsChain, type OptionsChainResult, type OptionRow } from "./options.js";
import { getAllTechnicalsRows } from "./technicals-db.js";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { readPersistedScores, computeAndPersistFundamentalScores } from "./fundamentals-db.js";
import { deriveHotList } from "./live-hotlist.js";
import { getMacroRegimeResult } from "../routes/macro-regime.js";
import { getLatestRegime } from "../routes/regime.js";
import { closeOnOrBeforeExpiryChecked } from "./trade-post-expiry.js";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";

export const MODEL_TILT_KEY = "model_tilt";
const CHAIN_CONCURRENCY = 3;       // Yahoo courtesy — optionsCache dedupes repeats
const TILT_WINDOW_DAYS = 84;       // trailing 12 weeks of graded recs feed the tilt
const NO_DATA_GRACE_DAYS = 14;     // no price this long past expiry → NO_DATA (delisted)
const SPLIT_GUARD_MOVE = 0.6;      // |close/spot - 1| beyond this looks like a split, not a move

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

// ── Weekly snapshot ───────────────────────────────────────────────────────────

export async function runModelSnapshot(snapshotDate: string = todayStr()): Promise<{
  recs: number; hotlist: number; regimeStubs: number; tickers: number; failures: number;
}> {
  const tickers = await getUnionWatchlistTickers();
  const [techRows, volRegimeResult, macroRegimeName, tiltState] = await Promise.all([
    getAllTechnicalsRows(),
    getMacroRegimeResult(),
    getLatestRegime(),
    getTiltState(),
  ]);
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

  // Technical totals per side with DEFAULT weights — the model's own judgment,
  // independent of any user's custom weight overrides.
  const rows = techRows as unknown as TechnicalRow[];
  const putRankings  = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "put").map(s => [s.ticker, s.totalScore]));
  const callRankings = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "call").map(s => [s.ticker, s.totalScore]));
  const techRowMap = new Map(rows.map(r => [r.ticker, r]));

  // Fetch chains (bounded concurrency; per-ticker failures don't kill the run).
  const chainsByTicker = new Map<string, OptionsChainResult[]>();
  let failures = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < tickers.length) {
      const t = tickers[idx++]!;
      try {
        chainsByTicker.set(t, await getOptionsChain(t));
      } catch (err) {
        failures++;
        logger.warn({ err, ticker: t }, "model-track-record: chain fetch failed, skipping ticker");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHAIN_CONCURRENCY, tickers.length) }, worker));

  // Cross-watchlist IV distribution — mirrors use-top-options.ts exactly (put IVs only).
  const allWatchlistIVs: number[] = [];
  for (const chains of chainsByTicker.values()) {
    for (const c of chains) for (const p of c.puts) if (p.iv > 0) allWatchlistIVs.push(p.iv);
  }

  const putTilt  = applyTilt(tiltState.put);
  const callTilt = applyTilt(tiltState.call, CALL_STRIKE_WEIGHTS);

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
      };
      const tilt = isCall ? callTilt : putTilt;
      const best = pickBestStrike(
        chains.map(c => ({ ...c, options: isCall ? c.calls : c.puts })),
        stockCtx, volRegime, allWatchlistIVs, undefined, tilt.weights, isCall,
      );
      if (!best) continue;

      // Opt generic infers the constraint type; the runtime row is a full OptionRow
      // (same cast the client makes in use-top-options.ts).
      const opt = best.put as OptionRow;
      const chain = best.chain;
      const premium = opt.bid > 0 ? opt.bid : opt.lastPrice;
      if (!(premium > 0)) continue; // nothing sellable to grade

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
        tiltApplied: { factor: tilt.factor, weights: tilt.weights },
      });
    }
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

  logger.info(
    { snapshotDate, tickers: tickers.length, recs, hotlist, regimeStubs, failures },
    "model-track-record: snapshot complete",
  );
  return { recs, hotlist, regimeStubs, tickers: tickers.length, failures };
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

export function expectedDirectionFor(regime: string): "bullish" | "bearish" | "neutral" {
  switch (regime) {
    case "expansion":
    case "recovery":    return "bullish";
    case "contraction":
    case "recession":   return "bearish";
    default:            return "neutral"; // late_cycle, stagflation, insufficient_data
  }
}

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

export function settleRec(input: {
  side: string; strike: number; spot: number; premium: number; close: number;
}): { intrinsic: number; pnlPerShare: number; pnlPct: number; status: "WIN" | "LOSS" } {
  const intrinsic = input.side === "put"
    ? Math.max(input.strike - input.close, 0)
    : Math.max(input.close - input.strike, 0);
  const pnlPerShare = input.premium - intrinsic;
  const basis = input.side === "put" ? input.strike : input.spot;
  const pnlPct = basis > 0 ? (pnlPerShare / basis) * 100 : 0;
  return { intrinsic, pnlPerShare, pnlPct, status: pnlPerShare > 0 ? "WIN" : "LOSS" };
}

export async function gradeModelRecs(): Promise<{ graded: number; noData: number; pending: number }> {
  const due = await db.select().from(modelRecs)
    .where(and(eq(modelRecs.status, "PENDING"), lt(modelRecs.expiry, todayStr())));

  let graded = 0, noData = 0, pending = 0;
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
      await db.update(modelRecs).set({
        status: s.status,
        settleClose: String(close),
        intrinsic: String(s.intrinsic),
        pnlPerShare: String(s.pnlPerShare),
        pnlPct: String(s.pnlPct),
        gradedAt: new Date(),
      }).where(eq(modelRecs.id, rec.id));
      graded++;
    } catch (err) {
      logger.error({ err, recId: rec.id, ticker: rec.ticker }, "model-track-record: rec grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending }, "model-track-record: rec grading complete");
  return { graded, noData, pending };
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

// Horizon-scaled dead bands: |fwd| inside the band is "partial", not wrong.
const REGIME_BAND: Record<string, number> = { "1w": 1, "4w": 2, "12w": 4 };
// Neutral regimes also get credit if the window avoided a meaningful drawdown.
const NEUTRAL_DD_OK: Record<string, number> = { "1w": -3, "4w": -6, "12w": -10 };

export function gradeRegimeCall(input: {
  expectedDirection: string; horizon: string; fwdReturnPct: number; maxDrawdownPct: number;
}): "correct" | "partial" | "incorrect" {
  const band = REGIME_BAND[input.horizon] ?? 2;
  const fwd = input.fwdReturnPct;
  if (input.expectedDirection === "bullish") {
    if (fwd > band) return "correct";
    if (fwd < -band) return "incorrect";
    return "partial";
  }
  if (input.expectedDirection === "bearish") {
    if (fwd < -band) return "correct";
    if (fwd > band) return "incorrect";
    return "partial";
  }
  // neutral: flat tape or contained drawdown counts; a strong trend is a miss
  if (Math.abs(fwd) <= 1.5 * band || input.maxDrawdownPct >= (NEUTRAL_DD_OK[input.horizon] ?? -6)) {
    return Math.abs(fwd) > 3 * band ? "incorrect" : "correct";
  }
  return Math.abs(fwd) > 3 * band ? "incorrect" : "partial";
}

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

export function maxDrawdownPct(closes: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    else dd = Math.min(dd, (c / peak - 1) * 100);
  }
  return dd;
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

// ── Tilt recompute ────────────────────────────────────────────────────────────

async function sideStats(side: "put" | "call"): Promise<SideTiltStats> {
  const sinceStr = new Date(Date.now() - TILT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({ status: modelRecs.status, pnlPct: modelRecs.pnlPct })
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
  return {
    winRate: wins / n,
    avgPnlPct: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : null,
    n,
    updatedAt: new Date().toISOString(),
  };
}

export async function recomputeTilt(): Promise<TiltState> {
  const [put, call] = await Promise.all([sideStats("put"), sideStats("call")]);
  const state: TiltState = { put, call };
  await setTiltState(state);
  logger.info({ put, call }, "model-track-record: tilt recomputed");
  return state;
}

// ── Combined grading entry point (Saturday resolver add-on) ──────────────────

export async function runModelGrading(): Promise<void> {
  // Each stage isolated: one failure must not block the others or the resolver.
  await gradeModelRecs().catch(err => logger.error({ err }, "model-track-record: gradeModelRecs crashed"));
  await gradeHotlistSnapshots().catch(err => logger.error({ err }, "model-track-record: gradeHotlistSnapshots crashed"));
  await insertRegimeGradeStubs().catch(err => logger.error({ err }, "model-track-record: insertRegimeGradeStubs crashed"));
  await gradeRegimeRows().catch(err => logger.error({ err }, "model-track-record: gradeRegimeRows crashed"));
  await recomputeTilt().catch(err => logger.error({ err }, "model-track-record: recomputeTilt crashed"));
}
