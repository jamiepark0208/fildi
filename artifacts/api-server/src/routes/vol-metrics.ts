/**
 * Breakdown › Options history › IV rank panel (Claude 10-24, Jamie: "I need it somewhere on the UI to know what's going on").
 * Reads only the DB (no vendor call, no cache needed):
 *   tastytrade  ← watchlist_sync.tasty_metrics_daily (daily.py `tastytrade.py universe`) + latest vendor_raw payload (IV by expiry)
 *   LSEG        ← lseg_research.daily_history iv30_put, 1-year percentile = fit_model_v14.iv_ranks (Model List PREMIUM input)
 *   technicals  ← ticker_technicals.iv_rank (realized-vol proxy; shown so the gap is visible)
 * GET /api/stocks/:ticker/vol-metrics
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const LSEG_MIN_DAYS = 120;     // same floor as fit_model_v14.iv_ranks
const LSEG_MAX_AGE_DAYS = 7;   // same as fit_model_v14.LSEG_MAX_AGE_DAYS

async function safe<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return rowsOf<T>((await db.execute(q)) as SqlRows<never>);
  } catch {
    return [];
  }
}

router.get("/stocks/:ticker/vol-metrics", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  const history = await safe<Record<string, unknown>>(sql`
    SELECT date::text, iv_index::float8 AS "ivIndex", iv_index_5d_change::float8 AS "ivIndex5dChange", iv_rank::float8 AS "ivRank",
           iv_percentile::float8 AS "ivPercentile", liquidity_rating AS "liquidityRating", liquidity_rank::float8 AS "liquidityRank"
    FROM watchlist_sync.tasty_metrics_daily WHERE ticker = ${t} ORDER BY date`);
  const raw = await safe<{ term: { "expiration-date": string; "implied-volatility": string }[] | null }>(sql`
    SELECT payload->'option-expiration-implied-volatilities' AS term FROM vendor_raw
    WHERE source = 'tastytrade' AND endpoint = '/market-metrics' AND key = ${t.replace(".", "/")}
    ORDER BY fetched_on DESC LIMIT 1`);
  const today = new Date().toISOString().slice(0, 10);
  const term = (raw[0]?.term ?? [])
    .map((x) => ({ expiry: x["expiration-date"], iv: Number(x["implied-volatility"]) }))
    .filter((x) => x.expiry >= today && Number.isFinite(x.iv) && x.iv > 0 && x.iv < 5);
  const lseg = await safe<{ pct: number | null; days: number; asOf: string | null }>(sql`
    WITH h AS (SELECT date, iv30_put::float8 v FROM lseg_research.daily_history
               WHERE ticker = ${t} AND date > CURRENT_DATE - 365 AND iv30_put > 0),
         l AS (SELECT date, v FROM h ORDER BY date DESC LIMIT 1)
    SELECT (SELECT count(*) FROM h WHERE h.date < l.date AND h.v <= l.v)::float8 / NULLIF((SELECT count(*) FROM h) - 1, 0) AS pct,
           (SELECT count(*) FROM h)::int AS days, l.date::text AS "asOf" FROM l`);
  const l = lseg[0];
  const lsegOk = l && l.days >= LSEG_MIN_DAYS && l.asOf && (Date.now() - Date.parse(l.asOf)) / 864e5 <= LSEG_MAX_AGE_DAYS;
  const tech = await safe<{ ivRank: number | null; source: string | null }>(sql`
    SELECT iv_rank::float8 AS "ivRank", iv_rank_source AS source FROM ticker_technicals WHERE ticker = ${t} LIMIT 1`);
  return res.json({
    ticker: t,
    tasty: history[history.length - 1] ?? null,
    history,
    term,
    lseg: l ? { ivPercentile: lsegOk ? l.pct : null, days: l.days, asOf: l.asOf, usedByModelList: !!lsegOk } : null,
    technicals: tech[0] ?? null,
  });
});

export default router;
