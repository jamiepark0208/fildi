// Nightly indicator track record (tv-indicators spec phase 2 B, Jamie 11-04).
//
// After the close: for SPY/QQQ/IWM + the Live hotlist, pull Yahoo 5m (~60 d, RTH), resample to 5m/15m/1h, run every
// registered indicator, store its events, grade each as a round trip (signal close -> next opposite signal close, else
// session close) against 50 seeded random same-side/same-length entries (+ the old ATR hit test as context), then rebuild the scorecard with the fixed verdict rule (indicator-grading.ts). Idempotent: events are unique
// per (indicator, version, ticker, tf, time, kind, side), grades and the scorecard are upserted.
//
// Runtime safety (AGENTS.md 8c): one Yahoo chart call per ticker with a 30 s deadline, <= 2 in flight, <= MAX_TICKERS
// tickers (<= 80 calls/night), 15 min wall-clock cap for the whole job, a single running guard, DB writes in batches.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, indicatorEvents, indicatorGrades, indicatorScorecard } from "@workspace/db";
import { atr, etClock, INDICATORS, resample, TF_MINUTES, type TvBar, type TvTimeframe } from "@workspace/indicators";
import { fetchIntradayHistory } from "./intraday-history.js";
import { barCtx, buildScorecard, exitFor, gradeAt, placeboHit, preMove, randomIndex, roundTrip, type ScoreInput } from "./indicator-grading.js";
import { withDeadline } from "./yahoo-client.js";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { logger } from "./logger.js";

export const CORE_UNIVERSE = ["SPY", "QQQ", "IWM"] as const;
const MAX_TICKERS = 80; // core + holdings + watchlist + hotlist; 1 Yahoo call each, 2 in flight
const MAX_HOTLIST = 12;
const FETCH_DEADLINE_MS = 30_000;
const FETCH_CONCURRENCY = 2;
const JOB_DEADLINE_MS = 15 * 60_000;
const HISTORY_DAYS = 60;
const TFS: TvTimeframe[] = ["5m", "15m", "1h"];
const BATCH = 400;

let running = false;
export let lastIndicatorGradingRun: Date | null = null;
export const indicatorGradingRunning = (): boolean => running;

export type GradingSummary = { tickers: string[]; failed: string[]; events: number; graded: number; scorecardRows: number; ms: number; stoppedEarly: boolean };

/** Core indexes + latest RH holdings + every watchlist + the Live hotlist (Jamie 11-04: grade what he trades). */
export async function gradingUniverse(): Promise<string[]> {
  const held: string[] = [];
  try {
    const r = await db.execute(sql`select distinct symbol from portfolio_positions where snapshot_id = (select max(snapshot_id) from portfolio_positions)`);
    for (const row of r.rows as { symbol: string }[]) held.push(String(row.symbol).toUpperCase());
    held.push(...(await getUnionWatchlistTickers()));
  } catch (err) {
    logger.warn({ err }, "indicator-grading: holdings/watchlist unavailable");
  }
  const hot: string[] = [];
  try {
    const { liveHotlist, deriveHotList } = await import("./live-hotlist.js");
    const cur = liveHotlist.getCurrent().filter((t) => /^[A-Z.]{1,6}$/.test(t));
    if (cur.length) hot.push(...cur);
    else for (const side of ["dip", "rally"] as const) hot.push(...(await deriveHotList(side)).map((e) => e.ticker));
  } catch (err) {
    logger.warn({ err }, "indicator-grading: hotlist unavailable, core universe only");
  }
  const ok = (t: string) => /^[A-Z.]{1,6}$/.test(t);
  return [...new Set([...CORE_UNIVERSE, ...held.filter(ok), ...hot.slice(0, MAX_HOTLIST)])].slice(0, MAX_TICKERS);
}

async function fetch5m(ticker: string): Promise<TvBar[]> {
  const sessions = await withDeadline(fetchIntradayHistory(ticker, HISTORY_DAYS), FETCH_DEADLINE_MS, `indicator-grading ${ticker}`);
  const out: TvBar[] = [];
  for (const date of [...sessions.keys()].sort()) {
    for (const b of sessions.get(date)!) out.push({ time: Math.floor(b.time / 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

const num = (v: number | null): string | null => (v == null || !Number.isFinite(v) ? null : String(v));

async function processTicker(ticker: string, today: string, sessionOpen: boolean): Promise<{ events: number; graded: number }> {
  const b5 = await fetch5m(ticker);
  if (b5.length < 200) return { events: 0, graded: 0 };
  let events = 0, graded = 0;
  for (const tf of TFS) {
    const bars = resample(b5, TF_MINUTES[tf]!);
    const atrS = atr(bars, 14);
    const ctx = barCtx(bars);
    const rix = randomIndex(bars, ctx);
    const pre = preMove(bars, atrS);
    const idx = new Map(bars.map((b, i) => [b.time, i]));
    for (const def of INDICATORS) {
      if (!def.timeframes.includes(tf)) continue;
      const out = def.compute(bars);
      const signals: { i: number; side: "buy" | "sell" }[] = [];
      for (const e of out.events) { const i = idx.get(e.time); if (i != null && e.side !== "neutral") signals.push({ i, side: e.side }); }
      const rows: (typeof indicatorEvents.$inferInsert)[] = [];
      const meta: { i: number; side: "buy" | "sell"; key: string }[] = [];
      for (const e of out.events) {
        const i = idx.get(e.time);
        if (i == null || e.side === "neutral") continue;
        const b = bars[i]!;
        if (b.lastTime + 300 < b.end) continue; // partial bucket
        if (sessionOpen && ctx.day[i] === today) continue; // today's session is not finished
        if (!Number.isFinite(atrS[i]!)) continue;
        rows.push({ indicatorId: def.id, version: def.version, ticker, tf, time: new Date(e.time * 1000), side: e.side, kind: e.kind, price: String(e.price), atr: String(atrS[i]!) });
        meta.push({ i, side: e.side, key: `${def.id}|${def.version}|${ticker}|${tf}|${e.time}|${e.kind}` });
      }
      for (let o = 0; o < rows.length; o += BATCH) {
        const slice = rows.slice(o, o + BATCH);
        const ids = await db.insert(indicatorEvents).values(slice)
          .onConflictDoUpdate({ target: [indicatorEvents.indicatorId, indicatorEvents.version, indicatorEvents.ticker, indicatorEvents.tf, indicatorEvents.time, indicatorEvents.kind, indicatorEvents.side], set: { atr: sql`excluded.atr` } })
          .returning({ id: indicatorEvents.id, time: indicatorEvents.time, kind: indicatorEvents.kind, side: indicatorEvents.side });
        const byKey = new Map(ids.map((r) => [`${Math.floor(r.time.getTime() / 1000)}|${r.kind}|${r.side}`, r.id]));
        const gradeRows: (typeof indicatorGrades.$inferInsert)[] = [];
        slice.forEach((r, k) => {
          const m = meta[o + k]!;
          const id = byKey.get(`${Math.floor(r.time.getTime() / 1000)}|${r.kind}|${r.side}`);
          if (id == null) return;
          const g = gradeAt(bars, m.i, m.side, atrS[m.i]!, ctx);
          if (g.hit == null) return;
          const rt = roundTrip(bars, m.i, m.side, exitFor(m.i, m.side, signals, ctx), rix, `rt|${m.key}`, atrS, pre, TF_MINUTES[tf]!);
          gradeRows.push({
            rtPct: num(rt?.rtPct ?? null), rtBars: rt?.rtBars ?? null, rtExit: rt?.rtExit ?? null,
            rtRandomPct: num(rt?.rtRandomPct ?? null), rtRandomWin: num(rt?.rtRandomWin ?? null),
            absPct: num(rt?.absPct ?? null), randomAbsPct: num(rt?.randomAbsPct ?? null), noBreach: rt?.noBreach ?? null,
            randomNoBreach: num(rt?.randomNoBreach ?? null), target: rt?.target ?? null, randomTarget: num(rt?.randomTarget ?? null),
            bracket: rt?.bracket ?? null, randomBracket: num(rt?.randomBracket ?? null), volMatched: rt?.volMatched ?? null,
            eventId: id, fwd30mPct: num(g.fwd30mPct), fwd60mPct: num(g.fwd60mPct), fwdClosePct: num(g.fwdClosePct),
            mfeAtr: num(g.mfeAtr), maeAtr: num(g.maeAtr), hit: g.hit, placeboHit: placeboHit(bars, atrS, m.i, m.side, m.key, ctx), gradedAt: new Date(),
          });
        });
        if (gradeRows.length) {
          await db.insert(indicatorGrades).values(gradeRows).onConflictDoUpdate({
            target: indicatorGrades.eventId,
            set: { fwd30mPct: sql`excluded.fwd_30m_pct`, fwd60mPct: sql`excluded.fwd_60m_pct`, fwdClosePct: sql`excluded.fwd_close_pct`, mfeAtr: sql`excluded.mfe_atr`, maeAtr: sql`excluded.mae_atr`, hit: sql`excluded.hit`, placeboHit: sql`excluded.placebo_hit`,
              rtPct: sql`excluded.rt_pct`, rtBars: sql`excluded.rt_bars`, rtExit: sql`excluded.rt_exit`, rtRandomPct: sql`excluded.rt_random_pct`, rtRandomWin: sql`excluded.rt_random_win`,
              absPct: sql`excluded.abs_pct`, randomAbsPct: sql`excluded.random_abs_pct`, noBreach: sql`excluded.no_breach`, randomNoBreach: sql`excluded.random_no_breach`, target: sql`excluded.target`, randomTarget: sql`excluded.random_target`, bracket: sql`excluded.bracket`, randomBracket: sql`excluded.random_bracket`, volMatched: sql`excluded.vol_matched`, gradedAt: sql`excluded.graded_at` },
          });
        }
        events += slice.length;
        graded += gradeRows.length;
      }
    }
  }
  return { events, graded };
}

/** Rebuild the scorecard from every graded event in the DB (the fixed verdict rule lives in indicator-grading.ts). */
export async function rebuildScorecard(): Promise<number> {
  const res = await db.select({
    indicatorId: indicatorEvents.indicatorId, version: indicatorEvents.version, kind: indicatorEvents.kind, tf: indicatorEvents.tf,
    time: indicatorEvents.time, hit: indicatorGrades.hit, placeboHit: indicatorGrades.placeboHit,
    rtPct: indicatorGrades.rtPct, rtRandomPct: indicatorGrades.rtRandomPct, rtRandomWin: indicatorGrades.rtRandomWin, side: indicatorEvents.side,
    absPct: indicatorGrades.absPct, randomAbsPct: indicatorGrades.randomAbsPct, noBreach: indicatorGrades.noBreach,
    randomNoBreach: indicatorGrades.randomNoBreach, target: indicatorGrades.target, randomTarget: indicatorGrades.randomTarget,
    bracket: indicatorGrades.bracket, randomBracket: indicatorGrades.randomBracket,
  }).from(indicatorGrades).innerJoin(indicatorEvents, eq(indicatorEvents.id, indicatorGrades.eventId));
  const inputs: ScoreInput[] = [];
  for (const r of res) {
    if (r.rtPct == null || r.rtRandomPct == null) continue;
    const t = Math.floor(r.time.getTime() / 1000);
    inputs.push({
      indicatorId: r.indicatorId, version: r.version, kind: r.kind, tf: r.tf, day: etClock(t)[0], time: t,
      rtPct: Number(r.rtPct), rtRandomPct: Number(r.rtRandomPct), rtRandomWin: r.rtRandomWin == null ? null : Number(r.rtRandomWin),
      hit: r.hit, placeboHit: r.placeboHit, side: r.side === "sell" ? "sell" : "buy",
      absPct: r.absPct == null ? null : Number(r.absPct), randomAbsPct: r.randomAbsPct == null ? null : Number(r.randomAbsPct),
      noBreach: r.noBreach, randomNoBreach: r.randomNoBreach == null ? null : Number(r.randomNoBreach),
      target: r.target, randomTarget: r.randomTarget == null ? null : Number(r.randomTarget),
      bracket: r.bracket, randomBracket: r.randomBracket == null ? null : Number(r.randomBracket),
    });
  }
  const rows = buildScorecard(inputs);
  if (!rows.length) return 0;
  const now = new Date();
  const vals = rows.map((r) => ({
    indicatorId: r.indicatorId, version: r.version, kind: r.kind, tf: r.tf, n: r.n,
    winPct: String(r.winPct), randomWinPct: num(r.randomWinPct), avgRtPct: String(r.avgRtPct), randomRtPct: String(r.randomRtPct),
    liftPct: String(r.liftPct), mdePct: Number.isFinite(r.mdePct) ? String(r.mdePct) : null,
    hitPct: num(r.hitPct), placeboHitPct: num(r.placeboHitPct), liftPts: num(r.liftPts), mdePts: null,
    tStat: String(r.tStat), signBothHalves: r.signBothHalves,
    pWin: String(r.pWin), pWinLo: String(r.pWinLo), pWinHi: String(r.pWinHi), bestStructure: r.bestStructure,
    structures: JSON.parse(JSON.stringify(r.structures, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v))),
    verdict: r.verdict, needMore: r.needMore, days: r.days, gradedThrough: new Date(r.gradedThrough * 1000), updatedAt: now,
  }));
  await db.transaction(async (tx) => {
    await tx.delete(indicatorScorecard).where(inArray(indicatorScorecard.indicatorId, [...new Set(vals.map((v) => v.indicatorId))]));
    for (let o = 0; o < vals.length; o += BATCH) await tx.insert(indicatorScorecard).values(vals.slice(o, o + BATCH));
  });
  return vals.length;
}

export async function runIndicatorGrading(opts: { tickers?: string[] } = {}): Promise<GradingSummary> {
  if (running) throw new Error("indicator grading already running");
  running = true;
  const t0 = Date.now();
  const sum: GradingSummary = { tickers: [], failed: [], events: 0, graded: 0, scorecardRows: 0, ms: 0, stoppedEarly: false };
  try {
    const universe = (opts.tickers?.length ? opts.tickers : await gradingUniverse()).slice(0, MAX_TICKERS);
    const [today, mod] = etClock(Math.floor(Date.now() / 1000));
    const sessionOpen = new Date().getUTCDay() % 6 !== 0 && mod < 16 * 60 + 15;
    const queue = [...universe];
    const worker = async (): Promise<void> => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        if (Date.now() - t0 > JOB_DEADLINE_MS) { sum.stoppedEarly = true; return; }
        try {
          const r = await processTicker(t, today, sessionOpen);
          sum.tickers.push(t); sum.events += r.events; sum.graded += r.graded;
        } catch (err) {
          sum.failed.push(t);
          logger.warn({ err, ticker: t }, "indicator-grading: ticker failed");
        }
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    sum.scorecardRows = await rebuildScorecard();
    lastIndicatorGradingRun = new Date();
  } finally {
    running = false;
    sum.ms = Date.now() - t0;
    logger.info(sum, "indicator-grading: done");
  }
  return sum;
}

/** Heartbeat hook: weekdays after 16:20 ET, once per ET date. */
export async function runIndicatorGradingIfDue(): Promise<void> {
  if (running) return;
  const [today, mod] = etClock(Math.floor(Date.now() / 1000));
  const dow = new Date().getUTCDay();
  if (dow === 0 || dow === 6 || mod < 16 * 60 + 20) return;
  if (lastIndicatorGradingRun && etClock(Math.floor(lastIndicatorGradingRun.getTime() / 1000))[0] === today) return;
  const [row] = await db.select({ u: sql<Date | null>`max(${indicatorScorecard.updatedAt})` }).from(indicatorScorecard);
  if (row?.u && etClock(Math.floor(new Date(row.u).getTime() / 1000))[0] === today) { lastIndicatorGradingRun = new Date(row.u); return; }
  await runIndicatorGrading().catch((err) => logger.warn({ err }, "indicator-grading: nightly run failed"));
}
