/**
 * A83 — model tilt + calibration persist/recompute (from model-track-record).
 */
import { and, eq, sql, gte } from "drizzle-orm";
import { db, appConfig, modelRecs } from "@workspace/db";
import {
  EMPTY_TILT_STATE, buildCalibrationTable, walkForwardCalibration,
  shrinkTickerExpectancy, TILT_MIN_N,
  type TiltState, type SideTiltStats, type CalibrationTable, type GradedRecForCalibration,
} from "@workspace/option-scoring";
import { logger } from "./logger.js";

export const MODEL_TILT_KEY = "model_tilt";
export const MODEL_CALIBRATION_KEY = "model_calibration";
const TILT_WINDOW_DAYS = 84;
const TICKER_MIN_N = 8;
const TICKER_PRIOR = 12;

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

export async function setTiltState(state: TiltState): Promise<void> {
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

export async function setCalibrationTable(table: CalibrationTable): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, MODEL_CALIBRATION_KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: MODEL_CALIBRATION_KEY, value: table });
  } else {
    await db.update(appConfig).set({ value: table, updatedAt: new Date() }).where(eq(appConfig.key, MODEL_CALIBRATION_KEY));
  }
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

