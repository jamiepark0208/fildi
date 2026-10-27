/**
 * GET /api/put-manage → latest as_of rows of watchlist_sync.put_manage_daily (A280 / S103).
 * Written by scripts/watchlist_sync/put_manage.py; this route only reads.
 * Missing table → empty list (not 500).
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

router.get("/put-manage", requireAdmin, async (_req, res, next) => {
  try {
    const ok = rowsOf<{ ok: boolean }>(
      (await db.execute(sql`
        SELECT to_regclass('watchlist_sync.put_manage_daily') IS NOT NULL AS ok
      `)) as SqlRows<{ ok: boolean }>,
    )[0]?.ok;
    if (!ok) {
      res.json({ as_of: null, rows: [] });
      return;
    }
    const rows = rowsOf<{ as_of: string; payload: Record<string, unknown> }>(
      (await db.execute(sql`
        SELECT as_of::text AS as_of, payload
        FROM watchlist_sync.put_manage_daily
        WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_manage_daily)
        ORDER BY ticker, strike, expiry
      `)) as SqlRows<never>,
    );
    const asOf = rows[0]?.as_of ?? null;
    res.json({
      as_of: asOf,
      rows: rows.map((r) => ({ ...(r.payload ?? {}), as_of: r.as_of })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
