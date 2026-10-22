/**
 * Breakdown context panels (Claude, PM role, user 2026-10-14):
 * GET /api/stocks/:ticker/short-interest → history (Polygon, FINRA twice-monthly) + current % float (LSEG)
 * GET /api/stocks/:ticker/earnings-call  → stored earnings-call summaries (scripts/watchlist_sync/transcripts.py) + Street consensus
 * GET /api/stocks/:ticker/session-flow   → A126 Phase 1a Yahoo 5m VWAP + volume profile + estimated delta
 * GET /api/stocks/:ticker/media-sentiment → desk media rows (A214: stocktwits + call_tone; display only)
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getShortInterest } from "../lib/short-interest.js";
import { getSessionFlow } from "../lib/session-flow.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

router.get("/stocks/:ticker/short-interest", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) {
    res.status(400).json({ error: "bad ticker" });
    return;
  }
  try {
    res.json(await getShortInterest(t));
  } catch (err) {
    next(err);
  }
});

router.get("/stocks/:ticker/earnings-call", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) {
    res.status(400).json({ error: "bad ticker" });
    return;
  }
  try {
    const ok = rowsOf<{ ok: boolean }>(await db.execute(sql`
      SELECT to_regclass('watchlist_sync.earnings_transcripts') IS NOT NULL AS ok`) as SqlRows<{ ok: boolean }>)[0]?.ok;
    const calls = ok ? rowsOf<{ quarter: string; summary: unknown; av_sentiment: number | null; fetched_at: string }>(await db.execute(sql`
      SELECT quarter, summary, av_sentiment, fetched_at::text FROM watchlist_sync.earnings_transcripts
      WHERE ticker = ${t} AND status = 'ok' AND summary IS NOT NULL ORDER BY quarter DESC LIMIT 6`) as SqlRows<never>) : [];
    const street = rowsOf<Record<string, unknown>>(await db.execute(sql`
      SELECT as_of::text, revenue_mean_fy1::float8 AS revenue_mean_fy1, eps_mean_fy1::float8 AS eps_mean_fy1, fy1_period,
             eps_mean_fq1::float8 AS eps_mean_fq1, fq1_period_end::text, eps_drift_30d_pct::float8 AS eps_drift_30d_pct,
             pt_mean::float8 AS pt_mean, price_close::float8 AS price_close
      FROM lseg_research.signals_daily WHERE ticker = ${t} ORDER BY as_of DESC LIMIT 1`) as SqlRows<never>)[0] ?? null;
    res.json({ ticker: t, calls, street });
  } catch (err) {
    next(err);
  }
});

router.get("/stocks/:ticker/session-flow", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) {
    res.status(400).json({ error: "bad ticker" });
    return;
  }
  try {
    const flow = await getSessionFlow(t);
    if (!flow || flow.barCount === 0) {
      res.status(404).json({ error: "no session bars", ticker: t });
      return;
    }
    res.json(flow);
  } catch (err) {
    next(err);
  }
});

/** Latest per-source desk media lean (A214). Never Yahoo rec %. Display only — not a score input. */
router.get("/stocks/:ticker/media-sentiment", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) {
    res.status(400).json({ error: "bad ticker" });
    return;
  }
  try {
    const ok = rowsOf<{ ok: boolean }>(await db.execute(sql`
      SELECT to_regclass('watchlist_sync.media_sentiment_daily') IS NOT NULL AS ok`) as SqlRows<{ ok: boolean }>)[0]?.ok;
    if (!ok) {
      res.json({ ticker: t, sources: [], note: "media_sentiment_daily not created yet" });
      return;
    }
    const sources = rowsOf<{
      as_of: string;
      source: string;
      score: number | null;
      n: number | null;
      sample: unknown;
      fetched_at: string;
    }>(await db.execute(sql`
      SELECT DISTINCT ON (source)
        as_of::text, source, score::float8 AS score, n, sample, fetched_at::text
      FROM watchlist_sync.media_sentiment_daily
      WHERE ticker = ${t} AND source IN ('stocktwits', 'call_tone')
      ORDER BY source, as_of DESC`) as SqlRows<never>);
    res.json({
      ticker: t,
      sources,
      note: "Desk/media lean — display only; not a Model List input (A214)",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
