/**
 * Rankings › Long options (S086, A244). Latest watchlist_sync.long_option_board row, written daily by
 * scripts/watchlist_sync/analysis/s086_strategy_board.py (payload carries the forward paper record per arm from
 * forecast_ledger, graded at expiry by forecast_ledger._r_structure).
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /api/options/long-board — must be registered before optionsRouter (its /options/:ticker would match).
router.get("/options/long-board", async (_req, res) => {
  try {
    const board = await db.execute(sql`
      SELECT payload FROM watchlist_sync.long_option_board ORDER BY as_of DESC LIMIT 1`);
    // A244 S171 paper angle (scripts/watchlist_sync/s171_paper.py → forecast_ledger, graded day 3 by _r_long_call_ts)
    const s171 = await db.execute(sql`
      SELECT DISTINCT ON (question_id) subject AS ticker, made_on::text AS "entry", resolves_on::text AS "gradeOn",
             outcome AS "beat", (meta->>'strike')::float8 AS strike, meta->>'expiry' AS expiry,
             (meta->>'debit')::float8 AS ask, (meta->>'delta')::float8 AS delta,
             (meta->>'ret_call')::float8 AS "retCall", (meta->>'vs_delta')::float8 AS "vsDelta", meta->>'exit_fill' AS "exitFill"
      FROM watchlist_sync.forecast_ledger WHERE forecaster = 'S171'
      ORDER BY question_id, made_at DESC`);
    const picks = (s171.rows as { entry: string; vsDelta: number | null }[])
      .sort((a, b) => b.entry.localeCompare(a.entry));
    // promote trigger (A244): ≥ 100 graded, mean vs same-Δ stock > 0, t ≥ 2 clustered by entry date
    const graded = picks.filter((p) => p.vsDelta != null);
    const byDate = new Map<string, number[]>();
    for (const p of graded) byDate.set(p.entry, [...(byDate.get(p.entry) ?? []), p.vsDelta as number]);
    const dm = [...byDate.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    const mean = graded.length ? graded.reduce((a, p) => a + (p.vsDelta as number), 0) / graded.length : null;
    const dMean = dm.length ? dm.reduce((a, b) => a + b, 0) / dm.length : 0;
    const sd = dm.length > 1 ? Math.sqrt(dm.reduce((a, b) => a + (b - dMean) ** 2, 0) / (dm.length - 1)) : 0;
    const s171Summary = { n: graded.length, open: picks.length - graded.length, dates: dm.length, meanVsDelta: mean,
      t: sd > 0 ? dMean / (sd / Math.sqrt(dm.length)) : null };
    // S172 bottom signal (scripts/watchlist_sync/s172_paper.py): VIX÷VIX3M curve + index calls (graded at expiry) + put signals
    const s172 = await db.execute(sql`
      SELECT DISTINCT ON (question_id) subject AS ticker, made_on::text AS "entry", resolves_on::text AS "gradeOn",
             outcome AS "beat", (meta->>'strike')::float8 AS strike, meta->>'expiry' AS expiry,
             (meta->>'debit')::float8 AS ask, (meta->>'delta')::float8 AS delta,
             (meta->>'ret_call')::float8 AS "retCall", (meta->>'vs_delta')::float8 AS "vsDelta", meta->>'exit_fill' AS "exitFill"
      FROM watchlist_sync.forecast_ledger WHERE forecaster = 'S172'
      ORDER BY question_id, made_at DESC`);
    const curve = await db.execute(sql`
      SELECT a.date::text AS date, round((a.value / b.value)::numeric, 3)::float8 AS ratio
      FROM watchlist_sync.macro_daily a JOIN watchlist_sync.macro_daily b ON b.date = a.date AND b.series = 'vix3m'
      WHERE a.series = 'vix' AND b.value > 0 ORDER BY a.date DESC LIMIT 10`);
    const s172Puts = await db.execute(sql`
      SELECT ticker, as_of::text AS "asOf", status, occ, entry_mid::float8 AS "entryMid", ret::float8 AS ret,
             (strategy_id = 'vix-uninvert-put-hibeta') AS "hiBeta", (details->>'beta60')::float8 AS beta,
             (details->>'rank')::int AS rank, (details->>'est_credit_20d')::float8 AS "cr20", (details->>'est_credit_10d')::float8 AS "cr10",
             strike::float8 AS strike, expiry::text AS expiry
      FROM watchlist_sync.strategy_signals
      WHERE strategy_id = 'vix-uninvert-put' AND as_of >= current_date - 60
         OR strategy_id = 'vix-uninvert-put-hibeta'
            AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.strategy_signals WHERE strategy_id = 'vix-uninvert-put-hibeta')
      ORDER BY as_of DESC, strategy_id, (details->>'rank')::int NULLS LAST, ticker LIMIT 400`);
    return res.json({ board: (board.rows[0] as { payload?: unknown } | undefined)?.payload ?? null,
      s171: picks.slice(0, 40), s171Summary,
      s172: { picks: (s172.rows as { entry: string }[]).sort((a, b) => b.entry.localeCompare(a.entry)).slice(0, 30),
        curve: (curve.rows as { date: string; ratio: number }[]).reverse(), puts: s172Puts.rows } });
  } catch (err) {
    logger.warn({ err }, "long-option-board read failed");
    return res.json({ board: null });
  }
});

// GET /api/options/put-ladder — Rankings › Put ladder (S088 write_put_ladder → watchlist_sync.put_ladder). Before optionsRouter too.
router.get("/options/put-ladder", async (_req, res) => {
  try {
    const r = await db.execute(sql`SELECT payload FROM watchlist_sync.put_ladder ORDER BY as_of DESC LIMIT 1`);
    return res.json({ ladder: (r.rows[0] as { payload?: unknown } | undefined)?.payload ?? null });
  } catch (err) {
    logger.warn({ err }, "put-ladder read failed");
    return res.json({ ladder: null });
  }
});

export default router;
