/**
 * Rankings › Long options (S086, A244). Latest watchlist_sync.long_option_board row (written daily by
 * scripts/watchlist_sync/analysis/s086_strategy_board.py) + the forward paper record of its ledger arms
 * (forecast_ledger rows with forecaster 'S086:<strategy>', graded at expiry by forecast_ledger._r_structure).
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
    const ledger = await db.execute(sql`
      SELECT forecaster AS arm, count(*)::int AS n,
             count(outcome)::int AS graded, count(*) FILTER (WHERE outcome)::int AS wins
      FROM watchlist_sync.forecast_ledger
      WHERE qtype = 'sim_structure' AND forecaster LIKE 'S086:%'
      GROUP BY forecaster`);
    const payload = (board.rows[0] as { payload?: unknown } | undefined)?.payload ?? null;
    return res.json({ board: payload, ledger: ledger.rows });
  } catch (err) {
    logger.warn({ err }, "long-option-board read failed");
    return res.json({ board: null, ledger: [] });
  }
});

export default router;
