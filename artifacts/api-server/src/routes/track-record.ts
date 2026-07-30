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
import {
  runModelSnapshot, runModelGrading, getTiltState, insertRegimeGradeStubs,
} from "../lib/model-track-record.js";
import { applyTilt, tiltFactor, CALL_STRIKE_WEIGHTS, TILT_MIN_N, TILT_ANCHOR_WIN_RATE } from "@workspace/option-scoring";
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
  pending: number;
  noData: number;
  equityCurve: Array<{ expiry: string; pnlPct: number; cumPnlPct: number; ticker: string }>;
}

async function buildSideSummary(side: "put" | "call"): Promise<SideSummary> {
  const rows = await db.select({
    status: modelRecs.status, pnlPct: modelRecs.pnlPct,
    expiry: modelRecs.expiry, ticker: modelRecs.ticker,
  }).from(modelRecs).where(eq(modelRecs.side, side)).orderBy(asc(modelRecs.expiry), asc(modelRecs.ticker));

  const graded = rows.filter(r => r.status === "WIN" || r.status === "LOSS");
  const wins = graded.filter(r => r.status === "WIN").length;
  const pnls = graded.map(r => num(r.pnlPct)).filter((v): v is number => v != null);
  let cum = 0;
  const equityCurve = graded.map(r => {
    const p = num(r.pnlPct) ?? 0;
    cum += p;
    return { expiry: r.expiry, pnlPct: p, cumPnlPct: Math.round(cum * 100) / 100, ticker: r.ticker };
  });
  return {
    n: graded.length,
    wins,
    winRate: graded.length > 0 ? wins / graded.length : null,
    avgPnlPct: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : null,
    totalPnlPct: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) : null,
    pending: rows.filter(r => r.status === "PENDING").length,
    noData: rows.filter(r => r.status === "NO_DATA").length,
    equityCurve,
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
    const data = await trackRecordCache.getOrCompute("summary", async () => {
      const [put, call, hotlist] = await Promise.all([
        buildSideSummary("put"), buildSideSummary("call"), buildHotlistSummary(),
      ]);
      return { put, call, hotlist, generatedAt: Date.now() };
    });
    return res.json(data);
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
    if (status && ["PENDING", "WIN", "LOSS", "NO_DATA"].includes(status)) conditions.push(eq(modelRecs.status, status));

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
    const put = applyTilt(state.put);
    const call = applyTilt(state.call, CALL_STRIKE_WEIGHTS);
    return res.json({
      state,
      put: { factor: put.factor, weights: put.weights },
      call: { factor: call.factor, weights: call.weights },
      minN: TILT_MIN_N,
      anchorWinRate: TILT_ANCHOR_WIN_RATE,
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── POST /track-record/run (admin) ────────────────────────────────────────────
// Manual trigger: { snapshot?, grade?, seedFixture? } — lets grading be verified
// end-to-end today (seed back-dated fixtures, grade them, inspect /summary).

router.post("/track-record/run", requireAdmin, async (req, res) => {
  try {
    const { snapshot, grade, seedFixture } = (req.body ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    if (seedFixture === true) result["seeded"] = await seedFixtures();
    if (snapshot === true) result["snapshot"] = await runModelSnapshot();
    if (grade === true) {
      await runModelGrading();
      result["graded"] = true;
    }
    trackRecordCache.clear(); // drop stale aggregates so /summary reflects this run immediately
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
