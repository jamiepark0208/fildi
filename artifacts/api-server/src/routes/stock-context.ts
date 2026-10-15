/**
 * Breakdown context panels (Claude, PM role, user 2026-10-14):
 * GET /api/stocks/:ticker/short-interest → history (Polygon, FINRA twice-monthly) + current % float (LSEG)
 * GET /api/stocks/:ticker/earnings-call  → stored earnings-call summaries (scripts/watchlist_sync/transcripts.py) + Street consensus
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getShortInterest } from "../lib/short-interest.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

router.get("/stocks/:ticker/short-interest", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    return res.json(await getShortInterest(t));
  } catch (err) {
    return next(err);
  }
});

router.get("/stocks/:ticker/earnings-call", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
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
    return res.json({ ticker: t, calls, street });
  } catch (err) {
    return next(err);
  }
});

export default router;
