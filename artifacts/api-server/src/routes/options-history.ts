/**
 * Option price history views (Claude, PM role, user 2026-10-14). Tables written by scripts/watchlist_sync/analysis/option_derive.py
 * (schema optlab, Polygon EOD option bars); this route only reads.
 * GET /api/stocks/:ticker/options-history → earnings moves (implied vs actual) + 30-day IV / realized vol / true IV rank
 * GET /api/pm/trades/:ticker   (admin)   → the trader's short puts on this name + each sold contract's daily closes
 * GET /api/pm/playbook         (admin)   → study verdicts (optlab.findings) → Live › Portfolio Alerts › Playbook
 * GET /api/research/studies    (admin)   → research/studies/INDEX.md catalog rows → Settings › Research
 * GET /api/research/scoreboard (admin)   → promised vs live per adopted score (watchlist_sync.scoreboard) + research/corrections.md
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const STUDIES = resolve(ROOT, "research/studies/INDEX.md");
const CORRECTIONS = resolve(ROOT, "research/corrections.md");

/** optlab exists only once the loader has run; a missing table means "no data yet", not an error. */
async function safe<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return rowsOf<T>((await db.execute(q)) as SqlRows<never>);
  } catch {
    return [];
  }
}

router.get("/stocks/:ticker/options-history", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  // Real straddle (optlab, ~60 names) first; else the IV30-crush estimate (lseg_research.earnings_implied, ~900 names,
  // research/lseg/sync_earnings_implied.py). Crush + post-report drift come from the LSEG table for both.
  const earnings = await safe(sql`
    SELECT COALESCE(o.report_date, e.report_date)::text AS date,
           COALESCE(o.implied, e.implied)::float8 AS implied,
           COALESCE(o.realized, e.realized)::float8 AS realized,
           COALESCE(o.ratio, e.ratio)::float8 AS ratio,
           CASE WHEN o.implied IS NOT NULL THEN 'straddle' ELSE 'iv30' END AS source,
           e.move::float8 AS move, e.crush_pts::float8 AS "crushPts",
           e.drift_5d::float8 AS "drift5d", e.drift_20d::float8 AS "drift20d"
    FROM (SELECT * FROM optlab.earnings_moves WHERE ticker = ${t}) o
    FULL JOIN (SELECT * FROM lseg_research.earnings_implied WHERE ticker = ${t}) e USING (ticker, report_date)
    WHERE COALESCE(o.implied, e.implied) IS NOT NULL
    ORDER BY 1`);
  const iv = await safe(sql`SELECT date::text, iv::float8, rv20::float8, iv_rank::float8 AS "ivRank"
    FROM optlab.iv30 WHERE ticker = ${t} ORDER BY date`);
  // optlab.iv30 covers a few book names and its feed decays (11-20: 1 name live, 8 stuck at Oct/early Nov);
  // LSEG IV30 (~900 names, put/call avg) is the fallback, same shape, last 2 years. Use optlab only when it is at least
  // as fresh as LSEG — a stale source must never shadow a fresh one.
  const lseg = await safe<{ date: string; iv: number; rv20: number | null; ivRank: number | null }>(sql`
    WITH d AS (
      SELECT date, (iv30_put + iv30_call) / 200.0 AS iv,
             ln(close / NULLIF(lag(close) OVER (ORDER BY date), 0)) AS r
      FROM lseg_research.daily_history
      WHERE ticker = ${t} AND date > current_date - 2 * 365 - 400 AND iv30_put IS NOT NULL AND iv30_call IS NOT NULL AND close > 0),
    w AS (
      SELECT date, iv,
             stddev_samp(r) OVER (ORDER BY date ROWS 19 PRECEDING) * sqrt(252) AS rv20,
             min(iv) OVER (ORDER BY date ROWS 251 PRECEDING) AS lo,
             max(iv) OVER (ORDER BY date ROWS 251 PRECEDING) AS hi,
             count(*) OVER (ORDER BY date ROWS 251 PRECEDING) AS n
      FROM d)
    SELECT date::text, iv::float8, rv20::float8,
           CASE WHEN n >= 60 AND hi > lo THEN ((iv - lo) / (hi - lo))::float8 END AS "ivRank"
    FROM w WHERE date > current_date - 2 * 365 ORDER BY date`);
  const lastOf = (xs: { date: string }[]) => (xs.length ? xs[xs.length - 1].date : "");
  const useOptlab = iv.length > 0 && lastOf(iv as { date: string }[]) >= lastOf(lseg);
  return res.json({ ticker: t, earnings, iv: useOptlab ? iv : lseg, ivSource: useOptlab ? "optlab" : "lseg" });
});

router.get("/pm/trades/:ticker", requireAdmin, async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  const trades = await safe<{ occ: string | null; [k: string]: unknown }>(sql`
    SELECT key, account, d0::text, expiry::text, strike::float8, premium::float8, qty::float8, breached, closed_early AS "closedEarly", occ
    FROM optlab.trades WHERE ticker = ${t} ORDER BY d0`);
  const occs = trades.map((x) => x.occ).filter((x): x is string => !!x);
  const bars = occs.length
    ? await safe<{ occ: string; date: string; c: number }>(sql`SELECT occ, date::text, c::float8 FROM optlab.bars
        WHERE occ IN (${sql.join(occs.map((o) => sql`${o}`), sql`, `)}) ORDER BY date`)
    : [];
  const path = new Map<string, { date: string; c: number }[]>();
  for (const b of bars) path.set(b.occ, [...(path.get(b.occ) ?? []), { date: b.date, c: b.c }]);
  return res.json({ ticker: t, trades: trades.map(({ occ, ...x }) => ({ ...x, path: occ ? path.get(occ) ?? [] : [] })) });
});

router.get("/pm/playbook", requireAdmin, async (_req, res) => {
  const findings = await safe(sql`SELECT study, title, verdict, headline, card, updated_at::text AS "updatedAt"
    FROM optlab.findings ORDER BY study`);
  return res.json({ findings });
});

let studiesCache: { mtime: number; rows: Record<string, string>[] } | null = null;
router.get("/research/studies", requireAdmin, (_req, res) => {
  try {
    const mtime = statSync(STUDIES).mtimeMs;
    if (!studiesCache || studiesCache.mtime !== mtime) {
      const rows: Record<string, string>[] = [];
      for (const line of readFileSync(STUDIES, "utf8").split("\n")) {
        const m = line.match(/^\| (S\d{3}) \|/);
        if (!m) continue;
        const c = line.split("|").slice(1, -1).map((x) => x.trim());
        // Extra `|` inside Answer breaks naive column indexing — join the middle; pad short rows.
        if (c.length >= 6) {
          rows.push({
            id: c[0], date: c[1], question: c[2],
            answer: c.slice(3, -2).join(" | "),
            status: c[c.length - 2] || "open",
            report: c[c.length - 1] ?? "",
          });
        } else {
          rows.push({
            id: c[0] ?? "", date: c[1] ?? "", question: c[2] ?? "",
            answer: c.slice(3).join(" | "),
            status: "open", report: "",
          });
        }
      }
      studiesCache = { mtime, rows };
    }
    return res.json({ studies: studiesCache.rows });
  } catch {
    return res.json({ studies: [] });
  }
});

router.get("/research/scoreboard", requireAdmin, async (_req, res) => {
  const scoreboard = await safe(sql`SELECT item, source, promised, live, n, verdict, checked_at::text AS "checkedAt",
      check_key AS "checkKey",
      detail->>'last_error' AS "lastError",
      detail->>'last_error_at' AS "lastErrorAt",
      (detail->>'error_active')::boolean AS "errorActive"
    FROM watchlist_sync.scoreboard ORDER BY item`);
  let corrections: Record<string, string>[] = [];
  try {
    corrections = readFileSync(CORRECTIONS, "utf8").split("\n").filter((l) => /^\| \d{2}-\d{2} \|/.test(l)).map((l) => {
      const c = l.split("|").slice(1, -1).map((x) => x.trim());
      return { date: c[0], agent: c[1], claim: c[2], correction: c[3], caughtBy: c[4] ?? "" };
    });
  } catch { /* file missing → empty */ }
  return res.json({ scoreboard, corrections });
});

export default router;
