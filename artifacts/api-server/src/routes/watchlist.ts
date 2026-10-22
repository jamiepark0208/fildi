import { Router } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import { db, pool, watchlist, tickerRegistry, tickerFundamentals, peerGroupMembers, users } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { classifyTicker } from "../lib/peer-classifier.js";
import { isExcludedEtf, isEtfQuoteType } from "../lib/etf-exclusions.js";
import { yahooFinance } from "../lib/yahoo-client.js";
import { warmWatchlistTicker } from "../lib/warm-watchlist-ticker.js";

const router = Router();

// Bounds client-side N+1 quote fan-out (see bug/12); must stay > register seed size if seeding is reintroduced.
const MAX_WATCHLIST_SIZE = 75;

// Matches PRESET_COLORS in use-watchlist.ts; '' clears the tag.
const COLOR_TAG_RE = /^(#[0-9a-fA-F]{6})?$/;

// All watchlist routes require auth
router.use(requireAuth);

// GET /watchlist
router.get("/watchlist", async (req, res) => {
  const rows = await db.select({ ticker: watchlist.ticker, addedAt: watchlist.addedAt, colorTag: watchlist.colorTag })
    .from(watchlist)
    .where(eq(watchlist.userId, req.session.userId!))
    .orderBy(asc(watchlist.addedAt));
  return res.json(rows);
});

const STYLE_LABEL: Record<string, string> = {
  value: "Value", growth: "Growth", garp: "GARP", blend: "Blend",
  pre_revenue: "Pre-rev", quality_defensive: "Quality", financial: "Financial",
};

// GET /watchlist/meta — registry name/sector/industry + fund style for tag popups (DB-only, no Yahoo).
// ?lite=1 skips street-gap SQL (heatmap sector grouping only needs name/sector).
router.get("/watchlist/meta", async (req, res) => {
  const lite = req.query["lite"] === "1" || req.query["lite"] === "true";
  const rows = await db
    .select({
      ticker: watchlist.ticker,
      companyName: tickerRegistry.name,
      sector: tickerRegistry.sector,
      industry: tickerRegistry.industryGroup,
      styleBucket: tickerFundamentals.styleBucket,
    })
    .from(watchlist)
    .leftJoin(tickerRegistry, eq(watchlist.ticker, tickerRegistry.ticker))
    .leftJoin(tickerFundamentals, eq(watchlist.ticker, tickerFundamentals.ticker))
    .where(eq(watchlist.userId, req.session.userId!));
  const out: Record<string, {
    companyName: string | null; sector: string | null; industry: string | null;
    /** Fund-score style label (Value/Growth/…) — matches breakdown stockType tag. */
    stockType: string | null;
    streetGapPct: number | null;
    /** fv = Fildi FV vs street; price = last price vs street when FV null (speculative modes). */
    streetGapBasis: "fv" | "price" | null;
  }> = {};
  for (const r of rows) {
    const bucket = r.styleBucket ?? null;
    out[r.ticker] = {
      companyName: r.companyName ?? null,
      sector: r.sector ?? null,
      industry: r.industry ?? null,
      stockType: bucket ? (STYLE_LABEL[bucket] ?? null) : null,
      streetGapPct: null,
      streetGapBasis: null,
    };
  }
  // A86 — Fildi FV vs street PT gap % for watchlist tickers (review column; not a signal).
  // Street series: LSEG pt_mean (+ events/fundamentals). Price fallback when FV is null.
  const tickers = Object.keys(out);
  if (!lite && tickers.length > 0) {
    try {
      const gaps = await pool.query<{ ticker: string; gap_pct: number; gap_basis: "fv" | "price" }>(`
        WITH latest AS (
          SELECT DISTINCT ON (ticker) ticker, as_of,
                 fair_value::float8 AS fair_value, price::float8 AS price
          FROM fair_value_snapshots
          WHERE ticker = ANY($1::text[])
          ORDER BY ticker, as_of DESC
        ),
        with_street AS (
          SELECT l.ticker, l.fair_value, l.price,
            COALESCE(
              (SELECT s.median_pt FROM street_pt_daily s
               WHERE s.ticker = l.ticker AND s.as_of <= l.as_of AND s.median_pt > 0
               ORDER BY s.as_of DESC LIMIT 1),
              (SELECT s.median_pt FROM street_pt_daily s
               WHERE s.ticker = l.ticker AND s.median_pt > 0
               ORDER BY s.as_of DESC LIMIT 1)
            ) AS median_pt
          FROM latest l
        )
        SELECT ticker,
               CASE
                 WHEN fair_value IS NOT NULL AND median_pt > 0
                   THEN ((fair_value - median_pt) / median_pt * 100)::float8
                 WHEN price IS NOT NULL AND median_pt > 0
                   THEN ((price - median_pt) / median_pt * 100)::float8
               END AS gap_pct,
               CASE
                 WHEN fair_value IS NOT NULL AND median_pt > 0 THEN 'fv'
                 WHEN price IS NOT NULL AND median_pt > 0 THEN 'price'
               END AS gap_basis
        FROM with_street
        WHERE median_pt IS NOT NULL AND median_pt > 0
          AND (fair_value IS NOT NULL OR price IS NOT NULL)`, [tickers]);
      for (const g of gaps.rows) {
        if (out[g.ticker] && g.gap_pct != null) {
          out[g.ticker]!.streetGapPct = Number(g.gap_pct);
          out[g.ticker]!.streetGapBasis = g.gap_basis;
        }
      }
    } catch {
      /* table may be empty — leave nulls */
    }
  }
  return res.json(out);
});

// GET /watchlist/user/:username — another user's tagged watchlist, for profile viewing.
// Any signed-in user can view (mirrors existing /api/feed/buckets/:username visibility).
router.get("/watchlist/user/:username", async (req, res) => {
  const [target] = await db.select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, req.params["username"]!.toLowerCase()))
    .limit(1);
  if (!target) return res.status(404).json({ error: "User not found" });

  const rows = await db.select({ ticker: watchlist.ticker, addedAt: watchlist.addedAt, colorTag: watchlist.colorTag })
    .from(watchlist)
    .where(eq(watchlist.userId, target.id))
    .orderBy(asc(watchlist.addedAt));
  return res.json(rows);
});

// GET /watchlist/model — the model's own watchlist (scripts/watchlist_sync/publish_model_list.py), read-only.
// Built from this user's holdings/buying power, so only the owning user sees it. Never touches watchlist.color_tag.
const MODEL_LIST_USER_ID = 1;

type SqlRows<T> = { rows?: T[] } | T[];
const run0PlanId = (runs: Array<Record<string, unknown>>) => (runs[0]?.["plan_id"] != null ? Number(runs[0]["plan_id"]) : null);
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

router.get("/watchlist/model", async (req, res) => {
  if (req.session.userId !== MODEL_LIST_USER_ID) return res.json({ run: null, folders: [] });
  try {
    const runs = rowsOf(await db.execute(sql`
      SELECT id, created_at, model_version, plan_id, fit_run_at FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 2`) as SqlRows<Record<string, unknown>>);
    if (runs.length === 0) return res.json({ run: null, folders: [] });
    const runId = Number(runs[0]!["id"]);
    const prevId = runs[1] ? Number(runs[1]["id"]) : null;

    const items = rowsOf(await db.execute(sql`
      SELECT f.folder_key, f.name, f.description, f.kind, f.sort_order,
             i.ticker, i.rank, i.verdict, i.role, i.status, i.score, i.pillars, i.flags, i.why, i.contract, i.adjustments,
             (${prevId}::bigint IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM watchlist_sync.model_items p
                WHERE p.run_id = ${prevId}::bigint AND p.folder_key = i.folder_key AND p.ticker = i.ticker)) AS is_new,
             px.close, px.prev_close, px.close_date
      FROM watchlist_sync.model_folders f
      LEFT JOIN watchlist_sync.model_items i ON i.folder_key = f.folder_key AND i.run_id = ${runId}
      LEFT JOIN LATERAL (
        SELECT (array_agg(x.close ORDER BY x.date DESC))[1]::float8 AS close,
               (array_agg(x.close ORDER BY x.date DESC))[2]::float8 AS prev_close,
               max(x.date) AS close_date
        FROM (SELECT close, date FROM prices_historical WHERE ticker = i.ticker ORDER BY date DESC LIMIT 2) x
      ) px ON i.ticker IS NOT NULL
      WHERE f.enabled
      ORDER BY f.sort_order, i.rank`) as SqlRows<Record<string, any>>);

    const removed = prevId === null ? [] : rowsOf(await db.execute(sql`
      SELECT p.folder_key, p.ticker FROM watchlist_sync.model_items p
      WHERE p.run_id = ${prevId}::bigint AND NOT EXISTS (
        SELECT 1 FROM watchlist_sync.model_items i WHERE i.run_id = ${runId} AND i.folder_key = p.folder_key AND i.ticker = p.ticker)
      ORDER BY p.folder_key, p.ticker`) as SqlRows<{ folder_key: string; ticker: string }>);

    const folders = new Map<string, { key: string; name: string; description: string; kind: string; items: unknown[]; removed: string[] }>();
    for (const r of items) {
      let f = folders.get(r.folder_key);
      if (!f) {
        f = { key: r.folder_key, name: r.name, description: r.description, kind: r.kind, items: [], removed: [] };
        folders.set(r.folder_key, f);
      }
      if (!r.ticker) continue;
      f.items.push({
        ticker: r.ticker, rank: r.rank, verdict: r.verdict, role: r.role, status: r.status, score: r.score,
        pillars: r.pillars, flags: r.flags ?? [], why: r.why ?? [], contract: r.contract, adjustments: r.adjustments ?? [], isNew: r.is_new,
        close: r.close, prevClose: r.prev_close, closeDate: r.close_date,
      });
    }
    for (const r of removed) folders.get(r.folder_key)?.removed.push(r.ticker);

    // A213: attach pick_odds (same plan_id) — one query, map by ticker.
    const planId = run0PlanId(runs);
    const oddsByTicker = new Map<string, unknown>();
    if (planId != null) {
      try {
        const oddsRows = rowsOf(await db.execute(sql`
          SELECT ticker, odds FROM watchlist_sync.pick_odds WHERE plan_id = ${planId}::int`) as SqlRows<{ ticker: string; odds: unknown }>);
        for (const o of oddsRows) oddsByTicker.set(String(o.ticker).toUpperCase(), o.odds);
        for (const f of folders.values()) {
          for (const it of f.items as Array<{ ticker: string; odds?: unknown }>) {
            const odds = oddsByTicker.get(String(it.ticker).toUpperCase());
            if (odds) it.odds = odds;
          }
        }
      } catch { /* pick_odds table may not exist yet */ }
    }

    // Pipeline health strip: is everything behind this list fresh and working? (one round trip; each part is optional)
    const healthRows = rowsOf(await db.execute(sql`
      SELECT
        (SELECT version FROM watchlist_sync.model_params WHERE status = 'champion') AS champion,
        (SELECT COUNT(*) FROM watchlist_sync.model_params WHERE status = 'challenger')::int AS challengers,
        (SELECT status FROM watchlist_sync.plans WHERE id = ${run0PlanId(runs)}::bigint) AS plan_status,
        -- Live quote freshness for the published plan. Prefer rh_raw option_quotes; fall back to
        -- equity_quotes (stock-only plans) then plans.verified_at (Schwab verify that skipped rh_raw).
        (SELECT COALESCE(
          (SELECT MAX(fetched_at) FROM watchlist_sync.rh_raw
            WHERE plan_id = ${run0PlanId(runs)}::bigint AND kind = 'option_quotes'),
          (SELECT MAX(fetched_at) FROM watchlist_sync.rh_raw
            WHERE plan_id = ${run0PlanId(runs)}::bigint AND kind = 'equity_quotes'),
          (SELECT verified_at FROM watchlist_sync.plans WHERE id = ${run0PlanId(runs)}::bigint)
        )) AS quotes_at,
        (SELECT MAX(imported_at) FROM portfolio_snapshots) AS snapshot_at,
        (SELECT MAX(date) FROM lseg_research.daily_history) AS lseg_history_date,
        (SELECT MAX(as_of) FROM lseg_research.signals_daily) AS lseg_signals_date,
        (SELECT MAX(date) FROM prices_historical WHERE ticker = 'SPY') AS prices_date,
        (SELECT MAX(date) FROM prices_historical) AS prices_universe_date,
        (SELECT COUNT(*) FROM watchlist_sync.grades)::int AS grades,
        (SELECT MAX(graded_at) FROM watchlist_sync.grades) AS last_graded_at,
        (SELECT COUNT(*) FROM watchlist_sync.price_repairs)::int AS split_repairs`) as SqlRows<Record<string, unknown>>);
    const health = healthRows[0] ?? {};

    // A74: Model List P(OTM) calibration from forecast_ledger (model_winrate on model_pick_otm).
    // Grade the FIRST forecast per contract (what the pick showed when recommended; later re-prices sit
    // closer to expiry and flatter accuracy), split by horizon: ≤ 7 days = this week's expiry, else next week's.
    type Cal = { n: number; pred: number; real: number };
    let calibration: (Cal & { byWeek: (Cal & { week: 1 | 2 })[] }) | null = null;
    try {
      const calRows = rowsOf(await db.execute(sql`
        SELECT CASE WHEN resolves_on - made_on <= 7 THEN 1 ELSE 2 END AS week,
               COUNT(*)::int AS n,
               AVG(prob)::float8 AS pred,
               AVG(CASE WHEN outcome THEN 1.0 ELSE 0.0 END)::float8 AS real
        FROM (
          SELECT DISTINCT ON (question_id, forecaster) prob, outcome, made_on, resolves_on
          FROM watchlist_sync.forecast_ledger
          WHERE outcome IS NOT NULL
            AND qtype = 'model_pick_otm'
            AND forecaster = 'model_winrate'
            AND made_on < resolves_on
          ORDER BY question_id, forecaster, made_at ASC
        ) x
        GROUP BY 1 ORDER BY 1`) as SqlRows<{ week: number; n: number; pred: number | null; real: number | null }>);
      const byWeek = calRows
        .filter((c) => Number(c.n) > 0 && c.pred != null && c.real != null)
        .map((c) => ({ week: (Number(c.week) === 1 ? 1 : 2) as 1 | 2, n: Number(c.n), pred: Number(c.pred), real: Number(c.real) }));
      const n = byWeek.reduce((a, c) => a + c.n, 0);
      if (n > 0) {
        calibration = {
          n,
          pred: byWeek.reduce((a, c) => a + c.pred * c.n, 0) / n,
          real: byWeek.reduce((a, c) => a + c.real * c.n, 0) / n,
          byWeek,
        };
      }
    } catch { /* forecast_ledger not created yet */ }

    const run = runs[0]!;
    return res.json({
      run: { id: runId, createdAt: run["created_at"], modelVersion: run["model_version"], planId: run["plan_id"], fitRunAt: run["fit_run_at"], prevRunId: prevId },
      health: { ...health, calibration },
      folders: [...folders.values()],
    });
  } catch (err) {
    // Tables are created by the Python publisher; before its first run they don't exist.
    console.warn("[watchlist] model list unavailable:", err);
    return res.json({ run: null, folders: [] });
  }
});

// POST /watchlist
router.post("/watchlist", async (req, res) => {
  const { ticker, colorTag } = req.body as { ticker?: string; colorTag?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const normalized = ticker.trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 10) {
    return res.status(400).json({ error: "ticker must be 1-10 characters" });
  }
  if (colorTag !== undefined && !COLOR_TAG_RE.test(colorTag)) {
    return res.status(400).json({ error: "colorTag must be a 6-digit hex color or empty" });
  }

  const existingCount = await db.$count(watchlist, eq(watchlist.userId, req.session.userId!));
  if (existingCount >= MAX_WATCHLIST_SIZE) {
    return res.status(400).json({ error: `Watchlist is full (max ${MAX_WATCHLIST_SIZE} tickers)` });
  }

  await db.insert(watchlist)
    .values({ userId: req.session.userId!, ticker: normalized, tier: 1, status: "monitoring", colorTag: colorTag ?? "" })
    .onConflictDoNothing();

  // Registry upsert is best-effort: watchlist membership must not fail if registry
  // write hits a transient error (migration drift, lock). Enrichment peers the flag later.
  // ETFs may sit on a watchlist for price tracking but never enter stock peer scoring.
  // Static deny-list + Yahoo quoteType (SCHD was ETF but missing from the list → stock enrich ran).
  let etf = isExcludedEtf(normalized);
  let etfName: string | null = null;
  if (!etf) {
    try {
      const q = await (yahooFinance as any).quote(normalized, {}, { validateResult: false }) as {
        quoteType?: string; typeDisp?: string; shortName?: string; longName?: string;
      };
      if (isEtfQuoteType(q?.quoteType) || isEtfQuoteType(q?.typeDisp)) {
        etf = true;
        etfName = q?.shortName ?? q?.longName ?? null;
      }
    } catch (err) {
      console.warn(`[watchlist] Yahoo quoteType check failed for ${normalized}:`, err);
    }
  }
  try {
    await db.insert(tickerRegistry)
      .values({
        ticker: normalized,
        isActive: true,
        fetchFundamentals: !etf,
        ...(etfName ? { name: etfName } : {}),
      })
      .onConflictDoUpdate({
        target: tickerRegistry.ticker,
        set: {
          fetchFundamentals: !etf,
          ...(etfName ? { name: etfName } : {}),
          ...(etf ? { peerTickers: null } : {}),
        },
      });
  } catch (err) {
    console.warn(`[watchlist] ticker_registry upsert failed for ${normalized}:`, err);
  }

  // bug/9: peers used to get fetchFundamentals=true synchronously here, which meant
  // one watchlist add could flag an entire peer group (up to hundreds of tickers)
  // for fundamentals fetch on every request. Peers still need fetchFundamentals=true
  // for peer-relative scoring to work — that flip now happens in nightly-enrichment.ts,
  // budget-gated, instead of unbounded on the request path.
  let groups: { groupId: string }[] = [];
  try {
    groups = await db
      .select({ groupId: peerGroupMembers.groupId })
      .from(peerGroupMembers)
      .where(eq(peerGroupMembers.ticker, normalized));
  } catch (err) {
    console.warn(`[watchlist] peer lookup failed for ${normalized}:`, err);
  }

  const warnings: string[] = [];
  let peerGroup: { id: string; confidence: string } | null = null;

  if (etf) {
    warnings.push(`${normalized} is an ETF — excluded from stock peer relative scoring`);
  } else if (groups.length === 0) {
    try {
      const cls = await classifyTicker(normalized);
      if (cls.groupId && cls.groupId !== "__global__" && cls.confidence !== "unmapped") {
        peerGroup = { id: cls.groupId, confidence: cls.confidence };
        groups = [{ groupId: cls.groupId }];
        console.log(`[watchlist] ${normalized} auto-classified → ${cls.groupId} (${cls.confidence})`);
      } else {
        warnings.push(`${normalized} could not be auto-mapped to a peer group — review Unmapped in Settings`);
        console.warn(`[watchlist] ${normalized} added but still unmapped`);
      }
    } catch (err) {
      warnings.push(`${normalized} peer auto-classify failed — will retry on nightly`);
      console.warn(`[watchlist] classify failed for ${normalized}:`, err);
    }
  } else {
    peerGroup = { id: groups[0]!.groupId, confidence: "mapped" };
  }

  // Warm chart bars + live quote immediately (stocks also get fund enrich). Don't wait for nightly.
  void warmWatchlistTicker(normalized, { etf })
    .catch((err) => console.warn(`[watchlist] warm failed for ${normalized}:`, err));

  return res.status(201).json({
    ticker: normalized,
    ...(peerGroup ? { peerGroup } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    warming: true,
  });
});

// PATCH /watchlist/:ticker — update color tag
router.patch("/watchlist/:ticker", async (req, res) => {
  const { colorTag } = req.body as { colorTag?: string };
  if (typeof colorTag !== "string" || !COLOR_TAG_RE.test(colorTag)) {
    return res.status(400).json({ error: "colorTag must be a 6-digit hex color or empty" });
  }
  const ticker = String(req.params["ticker"] ?? "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const result = await db.update(watchlist)
    .set({ colorTag })
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, ticker)))
    .returning({ ticker: watchlist.ticker });
  if (result.length === 0) return res.status(404).json({ error: "Ticker not in watchlist" });
  return res.json({ ok: true });
});

// DELETE /watchlist/:ticker
router.delete("/watchlist/:ticker", async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  await db.delete(watchlist)
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, ticker)));
  return res.json({ ok: true });
});

/** A213: open short-put odds from watchlist_sync.position_odds (latest snapshot). */
router.get("/watchlist/position-odds", async (req, res) => {
  if (req.session.userId !== MODEL_LIST_USER_ID) return res.json({ snapshotId: null, positions: [] });
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT p.snapshot_id, p.account, p.ticker, p.strike::float8 AS strike, p.expiry::text AS expiry, p.odds
      FROM watchlist_sync.position_odds p
      WHERE p.snapshot_id = (SELECT MAX(snapshot_id) FROM watchlist_sync.position_odds)
      ORDER BY p.expiry, p.ticker`) as SqlRows<{
      snapshot_id: number; account: string; ticker: string; strike: number; expiry: string; odds: unknown;
    }>);
    return res.json({
      snapshotId: rows[0]?.snapshot_id ?? null,
      positions: rows.map((r) => ({
        account: r.account,
        ticker: r.ticker,
        strike: Number(r.strike),
        expiry: r.expiry,
        odds: r.odds,
      })),
    });
  } catch {
    return res.json({ snapshotId: null, positions: [] });
  }
});

export default router;
