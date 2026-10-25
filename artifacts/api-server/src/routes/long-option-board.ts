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
    return res.json({ board: (board.rows[0] as { payload?: unknown } | undefined)?.payload ?? null });
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
