/**
 * GET /api/pm/alerts → latest Portfolio Alerts run (Live › Portfolio Alerts).
 * Written by scripts/watchlist_sync/pm_alerts.py (Claude, PM role) into watchlist_sync.pm_alerts; this route only reads it.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

router.get("/pm/alerts", requireAdmin, async (_req, res, next) => {
  try {
    const ok = rowsOf<{ ok: boolean }>(await db.execute(sql`
      SELECT to_regclass('watchlist_sync.pm_alerts') IS NOT NULL AS ok`) as SqlRows<{ ok: boolean }>)[0]?.ok;
    if (!ok) return res.json({ run: null });
    const row = rowsOf<{ generated_at: string; payload: unknown }>(await db.execute(sql`
      SELECT generated_at, payload FROM watchlist_sync.pm_alerts ORDER BY id DESC LIMIT 1`) as SqlRows<{ generated_at: string; payload: unknown }>)[0];
    return res.json({ run: row ? { generatedAt: row.generated_at, ...(row.payload as object) } : null });
  } catch (err) {
    return next(err);
  }
});

export default router;
