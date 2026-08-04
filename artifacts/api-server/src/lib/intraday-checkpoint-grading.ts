// Grades intraday regime checkpoints against what the tape did afterwards.
//
// A checkpoint says "bearish, 82%" at 9:45. This asks: over the next 30 minutes,
// the next hour, and into the close — was it right? Without this the Live tab's
// confidence number is an assertion no one can check, and questions like "is
// Bear 100% a good moment to sell puts" stay opinions.
//
// Two population paths:
//   - live:          grade the checkpoints runCheckpoint() actually recorded
//   - reconstructed: replay computeSymbolSignal() over stored bars for days the
//                    server never ran, so history doesn't have to accrue in real time
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db, intradayCheckpointGrades, intradayDayStats } from "@workspace/db";
import {
  CHECKPOINTS_MIN,
  computeSymbolSignal,
  getCheckpointsForDate,
  type Bar,
  type SymbolSignal,
} from "./intraday-regime.js";
import { loadDayStats, TRACKED_SYMBOLS, type DayStats } from "./intraday-history.js";
import { logger } from "./logger.js";

// Below this the move is noise, not a directional call being right. Mirrors the
// REGIME_BAND dead-band idiom in model-track-record.ts — without it a +0.02% close
// scores as a correct bullish call and every accuracy figure drifts toward 50%.
const GRADE_BAND_PCT = 0.1;

export type CheckpointGrade = "correct" | "incorrect" | "flat" | "no_data" | "pending";

export interface GradedCheckpoint {
  date: string;
  ticker: string;
  minAfterOpen: number;
  direction: "bullish" | "bearish" | "mixed" | null;
  confidence: number | null;
  breakout: string;
  vwapSepPct: number;
  pullbackPct: number;
  priorDaySweep: string | null;
  priceAtCheckpoint: number;
  fwd30mPct: number | null;
  fwd60mPct: number | null;
  fwdClosePct: number | null;
  grade: CheckpointGrade;
  reconstructed: boolean;
}

/** Last close at or before `minutes` after the open, or null if the tape hadn't reached it. */
function priceAt(bars: Bar[], sessionOpenMs: number, minutes: number): number | null {
  const cutoff = sessionOpenMs + minutes * 60_000;
  let price: number | null = null;
  for (const b of bars) {
    if (b.time > cutoff) break;
    price = b.close;
  }
  return price;
}

/**
 * Was the directional call right?
 *
 * Graded on the move into the CLOSE, not the 30m move: the Live tab's question is
 * "should I sell premium for the rest of the session", which is a close-of-day
 * outcome. `mixed` and no-lean checkpoints assert nothing, so they can't be wrong —
 * they grade `flat` and are excluded from accuracy aggregates.
 */
export function gradeDirection(direction: GradedCheckpoint["direction"], fwdClosePct: number | null): CheckpointGrade {
  if (fwdClosePct == null) return "no_data";
  if (direction == null || direction === "mixed") return "flat";
  if (Math.abs(fwdClosePct) < GRADE_BAND_PCT) return "flat";
  const wentUp = fwdClosePct > 0;
  return (direction === "bullish") === wentUp ? "correct" : "incorrect";
}

/** Builds one graded row from a checkpoint's signal plus the session's bars. */
export function gradeCheckpoint(args: {
  date: string;
  ticker: string;
  minAfterOpen: number;
  direction: GradedCheckpoint["direction"];
  confidence: number | null;
  signal: SymbolSignal;
  bars: Bar[];
  reconstructed: boolean;
}): GradedCheckpoint | null {
  const { date, ticker, minAfterOpen, direction, confidence, signal, bars, reconstructed } = args;
  if (bars.length === 0) return null;
  const sessionOpenMs = bars[0].time;

  const priceAtCheckpoint = priceAt(bars, sessionOpenMs, minAfterOpen);
  if (priceAtCheckpoint == null || !(priceAtCheckpoint > 0)) return null;

  const pctFrom = (p: number | null): number | null =>
    p == null ? null : ((p - priceAtCheckpoint) / priceAtCheckpoint) * 100;

  // A checkpoint late in the session has no +30m/+60m price — those stay null
  // rather than silently falling back to the close, which would make late
  // checkpoints look identical across all three horizons.
  const lastBarMin = Math.round((bars[bars.length - 1].time - sessionOpenMs) / 60_000);
  const fwd30mPct = minAfterOpen + 30 <= lastBarMin ? pctFrom(priceAt(bars, sessionOpenMs, minAfterOpen + 30)) : null;
  const fwd60mPct = minAfterOpen + 60 <= lastBarMin ? pctFrom(priceAt(bars, sessionOpenMs, minAfterOpen + 60)) : null;
  const fwdClosePct = pctFrom(bars[bars.length - 1].close);

  return {
    date,
    ticker,
    minAfterOpen,
    direction,
    confidence,
    breakout: signal.breakout,
    vwapSepPct: signal.vwapSepPct,
    pullbackPct: signal.pullbackPct,
    priorDaySweep: signal.priorDaySweep,
    priceAtCheckpoint,
    fwd30mPct,
    fwd60mPct,
    fwdClosePct,
    grade: gradeDirection(direction, fwdClosePct),
    reconstructed,
  };
}

/**
 * Replays the checkpoint sequence over a stored session.
 *
 * This is the same slicing runCheckpoint() does when catching up after downtime
 * (intraday-regime.ts), so reconstructed direction/score match what the live job
 * would have produced — with one documented exception: hotlist breadth needs live
 * prices and has no historical snapshot, so reconstructed confidence is the
 * pre-breadth value. Rows are flagged `reconstructed` and the UI captions them.
 */
export function reconstructDay(stats: DayStats, priorHigh: number | null, priorLow: number | null): GradedCheckpoint[] {
  const bars = stats.bars;
  if (bars.length === 0) return [];
  const sessionOpenMs = bars[0].time;
  const out: GradedCheckpoint[] = [];

  for (const minAfterOpen of CHECKPOINTS_MIN) {
    const cutoff = sessionOpenMs + minAfterOpen * 60_000;
    const slice = bars.filter(b => b.time <= cutoff);
    if (slice.length < 3) continue; // opening range not closed yet

    const signal = computeSymbolSignal(stats.ticker, slice, priorHigh, priorLow);
    if (!signal) continue;

    // The 15-min checkpoint is the opening range closing — no breakout is possible
    // yet, so it makes no directional call. Same rule as runCheckpoint().
    const isBaselineOnly = minAfterOpen === 15;

    const graded = gradeCheckpoint({
      date: stats.date,
      ticker: stats.ticker,
      minAfterOpen,
      direction: isBaselineOnly ? null : signal.direction,
      confidence: isBaselineOnly ? null : signal.score,
      signal,
      bars,
      reconstructed: true,
    });
    if (graded) out.push(graded);
  }
  return out;
}

async function saveGrades(rows: GradedCheckpoint[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(r => ({
    date: r.date,
    ticker: r.ticker,
    minAfterOpen: r.minAfterOpen,
    direction: r.direction,
    confidence: r.confidence,
    breakout: r.breakout,
    vwapSepPct: String(r.vwapSepPct),
    pullbackPct: String(r.pullbackPct),
    priorDaySweep: r.priorDaySweep,
    priceAtCheckpoint: String(r.priceAtCheckpoint),
    fwd30mPct: r.fwd30mPct == null ? null : String(r.fwd30mPct),
    fwd60mPct: r.fwd60mPct == null ? null : String(r.fwd60mPct),
    fwdClosePct: r.fwdClosePct == null ? null : String(r.fwdClosePct),
    grade: r.grade,
    reconstructed: r.reconstructed,
    gradedAt: new Date(),
  }));

  // Live rows must win over reconstructed ones: a real checkpoint carries breadth-
  // adjusted confidence that a replay can't reproduce. The nightly job grades live
  // first, so a later backfill pass must not clobber it.
  let written = 0;
  for (const v of values) {
    const existing = await db.select({ id: intradayCheckpointGrades.id, reconstructed: intradayCheckpointGrades.reconstructed })
      .from(intradayCheckpointGrades)
      .where(and(
        eq(intradayCheckpointGrades.date, v.date),
        eq(intradayCheckpointGrades.ticker, v.ticker),
        eq(intradayCheckpointGrades.minAfterOpen, v.minAfterOpen),
      )).limit(1);

    if (existing.length === 0) {
      await db.insert(intradayCheckpointGrades).values(v);
      written += 1;
    } else if (!(v.reconstructed && existing[0].reconstructed === false)) {
      await db.update(intradayCheckpointGrades).set(v).where(eq(intradayCheckpointGrades.id, existing[0].id));
      written += 1;
    }
  }
  return written;
}

/**
 * Grades one session's checkpoints. Uses the live-recorded checkpoints when the
 * server was running that day, and falls back to reconstruction otherwise.
 * Requires intraday_day_stats for the date — call captureSession() first.
 */
export async function gradeSession(date: string): Promise<{ graded: number; reconstructed: number }> {
  const dayStats = await loadDayStats([date]);
  const recorded = await getCheckpointsForDate(date);
  const rows: GradedCheckpoint[] = [];
  let reconstructedCount = 0;

  for (const ticker of TRACKED_SYMBOLS) {
    const stats = dayStats.get(`${date}:${ticker}`);
    if (!stats) continue;

    const live = recorded.filter(c => c.status === "resolved");
    if (live.length > 0) {
      for (const cp of live) {
        const signal = ticker === "SPY" ? cp.spy : cp.qqq;
        if (!signal) continue;
        const graded = gradeCheckpoint({
          date,
          ticker,
          minAfterOpen: cp.minAfterOpen,
          direction: signal.direction,
          confidence: cp.confidence,
          signal,
          bars: stats.bars,
          reconstructed: false,
        });
        if (graded) rows.push(graded);
      }
    } else {
      const prior = await priorSessionHighLow(ticker, date);
      const replayed = reconstructDay(stats, prior.high, prior.low);
      reconstructedCount += replayed.length;
      rows.push(...replayed);
    }
  }

  const graded = await saveGrades(rows);
  logger.info({ date, graded, reconstructed: reconstructedCount }, "intraday-grading: session graded");
  return { graded, reconstructed: reconstructedCount };
}

/**
 * Prior stored session's high/low, for the sweep test during reconstruction.
 *
 * Reads intraday_day_stats rather than prices_historical so a backfill run is
 * self-contained — and so the levels are the same regular-hours extremes the live
 * path saw, not daily bars that include pre/post-market prints. Null on the
 * earliest captured day, which just means no sweep is detected for it.
 */
async function priorSessionHighLow(ticker: string, date: string): Promise<{ high: number | null; low: number | null }> {
  const rows = await db.select({ high: intradayDayStats.high, low: intradayDayStats.low })
    .from(intradayDayStats)
    .where(and(eq(intradayDayStats.ticker, ticker), lt(intradayDayStats.date, date)))
    .orderBy(desc(intradayDayStats.date))
    .limit(1);
  if (rows.length === 0) return { high: null, low: null };
  return { high: Number(rows[0].high), low: Number(rows[0].low) };
}

/** Dates in the window that have stored bars but no grades yet. */
export async function ungradedDates(dates: string[]): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = await db.select({ date: intradayCheckpointGrades.date })
    .from(intradayCheckpointGrades)
    .where(inArray(intradayCheckpointGrades.date, dates));
  const done = new Set(rows.map(r => r.date));
  return dates.filter(d => !done.has(d));
}
