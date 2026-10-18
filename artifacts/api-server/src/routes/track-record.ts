/**
 * Model accountability endpoints — the model's graded track record, tilt state,
 * and an admin trigger for snapshot/grading/fixture-seeding (testing without
 * waiting a week). Mounted behind requireAuth via the path-scoped gate in
 * routes/index.ts; /track-record/run is additionally requireAdmin.
 */
import { Router } from "express";
import { and, eq, desc, sql, asc } from "drizzle-orm";
import { db, modelRecs, hotlistSnapshots, regimeGrades, pricesHistorical } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { getLivePrices } from "../lib/live-quote.js";
import {
  runModelSnapshot, runModelGrading, getTiltState, insertRegimeGradeStubs,
  getCalibrationTable, resetModelTrackRecord, backfillPathRisk,
  type PathRisk,
} from "../lib/model-track-record.js";
import {
  applyPolicy, CALL_STRIKE_WEIGHTS, TILT_MIN_N, TILT_MIN_EXPIRIES, TILT_ANCHOR_PNL_PCT, TILT_SPAN_PNL_PCT,
  SQ_FLOOR_BASE,
} from "@workspace/option-scoring";
import { logger } from "../lib/logger.js";

const router = Router();

// 10-min cache: summary/regime aggregates only change when the Saturday grader
// runs, but a manual /run should surface within minutes.
export const trackRecordCache = new TTLCache<unknown>(10 * 60 * 1000, "track-record", 8);

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ── GET /track-record/summary ─────────────────────────────────────────────────

interface SideSummary {
  n: number;            // graded (WIN/LOSS)
  wins: number;
  winRate: number | null;
  avgPnlPct: number | null;
  totalPnlPct: number | null;
  /** Capital-weighted expectancy (pnl weighted by collateral: put=strike, call=spot). */
  capitalWeightedAvgPnlPct: number | null;
  maxDrawdownPct: number | null;
  pending: number;
  /** A92 — ITM, stock leg open until day-10 close. */
  assigned: number;
  noData: number;
  equityCurve: Array<{
    expiry: string; pnlPct: number; cumPnlPct: number; ticker: string;
    capitalCumPnlPct?: number;
    /** A92 — premium-only cumulative (toggle). */
    premiumCumPnlPct?: number;
  }>;
}

async function buildSideSummary(side: "put" | "call"): Promise<SideSummary> {
  const rows = await db.select({
    status: modelRecs.status, pnlPct: modelRecs.pnlPct,
    expiry: modelRecs.expiry, ticker: modelRecs.ticker,
    strike: modelRecs.strike, spot: modelRecs.spot,
    componentScores: modelRecs.componentScores,
  }).from(modelRecs).where(eq(modelRecs.side, side)).orderBy(asc(modelRecs.expiry), asc(modelRecs.ticker));

  const graded = rows.filter(r => r.status === "WIN" || r.status === "LOSS");
  const wins = graded.filter(r => r.status === "WIN").length;

  /** A92: all-in (day-10) vs premium-only; legacy rows fall back to managed → pnlPct. */
  const settlementPnls = (r: typeof graded[0]): { allIn: number; premium: number } => {
    const cs = r.componentScores as {
      _settlement?: {
        hold?: { pnlPct?: number };
        managed?: { pnlPct?: number };
        assignment?: { allInPnlPerShare?: number | null; premiumPnlPerShare?: number; windowComplete?: boolean };
      };
    } | null;
    const strike = num(r.strike) ?? 0;
    const spot = num(r.spot) ?? 0;
    const basis = side === "put" ? strike : spot;
    const a = cs?._settlement?.assignment;
    const hold = cs?._settlement?.hold;
    const managed = cs?._settlement?.managed?.pnlPct;
    const premium =
      typeof hold?.pnlPct === "number" && Number.isFinite(hold.pnlPct)
        ? hold.pnlPct
        : typeof a?.premiumPnlPerShare === "number" && basis > 0
          ? (a.premiumPnlPerShare / basis) * 100
          : (num(r.pnlPct) ?? 0);
    const allIn =
      typeof a?.allInPnlPerShare === "number" && Number.isFinite(a.allInPnlPerShare) && basis > 0
        ? (a.allInPnlPerShare / basis) * 100
        : typeof managed === "number" && Number.isFinite(managed)
          ? managed
          : (num(r.pnlPct) ?? premium);
    return { allIn, premium };
  };

  const pnls = graded.map((r) => settlementPnls(r).allIn);

  let cum = 0;
  let premCum = 0;
  let capCum = 0;
  let capWeightSum = 0;
  let capPnlSum = 0;
  let peak = 0;
  let maxDd = 0;
  const equityCurve = graded.map(r => {
    const { allIn: p, premium: prem } = settlementPnls(r);
    const collateral = side === "put" ? (num(r.strike) ?? 1) : (num(r.spot) ?? 1);
    cum += p;
    premCum += prem;
    // Capital-weighted: weight each trade's pnlPct by collateral notionals
    capPnlSum += p * collateral;
    capWeightSum += collateral;
    // Running capital-weighted cumulative approx: sum(p * w) / mean(w) scaled
    capCum += p * (collateral / (capWeightSum / graded.length || 1));
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
    return {
      expiry: r.expiry,
      pnlPct: p,
      cumPnlPct: Math.round(cum * 100) / 100,
      premiumCumPnlPct: Math.round(premCum * 100) / 100,
      capitalCumPnlPct: Math.round(capCum * 100) / 100,
      ticker: r.ticker,
    };
  });
  const capitalWeightedAvgPnlPct = capWeightSum > 0 ? capPnlSum / capWeightSum : null;

  return {
    n: graded.length,
    wins,
    winRate: graded.length > 0 ? wins / graded.length : null,
    avgPnlPct: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : null,
    totalPnlPct: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) : null,
    capitalWeightedAvgPnlPct,
    maxDrawdownPct: graded.length > 0 ? maxDd : null,
    pending: rows.filter(r => r.status === "PENDING").length,
    assigned: rows.filter(r => r.status === "ASSIGNED").length,
    noData: rows.filter(r => r.status === "NO_DATA").length,
    equityCurve: equityCurve.map(({ expiry, pnlPct, cumPnlPct, premiumCumPnlPct, capitalCumPnlPct, ticker }) => ({
      expiry, pnlPct, cumPnlPct, premiumCumPnlPct, capitalCumPnlPct, ticker,
    })),
  };
}

interface HotlistSummary {
  side: string; signal: string; n: number; wins: number;
  winRate: number | null; avgFwdReturn5d: number | null; pending: number;
}

async function buildHotlistSummary(): Promise<HotlistSummary[]> {
  const rows = await db.select({
    side: hotlistSnapshots.side, signal: hotlistSnapshots.signal,
    status: hotlistSnapshots.status, fwdReturn5d: hotlistSnapshots.fwdReturn5d,
  }).from(hotlistSnapshots);

  const out: HotlistSummary[] = [];
  for (const side of ["dip", "rally"] as const) {
    for (const signal of ["GO", "WATCH"] as const) {
      const group = rows.filter(r => r.side === side && r.signal === signal);
      const graded = group.filter(r => r.status === "WIN" || r.status === "LOSS");
      const wins = graded.filter(r => r.status === "WIN").length;
      const fwds = graded.map(r => num(r.fwdReturn5d)).filter((v): v is number => v != null);
      out.push({
        side, signal,
        n: graded.length,
        wins,
        winRate: graded.length > 0 ? wins / graded.length : null,
        avgFwdReturn5d: fwds.length > 0 ? fwds.reduce((s, v) => s + v, 0) / fwds.length : null,
        pending: group.filter(r => r.status === "PENDING").length,
      });
    }
  }
  return out;
}

router.get("/track-record/summary", async (_req, res) => {
  try {
    const data = await trackRecordCache.getOrCompute("summary-a92", async () => {
      const [put, call, hotlist, calibration] = await Promise.all([
        buildSideSummary("put"), buildSideSummary("call"), buildHotlistSummary(),
        getCalibrationTable(),
      ]);
      return {
        put, call, hotlist,
        calibration: calibration
          ? {
              put: calibration.put.buckets.map((b: { lo: number; hi: number; n: number; avgPnlPct: number }) => ({
                lo: b.lo, hi: b.hi, n: b.n, avgPnlPct: b.avgPnlPct,
              })),
              call: calibration.call.buckets.map((b: { lo: number; hi: number; n: number; avgPnlPct: number }) => ({
                lo: b.lo, hi: b.hi, n: b.n, avgPnlPct: b.avgPnlPct,
              })),
              version: calibration.version,
            }
          : null,
        // Hotlist/regime are secondary until sample matures — UI demotes when thin.
        secondary: {
          hotlistThin: hotlist.every((h: HotlistSummary) => h.n < 20),
          minHotlistN: 20,
        },
        generatedAt: Date.now(),
      };
    });
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /track-record/by-ticker ───────────────────────────────────────────────
// Cumulative win/loss counts per ticker per side — the accountability badge shown
// next to a ticker in the scanner/live tables ("3W-1L").

interface TickerRecord {
  wins: number;
  losses: number;
  /** mean(pnl)/stdev(pnl); null when n<3 */
  sharpe: number | null;
  /** Open (unexpired) model-rec spot at Init — for Live StkΔ vs live price */
  openSpot: number | null;
  openSnapshotDate: string | null;
  entryDelta: number | null;
  entryIv: number | null;
}
type ByTickerResponse = Record<string, { put: TickerRecord; call: TickerRecord }>;

function emptyTickerRecord(): TickerRecord {
  return {
    wins: 0, losses: 0, sharpe: null,
    openSpot: null, openSnapshotDate: null, entryDelta: null, entryIv: null,
  };
}

function sharpeFromPnls(pnls: number[]): number | null {
  if (pnls.length < 3) return null;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1);
  const stdev = Math.sqrt(variance);
  return stdev > 1e-6 ? mean / stdev : null;
}

router.get("/track-record/by-ticker", async (_req, res) => {
  try {
    const data = await trackRecordCache.getOrCompute("by-ticker-v2", async () => {
      const rows = await db.select({
        ticker: modelRecs.ticker,
        side: modelRecs.side,
        status: modelRecs.status,
        pnlPct: modelRecs.pnlPct,
        snapshotDate: modelRecs.snapshotDate,
        expiry: modelRecs.expiry,
        spot: modelRecs.spot,
        delta: modelRecs.delta,
        strikeIv: modelRecs.strikeIv,
      }).from(modelRecs);

      const today = new Date().toISOString().slice(0, 10);
      const out: ByTickerResponse = {};
      const pnls: Record<string, { put: number[]; call: number[] }> = {};
      const openBest: Record<string, { put?: typeof rows[0]; call?: typeof rows[0] }> = {};

      for (const r of rows) {
        const side = r.side as "put" | "call";
        if (!out[r.ticker]) {
          out[r.ticker] = { put: emptyTickerRecord(), call: emptyTickerRecord() };
          pnls[r.ticker] = { put: [], call: [] };
          openBest[r.ticker] = {};
        }
        if (r.status === "WIN" || r.status === "LOSS") {
          if (r.status === "WIN") out[r.ticker]![side].wins++;
          else out[r.ticker]![side].losses++;
          const p = num(r.pnlPct);
          if (p != null) pnls[r.ticker]![side].push(p);
        }
        if (r.expiry >= today) {
          const prev = openBest[r.ticker]![side];
          if (!prev || r.snapshotDate > prev.snapshotDate) openBest[r.ticker]![side] = r;
        }
      }

      for (const [ticker, sides] of Object.entries(out)) {
        for (const side of ["put", "call"] as const) {
          sides[side].sharpe = sharpeFromPnls(pnls[ticker]?.[side] ?? []);
          const open = openBest[ticker]?.[side];
          if (open) {
            sides[side].openSpot = num(open.spot);
            sides[side].openSnapshotDate = open.snapshotDate;
            sides[side].entryDelta = num(open.delta);
            sides[side].entryIv = num(open.strikeIv);
          }
        }
      }
      return out;
    });
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /track-record/ticker-summary ──────────────────────────────────────────
// One row per ticker the model has ever graded, put/call broken out into columns —
// powers the Track Record page table (replaces the old flat 20-row "Recent Recs"
// list, which mixed all tickers/sides together and cut off most of a large watchlist).

interface TickerSideAgg {
  n: number; wins: number; losses: number; winRate: number | null;
  avgPnlPct: number | null; pending: number; assigned: number; noData: number;
  avgIncomePct: number | null;
  avgAbsMovePct: number | null;
  /** Endpoint adverse (settle vs spot) — fallback when path MAE missing. */
  avgAdverseMovePct: number | null;
  /** Avg max adverse excursion from daily highs/lows (path MAE). */
  avgMaxAdversePct: number | null;
  /** Avg % of OTM cushion consumed on the path. */
  avgCushionUsedPct: number | null;
  sharpe: number | null;
}
/** The model's current best pick for a side — most recent snapshot not yet expired. */
interface CurrentPick {
  strike: number; expiry: string; premium: number; incomePct: number | null; dte: number | null;
  snapshotDate: string;
  spot: number;
  /** Live path MAE since Init (null if no bars). */
  maxAdversePct: number | null;
  cushionUsedPct: number | null;
  /** Option Greek delta at snapshot (entry). */
  delta: number | null;
  /** Strike IV at snapshot (entry), decimal or % as stored. */
  strikeIv: number | null;
}
interface TickerSummaryRow {
  ticker: string; put: TickerSideAgg; call: TickerSideAgg;
  currentPrice: number | null; priceChangePct: number | null;
  currentPut: CurrentPick | null; currentCall: CurrentPick | null;
}

type RecRow = {
  status: string; pnlPct: string | null; snapshotDate: string; expiry: string;
  strike: string; premium: string; incomePct: string | null; dte: string | null;
  spot: string; settleClose: string | null;
  componentScores: unknown;
  delta: string | null;
  strikeIv: string | null;
};

function readPathRisk(cs: unknown): PathRisk | null {
  const p = (cs as { _pathRisk?: PathRisk } | null)?.["_pathRisk"];
  if (!p || typeof p.maxAdversePct !== "number") return null;
  return p;
}

function aggregateSide(rows: RecRow[], side: "put" | "call"): TickerSideAgg {
  const graded = rows.filter(r => r.status === "WIN" || r.status === "LOSS");
  const wins = graded.filter(r => r.status === "WIN").length;
  const pnls = graded.map(r => num(r.pnlPct)).filter((v): v is number => v != null);
  const incomes = graded.map(r => num(r.incomePct)).filter((v): v is number => v != null);
  const absMoves: number[] = [];
  const endpointAdverse: number[] = [];
  const pathAdverse: number[] = [];
  const cushions: number[] = [];
  for (const r of graded) {
    const spot = num(r.spot);
    const settle = num(r.settleClose);
    if (spot != null && spot > 0 && settle != null) {
      const ret = (settle - spot) / spot;
      absMoves.push(Math.abs(ret) * 100);
      endpointAdverse.push((side === "put" ? Math.max(0, -ret) : Math.max(0, ret)) * 100);
    }
    const path = readPathRisk(r.componentScores);
    if (path) {
      pathAdverse.push(path.maxAdversePct);
      if (path.cushionUsedPct != null) cushions.push(path.cushionUsedPct);
    }
  }
  const avg = (xs: number[]) => xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  const avgIncomePct = avg(incomes);
  const avgAbsMovePct = avg(absMoves);
  const avgAdverseMovePct = avg(endpointAdverse);
  const avgMaxAdversePct = avg(pathAdverse);
  const avgCushionUsedPct = avg(cushions);

  let sharpe: number | null = null;
  if (pnls.length >= 3) {
    const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1);
    const stdev = Math.sqrt(variance);
    if (stdev > 1e-6) sharpe = mean / stdev;
  }

  return {
    n: graded.length,
    wins,
    losses: graded.length - wins,
    winRate: graded.length > 0 ? wins / graded.length : null,
    avgPnlPct: avg(pnls),
    pending: rows.filter(r => r.status === "PENDING").length,
    assigned: rows.filter(r => r.status === "ASSIGNED").length,
    noData: rows.filter(r => r.status === "NO_DATA").length,
    avgIncomePct,
    avgAbsMovePct,
    avgAdverseMovePct,
    avgMaxAdversePct,
    avgCushionUsedPct,
    sharpe,
  };
}

/** Read path MAE from graded componentScores — never recompute on the request path. */
function pathFromScores(cs: unknown): { maxAdversePct: number | null; cushionUsedPct: number | null } {
  const pr = (cs as { _pathRisk?: { maxAdversePct?: unknown; cushionUsedPct?: unknown } } | null)?._pathRisk;
  if (!pr) return { maxAdversePct: null, cushionUsedPct: null };
  return {
    maxAdversePct: typeof pr.maxAdversePct === "number" && Number.isFinite(pr.maxAdversePct) ? pr.maxAdversePct : null,
    cushionUsedPct: typeof pr.cushionUsedPct === "number" && Number.isFinite(pr.cushionUsedPct) ? pr.cushionUsedPct : null,
  };
}

/** Latest snapshot for this side, but only surfaced while its expiry hasn't passed yet. */
function currentPick(rows: RecRow[], todayStr: string): CurrentPick | null {
  const latest = rows.slice().sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))[0];
  if (!latest || latest.expiry < todayStr) return null;
  const spot = num(latest.spot);
  const strike = num(latest.strike);
  const premium = num(latest.premium);
  if (spot == null || strike == null || premium == null) return null;
  const path = pathFromScores(latest.componentScores);
  return {
    strike,
    expiry: latest.expiry,
    premium,
    incomePct: num(latest.incomePct),
    dte: num(latest.dte),
    snapshotDate: latest.snapshotDate,
    spot,
    maxAdversePct: path.maxAdversePct,
    cushionUsedPct: path.cushionUsedPct,
    delta: num(latest.delta),
    strikeIv: num(latest.strikeIv),
  };
}

router.get("/track-record/ticker-summary", async (_req, res) => {
  try {
    // Opportunistic backfill — never block page load.
    void backfillPathRisk(40).catch(() => null);

    // Aggregate + live prices only (path MAE from stored scores). Fast cold + warm.
    const enriched = await trackRecordCache.getOrCompute("ticker-summary-enriched-v7", async () => {
      const data = await trackRecordCache.getOrCompute("ticker-summary-v5", async () => {
        const rows = await db.select({
          ticker: modelRecs.ticker, side: modelRecs.side, status: modelRecs.status, pnlPct: modelRecs.pnlPct,
          snapshotDate: modelRecs.snapshotDate, expiry: modelRecs.expiry, strike: modelRecs.strike,
          premium: modelRecs.premium, incomePct: modelRecs.incomePct, dte: modelRecs.dte,
          spot: modelRecs.spot, settleClose: modelRecs.settleClose,
          componentScores: modelRecs.componentScores,
          delta: modelRecs.delta, strikeIv: modelRecs.strikeIv,
        }).from(modelRecs);

        const byTicker = new Map<string, { put: RecRow[]; call: RecRow[] }>();
        for (const r of rows) {
          const side = r.side as "put" | "call";
          if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, { put: [], call: [] });
          byTicker.get(r.ticker)![side].push(r);
        }

        const todayStr = new Date().toISOString().slice(0, 10);
        const out: Omit<TickerSummaryRow, "currentPrice" | "priceChangePct">[] = [...byTicker.entries()].map(([ticker, sides]) => ({
          ticker,
          put: aggregateSide(sides.put, "put"),
          call: aggregateSide(sides.call, "call"),
          currentPut: currentPick(sides.put, todayStr),
          currentCall: currentPick(sides.call, todayStr),
        }));
        out.sort((a, b) => a.ticker.localeCompare(b.ticker));
        return out;
      });

      const tickers = (data as Array<{ ticker: string }>).map(r => r.ticker);
      const live = await getLivePrices(tickers);
      const base = data as Array<Omit<TickerSummaryRow, "currentPrice" | "priceChangePct">>;
      return base.map((r) => ({
        ...r,
        currentPrice: live.get(r.ticker)?.price ?? null,
        priceChangePct: live.get(r.ticker)?.changePercent ?? null,
      }));
    });

    return res.json(enriched);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /track-record/recs ────────────────────────────────────────────────────

router.get("/track-record/recs", async (req, res) => {
  try {
    const side = req.query["side"] === "call" ? "call" : req.query["side"] === "put" ? "put" : null;
    const status = typeof req.query["status"] === "string" ? req.query["status"].toUpperCase() : null;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query["limit"] ?? "100"), 10) || 100));

    const conditions = [];
    if (side) conditions.push(eq(modelRecs.side, side));
    if (status && ["PENDING", "ASSIGNED", "WIN", "LOSS", "NO_DATA"].includes(status)) conditions.push(eq(modelRecs.status, status));

    const rows = await db.select().from(modelRecs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(modelRecs.snapshotDate), asc(modelRecs.ticker))
      .limit(limit);
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /track-record/regime ──────────────────────────────────────────────────
// Accuracy grid: regime × horizon → { n, correct, partial, incorrect, avgFwdReturn, avgMaxDrawdown }.

router.get("/track-record/regime", async (_req, res) => {
  try {
    const data = await trackRecordCache.getOrCompute("regime", async () => {
      const rows = await db.select().from(regimeGrades);
      const cells = new Map<string, {
        regime: string; horizon: string; expectedDirection: string;
        n: number; correct: number; partial: number; incorrect: number; pending: number; noData: number;
        fwdSum: number; ddSum: number; fwdN: number;
      }>();
      for (const r of rows) {
        const key = `${r.regime}|${r.horizon}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { regime: r.regime, horizon: r.horizon, expectedDirection: r.expectedDirection,
                   n: 0, correct: 0, partial: 0, incorrect: 0, pending: 0, noData: 0, fwdSum: 0, ddSum: 0, fwdN: 0 };
          cells.set(key, cell);
        }
        if (r.grade === "pending") { cell.pending++; continue; }
        if (r.grade === "no_data") { cell.noData++; continue; }
        cell.n++;
        if (r.grade === "correct") cell.correct++;
        else if (r.grade === "partial") cell.partial++;
        else cell.incorrect++;
        const fwd = num(r.fwdReturnPct);
        const dd = num(r.maxDrawdownPct);
        if (fwd != null) { cell.fwdSum += fwd; cell.fwdN++; }
        if (dd != null) cell.ddSum += dd;
      }
      const grid = [...cells.values()].map(c => ({
        regime: c.regime, horizon: c.horizon, expectedDirection: c.expectedDirection,
        n: c.n, correct: c.correct, partial: c.partial, incorrect: c.incorrect,
        pending: c.pending, noData: c.noData,
        correctPct: c.n > 0 ? c.correct / c.n : null,
        avgFwdReturnPct: c.fwdN > 0 ? c.fwdSum / c.fwdN : null,
        avgMaxDrawdownPct: c.fwdN > 0 ? c.ddSum / c.fwdN : null,
      }));
      return { grid, generatedAt: Date.now() };
    });
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /track-record/tilt ────────────────────────────────────────────────────
// Current tilt + the effective default strike weights each side would use —
// the client applies these to DEFAULT weights only (user overrides always win).

router.get("/track-record/tilt", async (_req, res) => {
  try {
    const state = await getTiltState();
    const put = applyPolicy(state.put);
    const call = applyPolicy(state.call, CALL_STRIKE_WEIGHTS);
    const calibration = await getCalibrationTable();
    return res.json({
      state,
      put: {
        factor: put.factor,
        weights: put.weights,
        sqFloor: put.sqFloor,
        earningsHaircut: put.earningsHaircut,
        version: put.version,
      },
      call: {
        factor: call.factor,
        weights: call.weights,
        sqFloor: call.sqFloor,
        earningsHaircut: call.earningsHaircut,
        version: call.version,
      },
      calibration,
      minN: TILT_MIN_N,
      minExpiries: TILT_MIN_EXPIRIES,
      sqFloorBase: SQ_FLOOR_BASE,
      anchorPnlPct: TILT_ANCHOR_PNL_PCT,
      spanPnlPct: TILT_SPAN_PNL_PCT,
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/track-record/run", requireAdmin, async (req, res) => {
  try {
    const { snapshot, grade, seedFixture, reset } = (req.body ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    if (reset === true) result["reset"] = await resetModelTrackRecord();
    if (seedFixture === true) result["seeded"] = await seedFixtures();
    if (snapshot === true) result["snapshot"] = await runModelSnapshot();
    if (grade === true) {
      await runModelGrading();
      result["graded"] = true;
    }
    trackRecordCache.clear();
    return res.json(result);
  } catch (err: any) {
    logger.error({ err }, "track-record: manual run failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── Fixture seeding (admin/testing only) ──────────────────────────────────────
// Back-dated synthetic recs against tickers that actually have price history, so
// gradeModelRecs/gradeHotlistSnapshots settle them immediately on the next grade run.

async function seedFixtures(): Promise<{ recs: number; hotlist: number; regimeStubs: number }> {
  // Tickers with enough history: ≥6 bars in the last 30 days.
  const candidates = await db.execute<{ ticker: string; bars: number }>(sql`
    SELECT ticker, COUNT(*)::int AS bars FROM prices_historical
    WHERE date > (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY ticker HAVING COUNT(*) >= 6
    ORDER BY ticker LIMIT 4
  `);
  const tickers = candidates.rows.map(r => r.ticker);
  if (tickers.length === 0) return { recs: 0, hotlist: 0, regimeStubs: 0 };

  const snapshotDate = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);
  const expiry = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  let recs = 0;
  let hotlist = 0;
  for (const ticker of tickers) {
    const [bar] = await db.select({ close: pricesHistorical.close }).from(pricesHistorical)
      .where(and(eq(pricesHistorical.ticker, ticker), sql`${pricesHistorical.date} <= ${snapshotDate}`))
      .orderBy(desc(pricesHistorical.date)).limit(1);
    const spot = bar?.close != null ? Number(bar.close) : null;
    if (spot == null || spot <= 0) continue;

    for (const side of ["put", "call"] as const) {
      // ~7% OTM strike, 1% premium — realistic enough for settlement math.
      const strike = side === "put" ? spot * 0.93 : spot * 1.07;
      const inserted = await db.insert(modelRecs).values({
        snapshotDate, ticker, side, expiry,
        strike: String(Math.round(strike * 100) / 100),
        spot: String(spot),
        premium: String(Math.round(spot * 0.01 * 100) / 100),
        bidIsLive: false,
        optionScore: "50",
        componentScores: { fixture: { score: null, weight: 0 } },
        volRegime: "BASELINE",
        macroRegime: "fixture",
        tiltApplied: { factor: 0, weights: {} },
      }).onConflictDoNothing({ target: [modelRecs.snapshotDate, modelRecs.ticker, modelRecs.side] })
        .returning({ id: modelRecs.id });
      recs += inserted.length;
    }

    const insertedHot = await db.insert(hotlistSnapshots).values({
      snapshotDate, ticker, side: "dip", signal: "GO", price: String(spot), rsi: "25", mfi: "18",
    }).onConflictDoNothing({ target: [hotlistSnapshots.snapshotDate, hotlistSnapshots.ticker, hotlistSnapshots.side] })
      .returning({ id: hotlistSnapshots.id });
    hotlist += insertedHot.length;
  }

  const regimeStubs = await insertRegimeGradeStubs();
  logger.info({ recs, hotlist, regimeStubs, tickers }, "track-record: fixtures seeded");
  return { recs, hotlist, regimeStubs };
}

export default router;
