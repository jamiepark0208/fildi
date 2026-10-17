/**
 * GET /api/pm/alerts → latest Portfolio Alerts run (Live › Portfolio Alerts).
 * GET /api/pm/names  → "Your names": short interest (LSEG), next earnings, latest earnings-call summary (transcripts.py).
 * GET /api/pm/book   → watchlist_sync.pm_book_latest (written each pm_alerts run); book-latest.json fallback (A76 Book card / Expiry desk).
 * Written by scripts/watchlist_sync/pm_alerts.py + pm_book.py (Claude, PM role); this route only reads.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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

router.get("/pm/book", requireAdmin, async (_req, res) => {
  try {
    const row = rowsOf<{ book: unknown }>((await db.execute(sql`SELECT book FROM watchlist_sync.pm_book_latest WHERE id = 1`)) as SqlRows<never>)[0];
    if (row?.book) return res.json({ book: row.book });
  } catch { /* table not created yet → file */ }
  return res.json({ book: readPmBook() });
});

/**
 * GET /api/pm/odds — per open short put: P(assign) + "if assigned" odds (user 2026-10-15). Zero new fetches: spot/IV come from the
 * book pm_alerts refreshes every 15 min (live Schwab); odds are closed-form (driftless lognormal, 20 trading days, today's IV);
 * history = this name's 20-day forward return after a 5-day drop at least as deep as now (prices_historical), cached 24 h.
 */
const N = (x: number) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x ** 3)));
const histCache = new Map<string, { at: number; v: { n: number; med: number; up: number } | null }>();
async function afterDrop(ticker: string, drop5: number) {
  const key = `${ticker}|${Math.round(drop5 * 100)}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 864e5) return hit.v;
  const px = rowsOf<{ c: number }>((await db.execute(sql`SELECT close::float8 AS c FROM prices_historical
    WHERE ticker = ${ticker} AND close > 0 ORDER BY date`)) as SqlRows<never>).map((r) => r.c);
  const f: number[] = [];
  for (let i = 5; i < px.length - 20; i++) if (px[i] / px[i - 5] - 1 <= Math.min(drop5, -0.05)) f.push(px[i + 20] / px[i] - 1);
  f.sort((a, b) => a - b);
  const v = f.length >= 10 ? { n: f.length, med: f[Math.floor(f.length / 2)], up: f.filter((x) => x > 0).length / f.length } : null;
  histCache.set(key, { at: Date.now(), v });
  return v;
}
/** S025 (out/opt/S025.md): with SPY below its 200-day, ≥2σ 5-day drops got back to the pre-drop price within 20 d 27 % vs 17 % base. */
const S025 = { recovered: 0.27, base: 0.17 };
let spyCache: { at: number; v: { spyBelow200: boolean; recovered: number; base: number } | null } | null = null;
async function spyRegime() {
  if (spyCache && Date.now() - spyCache.at < 36e5) return spyCache.v;
  const px = rowsOf<{ c: number }>((await db.execute(sql`SELECT close::float8 AS c FROM prices_historical
    WHERE ticker = 'SPY' AND close > 0 ORDER BY date DESC LIMIT 200`)) as SqlRows<never>).map((r) => r.c);
  const v = px.length === 200 ? { spyBelow200: px[0] < px.reduce((s, x) => s + x, 0) / 200, ...S025 } : null;
  spyCache = { at: Date.now(), v };
  return v;
}
router.get("/pm/odds", requireAdmin, async (_req, res, next) => {
  try {
    type Pos = { ticker: string; account: string; strike: number; expiry: string; qty: number; spot: number | null; iv: number | null; p_otm: number | null; days_left: number };
    const row = rowsOf<{ book: { positions?: Pos[]; live_priced_at?: string; snapshot_at?: string } }>(
      (await db.execute(sql`SELECT book FROM watchlist_sync.pm_book_latest WHERE id = 1`)) as SqlRows<never>)[0];
    const pos = row?.book?.positions ?? [];
    const out = [];
    for (const p of pos) {
      if (!p.spot || !p.iv) { out.push({ ...p, pAssign: p.p_otm == null ? null : 1 - p.p_otm, backToStrike20d: null, atStrike20d: null, hist: null }); continue; }
      const d = Math.log(p.strike / p.spot) / (p.iv * Math.sqrt(20 / 252));
      const at = d <= 0 ? 1 - N(d) : N(-d);
      const pxs = rowsOf<{ c: number }>((await db.execute(sql`SELECT close::float8 AS c FROM prices_historical
        WHERE ticker = ${p.ticker} AND close > 0 ORDER BY date DESC LIMIT 6`)) as SqlRows<never>).map((r) => r.c);
      const drop5 = pxs.length === 6 ? p.spot / pxs[5] - 1 : 0;
      out.push({ ...p, pAssign: p.p_otm == null ? null : 1 - p.p_otm, backToStrike20d: Math.min(1, p.spot >= p.strike ? 1 : 2 * at),
        atStrike20d: at, drop5, hist: await afterDrop(p.ticker, drop5) });
    }
    res.json({ pricedAt: row?.book?.live_priced_at ?? row?.book?.snapshot_at ?? null, positions: out, regime: await spyRegime() });
  } catch (e) { next(e); }
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

/**
 * POST /api/pm/what-if — A136 candidate mode (Claude plan 10-16).
 * Body: { account, ticker, strike, expiry, qty, iv, spot, premium? }
 * Spawns pm_alerts.py --what-if (same MC engine as Portfolio Alerts). Advisory only.
 */
router.post("/pm/what-if", requireAdmin, async (req, res) => {
  try {
    const account = String(req.body?.account ?? "").toUpperCase();
    const ticker = String(req.body?.ticker ?? "").toUpperCase();
    const strike = Number(req.body?.strike);
    const expiry = String(req.body?.expiry ?? "");
    const qty = Math.max(1, Math.min(50, parseInt(String(req.body?.qty ?? "1"), 10) || 1));
    const iv = Number(req.body?.iv);
    const spot = Number(req.body?.spot);
    const premium = req.body?.premium != null ? Number(req.body.premium) : null;
    if (!["IRA", "FILDI"].includes(account)) return res.status(400).json({ error: "account must be IRA or FILDI" });
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return res.status(400).json({ error: "bad ticker" });
    if (!(strike > 0) || !(iv > 0) || !(spot > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return res.status(400).json({ error: "need strike, iv, spot, expiry YYYY-MM-DD" });
    }
    const py = resolve(ROOT, ".venv/bin/python");
    const script = resolve(ROOT, "scripts/watchlist_sync/pm_alerts.py");
    const args = [
      script, "--what-if", account, ticker, String(strike), expiry, String(qty), String(iv), String(spot),
      ...(premium != null && Number.isFinite(premium) ? [String(premium)] : []),
    ];
    const body = await new Promise<string>((resolveP, reject) => {
      const child = spawn(py, args, { cwd: resolve(ROOT, "scripts/watchlist_sync"), timeout: 120_000 });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolveP(out);
        else reject(new Error(err.trim() || out.trim() || `exit ${code}`));
      });
    });
    const json = JSON.parse(body.trim().split("\n").filter(Boolean).pop() || "{}");
    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/pm/risk-override — A136: Jamie overrode a red/amber book-risk badge (feeds A80 later).
 * GET  /api/pm/risk-override — recent overrides (newest first, cap 50).
 */
async function ensureRiskOverrideTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS watchlist_sync.pm_risk_overrides (
      id serial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      account text NOT NULL,
      ticker text NOT NULL,
      strike numeric NOT NULL,
      expiry date NOT NULL,
      qty int NOT NULL DEFAULT 1,
      badge text NOT NULL,
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      note text,
      surface text,
      risk_base float8,
      risk_with float8,
      crash_base float8,
      crash_with float8
    )`);
}

router.post("/pm/risk-override", requireAdmin, async (req, res) => {
  try {
    await ensureRiskOverrideTable();
    const account = String(req.body?.account ?? "").toUpperCase();
    const ticker = String(req.body?.ticker ?? "").toUpperCase();
    const strike = Number(req.body?.strike);
    const expiry = String(req.body?.expiry ?? "");
    const qty = Math.max(1, Math.min(50, parseInt(String(req.body?.qty ?? "1"), 10) || 1));
    const badge = String(req.body?.badge ?? "");
    const reasons = Array.isArray(req.body?.reasons) ? req.body.reasons.map(String) : [];
    const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
    const surface = req.body?.surface != null ? String(req.body.surface).slice(0, 40) : null;
    const num = (x: unknown) => (x == null || x === "" ? null : Number(x));
    if (!["IRA", "FILDI"].includes(account)) return res.status(400).json({ error: "account must be IRA or FILDI" });
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return res.status(400).json({ error: "bad ticker" });
    if (!(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return res.status(400).json({ error: "need strike + expiry YYYY-MM-DD" });
    }
    if (!["red", "amber", "green"].includes(badge)) return res.status(400).json({ error: "bad badge" });
    await db.execute(sql`
      INSERT INTO watchlist_sync.pm_risk_overrides
        (account, ticker, strike, expiry, qty, badge, reasons, note, surface,
         risk_base, risk_with, crash_base, crash_with)
      VALUES (
        ${account}, ${ticker}, ${strike}, ${expiry}::date, ${qty}, ${badge},
        ${JSON.stringify(reasons)}::jsonb, ${note}, ${surface},
        ${num(req.body?.risk_base)}, ${num(req.body?.risk_with)},
        ${num(req.body?.crash_base)}, ${num(req.body?.crash_with)}
      )`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/pm/risk-override", requireAdmin, async (_req, res) => {
  try {
    await ensureRiskOverrideTable();
    const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
      SELECT id, created_at, account, ticker, strike, expiry::text AS expiry, qty, badge,
             reasons, note, surface, risk_base, risk_with, crash_base, crash_with
      FROM watchlist_sync.pm_risk_overrides
      ORDER BY id DESC LIMIT 50`) as SqlRows<Record<string, unknown>>);
    return res.json({ overrides: rows });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
