/**
 * GET /api/pm/alerts → latest Portfolio Alerts run (Live › Portfolio Alerts).
 * GET /api/pm/names  → "Your names": short interest (LSEG), next earnings, latest earnings-call summary (transcripts.py).
 * GET /api/pm/book   → book-latest.json (A76 Book card / Expiry desk).
 * Written by scripts/watchlist_sync/pm_alerts.py + pm_book.py (Claude, PM role); this route only reads.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BOOK_PATH = resolve(ROOT, "scripts/watchlist_sync/out/pm/book-latest.json");
let bookCache: { mtimeMs: number; at: number; body: unknown } | null = null;
const BOOK_TTL_MS = 60_000;

function readPmBook(): unknown | null {
  if (!existsSync(BOOK_PATH)) return null;
  const mtimeMs = statSync(BOOK_PATH).mtimeMs;
  const now = Date.now();
  if (bookCache && bookCache.mtimeMs === mtimeMs && now - bookCache.at < BOOK_TTL_MS) {
    return bookCache.body;
  }
  try {
    const body = JSON.parse(readFileSync(BOOK_PATH, "utf8"));
    bookCache = { mtimeMs, at: now, body };
    return body;
  } catch {
    return null;
  }
}

router.get("/pm/book", requireAdmin, (_req, res) => {
  const book = readPmBook();
  if (!book) return res.json({ book: null });
  return res.json({ book });
});

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

type NameRow = {
  ticker: string; short_pct: number | null; free_float: number | null; next_earnings: string | null;
  quarter: string | null; summary: unknown; av_sentiment: number | null; held_shares: boolean; short_options: number;
};

router.get("/pm/names", requireAdmin, async (_req, res, next) => {
  try {
    const ok = rowsOf<{ ok: boolean }>(await db.execute(sql`
      SELECT to_regclass('watchlist_sync.earnings_transcripts') IS NOT NULL AS ok`) as SqlRows<{ ok: boolean }>)[0]?.ok;
    const transcripts = ok
      ? sql`(SELECT DISTINCT ON (ticker) ticker, quarter, summary, av_sentiment FROM watchlist_sync.earnings_transcripts
              WHERE status = 'ok' ORDER BY ticker, quarter DESC)`
      : sql`(SELECT NULL::text AS ticker, NULL::text AS quarter, NULL::jsonb AS summary, NULL::float8 AS av_sentiment WHERE false)`;
    const names = rowsOf<NameRow>(await db.execute(sql`
      WITH snap AS (SELECT MAX(id) AS id FROM portfolio_snapshots),
      book AS (
        SELECT UPPER(symbol) AS ticker, true AS held_shares, 0 AS short_options FROM portfolio_positions, snap WHERE snapshot_id = snap.id
        UNION ALL
        SELECT UPPER(symbol), false, 1 FROM portfolio_options, snap
          WHERE snapshot_id = snap.id AND direction = 'short' AND expiration >= CURRENT_DATE),
      b AS (SELECT ticker, bool_or(held_shares) AS held_shares, SUM(short_options)::int AS short_options FROM book GROUP BY ticker)
      SELECT b.ticker, b.held_shares, b.short_options, l.short_pct::float8 AS short_pct, l.free_float::float8 AS free_float,
             (SELECT MIN(report_date::date)::text FROM earnings_calendar e WHERE UPPER(e.ticker) = b.ticker AND report_date::date >= CURRENT_DATE)
               AS next_earnings,
             t.quarter, t.summary, t.av_sentiment
      FROM b
      LEFT JOIN LATERAL (SELECT short_pct, free_float FROM lseg_research.signals_daily s WHERE s.ticker = b.ticker
                         ORDER BY as_of DESC LIMIT 1) l ON true
      LEFT JOIN ${transcripts} t ON t.ticker = b.ticker
      ORDER BY b.short_options DESC, b.ticker`) as SqlRows<NameRow>);
    return res.json({ names });
  } catch (err) {
    return next(err);
  }
});

export default router;
