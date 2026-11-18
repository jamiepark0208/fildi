/**
 * Strategy Library (A175) — read-only. Tables written by Claude's A176 runner
 * (scripts/watchlist_sync/analysis/strategy_lib.py). This route never computes trades.
 *
 * GET /api/strategies              — list + headline stats (admin)
 * GET /api/strategies/:id          — meta, stats, equity, trades (admin)
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const router = Router();

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

/** Missing schema / empty tables → [] (not 500). Same pattern as options-history. */
async function safe<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return rowsOf<T>((await db.execute(q)) as SqlRows<never>);
  } catch {
    return [];
  }
}

interface StrategyRow {
  strategyId: string;
  version: string;
  name: string;
  family: string;
  instrument: string;
  status: string;
  summary: string;
  rulesMd: string;
  caveatsMd: string | null;
  studyRef: string | null;
  windowStart: string;
  windowEnd: string;
  holdoutStart: string | null;
  priceSource: string;
  updatedAt: string;
}

interface EquityPt {
  d: string;
  equity: number;
  spyEquity: number;
  drawdown: number;
  isHoldout: boolean;
}

interface TradeRow {
  id: number;
  entryTs: string;
  exitTs: string | null;
  ticker: string;
  instrument: string;
  side: string;
  optionType: string | null;
  strike: number | null;
  expiry: string | null;
  dteAtEntry: number | null;
  qty: number;
  entryPx: number;
  exitPx: number | null;
  capital: number;
  pnl: number | null;
  retPct: number | null;
  trigger: string;
  exitReason: string | null;
  isHoldout: boolean;
}

export interface StrategyStats {
  totalReturn: number | null;
  annualizedReturn: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  tradeCount: number;
  holdoutReturn: number | null;
  vsSpy: number | null;
  lastEquity: number | null;
  lastSpyEquity: number | null;
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Stats from equity + trade rows. One helper — list and detail share it. */
export function computeStats(
  equity: EquityPt[],
  trades: Pick<TradeRow, "pnl" | "isHoldout">[],
): StrategyStats {
  const tradeCount = trades.length;
  const pnls = trades.map((t) => t.pnl).filter((v): v is number => v != null);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const sumWin = wins.reduce((s, v) => s + v, 0);
  const sumLossAbs = Math.abs(losses.reduce((s, v) => s + v, 0));

  let totalReturn: number | null = null;
  let annualizedReturn: number | null = null;
  let sharpe: number | null = null;
  let maxDrawdown: number | null = null;
  let vsSpy: number | null = null;
  let holdoutReturn: number | null = null;
  let lastEquity: number | null = null;
  let lastSpyEquity: number | null = null;

  if (equity.length > 0) {
    const first = equity[0]!;
    const last = equity[equity.length - 1]!;
    lastEquity = last.equity;
    lastSpyEquity = last.spyEquity;
    // Acceptance: totalReturn = last equity − 1 (index @1.0)
    totalReturn = last.equity - 1;
    vsSpy = last.equity - last.spyEquity;
    maxDrawdown = Math.min(...equity.map((e) => e.drawdown));

    const daily: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      const prev = equity[i - 1]!.equity;
      if (prev > 1e-12) daily.push(equity[i]!.equity / prev - 1);
    }
    if (daily.length >= 2) {
      const m = mean(daily);
      const variance = daily.reduce((s, v) => s + (v - m) ** 2, 0) / (daily.length - 1);
      const stdev = Math.sqrt(variance);
      sharpe = stdev > 1e-12 ? (m / stdev) * Math.sqrt(252) : null;
    }
    if (equity.length >= 2 && first.equity > 1e-12) {
      const t0 = Date.parse(first.d);
      const t1 = Date.parse(last.d);
      const years = (t1 - t0) / (365.25 * 24 * 3600 * 1000);
      if (years > 1 / 365) {
        annualizedReturn = Math.pow(last.equity / first.equity, 1 / years) - 1;
      }
    }

    const hold = equity.filter((e) => e.isHoldout);
    if (hold.length >= 2 && hold[0]!.equity > 1e-12) {
      holdoutReturn = hold[hold.length - 1]!.equity / hold[0]!.equity - 1;
    }
  }

  return {
    totalReturn,
    annualizedReturn,
    sharpe,
    maxDrawdown,
    winRate: pnls.length ? wins.length / pnls.length : null,
    avgWin: wins.length ? mean(wins) : null,
    avgLoss: losses.length ? mean(losses) : null,
    profitFactor: sumLossAbs > 1e-12 ? sumWin / sumLossAbs : null,
    tradeCount,
    holdoutReturn,
    vsSpy,
    lastEquity,
    lastSpyEquity,
  };
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

router.get("/strategies", requireAdmin, async (req, res, next) => {
  try {
    const family = typeof req.query.family === "string" ? req.query.family : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const instrument = typeof req.query.instrument === "string" ? req.query.instrument : null;

    const strategies = await safe<StrategyRow>(sql`
      SELECT DISTINCT ON (strategy_id)
        strategy_id AS "strategyId", version, name, family, instrument, status, summary,
        rules_md AS "rulesMd", caveats_md AS "caveatsMd", study_ref AS "studyRef",
        window_start::text AS "windowStart", window_end::text AS "windowEnd",
        holdout_start::text AS "holdoutStart", price_source AS "priceSource",
        updated_at::text AS "updatedAt"
      FROM watchlist_sync.strategies
      ORDER BY strategy_id, version DESC`);

    const tried = strategies.length;
    const passed = strategies.filter((s) => s.status !== "failed").length;

    let filtered = strategies;
    if (family) filtered = filtered.filter((s) => s.family === family);
    if (status) filtered = filtered.filter((s) => s.status === status);
    if (instrument) filtered = filtered.filter((s) => s.instrument === instrument);

    if (filtered.length === 0) {
      res.json({ tried, passed, strategies: [] });
      return;
    }

    // Batch equity + trade pnl for all listed versions (lean list: no series in response)
    const pairs = filtered.map((s) => ({ id: s.strategyId, v: s.version }));
    const equityAll = await safe<EquityPt & { strategyId: string; version: string }>(sql`
      SELECT strategy_id AS "strategyId", version, d::text AS d,
             equity::float8 AS equity, spy_equity::float8 AS "spyEquity",
             drawdown::float8 AS drawdown, is_holdout AS "isHoldout"
      FROM watchlist_sync.strategy_equity
      WHERE (strategy_id, version) IN (
        ${sql.join(
          pairs.map((p) => sql`(${p.id}, ${p.v})`),
          sql`, `,
        )}
      )
      ORDER BY strategy_id, version, d`);

    const tradePnls = await safe<{ strategyId: string; version: string; pnl: number | null; isHoldout: boolean }>(sql`
      SELECT strategy_id AS "strategyId", version, pnl::float8 AS pnl, is_holdout AS "isHoldout"
      FROM watchlist_sync.strategy_trades
      WHERE (strategy_id, version) IN (
        ${sql.join(
          pairs.map((p) => sql`(${p.id}, ${p.v})`),
          sql`, `,
        )}
      )`);

    const eqBy = new Map<string, EquityPt[]>();
    for (const e of equityAll) {
      const k = `${e.strategyId}\0${e.version}`;
      const arr = eqBy.get(k) ?? [];
      arr.push(e);
      eqBy.set(k, arr);
    }
    const trBy = new Map<string, Pick<TradeRow, "pnl" | "isHoldout">[]>();
    for (const t of tradePnls) {
      const k = `${t.strategyId}\0${t.version}`;
      const arr = trBy.get(k) ?? [];
      arr.push({ pnl: t.pnl, isHoldout: t.isHoldout });
      trBy.set(k, arr);
    }

    const items = filtered.map((s) => {
      const k = `${s.strategyId}\0${s.version}`;
      const stats = computeStats(eqBy.get(k) ?? [], trBy.get(k) ?? []);
      return {
        strategyId: s.strategyId,
        version: s.version,
        name: s.name,
        family: s.family,
        instrument: s.instrument,
        status: s.status,
        summary: s.summary,
        studyRef: s.studyRef,
        priceSource: s.priceSource,
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        holdoutStart: s.holdoutStart,
        stats: {
          totalReturn: stats.totalReturn,
          annualizedReturn: stats.annualizedReturn,
          sharpe: stats.sharpe,
          maxDrawdown: stats.maxDrawdown,
          winRate: stats.winRate,
          profitFactor: stats.profitFactor,
          tradeCount: stats.tradeCount,
          holdoutReturn: stats.holdoutReturn,
          vsSpy: stats.vsSpy,
          lastEquity: stats.lastEquity,
        },
      };
    });

    res.json({ tried, passed, strategies: items });
  } catch (err) {
    next(err);
  }
});

/**
 * Jamie 11-09: every strategy_signals id shows on Model List / Live hotlist / Options scanner without a hand-kept list.
 * GET /api/strategy-signals/active?days=14 — open/priced rows of every strategy (panic-puts-hiv has its own badge).
 */
router.get("/strategy-signals/active", requireAdmin, async (req, res, next) => {
  try {
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, Math.floor(daysRaw))) : 14;
    const signals = await safe<Record<string, unknown>>(sql`
      SELECT strategy_id AS "strategyId", as_of::text AS "asOf", ticker, trigger, details, occ, expiry::text AS expiry,
             strike::float8 AS strike, entry_mid::float8 AS "entryMid", entry_date::text AS "entryDate", status,
             settle::float8 AS settle, ret::float8 AS ret, itm, graded_at::text AS "gradedAt"
      FROM watchlist_sync.strategy_signals
      WHERE status IN ('open', 'priced', 'listed') AND strategy_id <> 'panic-puts-hiv'
        AND as_of >= current_date - ${days}::int
      ORDER BY as_of DESC, strategy_id, ticker`);
    res.json({ days, count: signals.length, signals });
  } catch (err) {
    next(err);
  }
});

/**
 * Trade funnel step 3 (research/common/trade-funnel-plan.md, 11-09): one ranked Today list + the funnel stages behind it.
 * GET /api/trade-funnel/today — written by scripts/watchlist_sync/trade_funnel.py (shortlist + today) in daily.py.
 */
router.get("/trade-funnel/today", requireAdmin, async (_req, res, next) => {
  try {
    const last = await safe<{ d: string | null }>(sql`
      SELECT MAX(as_of)::text AS d FROM watchlist_sync.trade_funnel_daily WHERE stage = 'today'`);
    const asOf = last[0]?.d ?? null;
    if (!asOf) {
      res.json({ asOf: null, regime: null, stages: [], items: [] });
      return;
    }
    const stages = await safe<{ stage: string; kept: number; cut: number }>(sql`
      SELECT stage, (COUNT(DISTINCT ticker) FILTER (WHERE kept))::int AS kept, (COUNT(DISTINCT ticker) FILTER (WHERE NOT kept))::int AS cut
      FROM watchlist_sync.trade_funnel_daily
      WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.trade_funnel_daily WHERE stage = 'shortlist' AND as_of <= ${asOf}::date)
        AND stage IN ('universe', 'shortlist')
      GROUP BY stage`);
    const reg = await safe<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM watchlist_sync.trade_funnel_daily WHERE stage = 'regime' AND as_of <= ${asOf}::date
      ORDER BY as_of DESC LIMIT 1`);
    const items = await safe<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM watchlist_sync.trade_funnel_daily WHERE stage = 'today' AND as_of = ${asOf}::date
      ORDER BY (payload->>'rank')::int`);
    res.json({ asOf, regime: reg[0]?.payload ?? null, stages, items: items.map((r) => r.payload) });
  } catch (err) {
    next(err);
  }
});

/**
 * A189 — live strategy_signals for a Strategy Library id (e.g. panic-puts-hiv).
 * GET /api/strategies/:id/signals?days=30
 */
router.get("/strategies/:id/signals", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "bad strategy id" });
      return;
    }
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 30;
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffYmd = cutoff.toISOString().slice(0, 10);

    interface SignalRow {
      strategyId: string;
      asOf: string;
      ticker: string;
      trigger: string;
      details: Record<string, unknown> | null;
      occ: string | null;
      expiry: string | null;
      strike: number | null;
      entryMid: number | null;
      entryDate: string | null;
      status: string;
      settle: number | null;
      ret: number | null;
      itm: boolean | null;
      gradedAt: string | null;
    }

    const signals = await safe<SignalRow>(sql`
      SELECT strategy_id AS "strategyId", as_of::text AS "asOf", ticker, trigger,
             details, occ, expiry::text AS expiry, strike::float8 AS strike,
             entry_mid::float8 AS "entryMid", entry_date::text AS "entryDate",
             status, settle::float8 AS settle, ret::float8 AS ret, itm,
             graded_at::text AS "gradedAt"
      FROM watchlist_sync.strategy_signals
      WHERE strategy_id = ${id}
        AND as_of >= ${cutoffYmd}::date
      ORDER BY as_of DESC, ticker`);

    const graded = signals.filter((s) => s.status === "graded" && s.ret != null);
    const wins = graded.filter((s) => (s.ret ?? 0) > 0);
    const meanRet = graded.length
      ? graded.reduce((a, s) => a + (s.ret ?? 0), 0) / graded.length
      : null;

    res.json({
      strategyId: id,
      days,
      count: signals.length,
      signals,
      live: {
        since: "2026-10-13",
        graded: graded.length,
        hitRate: graded.length ? wins.length / graded.length : null,
        meanRet,
        backtestMeanRet: 0.0315,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/strategies/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "bad strategy id" });
      return;
    }
    const versionQ = typeof req.query.version === "string" ? req.query.version : null;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from
      : "2026-01-01";
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to
      : null;

    const metaRows = versionQ
      ? await safe<StrategyRow>(sql`
          SELECT strategy_id AS "strategyId", version, name, family, instrument, status, summary,
                 rules_md AS "rulesMd", caveats_md AS "caveatsMd", study_ref AS "studyRef",
                 window_start::text AS "windowStart", window_end::text AS "windowEnd",
                 holdout_start::text AS "holdoutStart", price_source AS "priceSource",
                 updated_at::text AS "updatedAt"
          FROM watchlist_sync.strategies
          WHERE strategy_id = ${id} AND version = ${versionQ}
          LIMIT 1`)
      : await safe<StrategyRow>(sql`
          SELECT DISTINCT ON (strategy_id)
            strategy_id AS "strategyId", version, name, family, instrument, status, summary,
            rules_md AS "rulesMd", caveats_md AS "caveatsMd", study_ref AS "studyRef",
            window_start::text AS "windowStart", window_end::text AS "windowEnd",
            holdout_start::text AS "holdoutStart", price_source AS "priceSource",
            updated_at::text AS "updatedAt"
          FROM watchlist_sync.strategies
          WHERE strategy_id = ${id}
          ORDER BY strategy_id, version DESC`);

    const meta = metaRows[0];
    if (!meta) {
      res.status(404).json({ error: "strategy not found" });
      return;
    }

    const equity = to
      ? await safe<EquityPt>(sql`
          SELECT d::text AS d, equity::float8 AS equity, spy_equity::float8 AS "spyEquity",
                 drawdown::float8 AS drawdown, is_holdout AS "isHoldout"
          FROM watchlist_sync.strategy_equity
          WHERE strategy_id = ${meta.strategyId} AND version = ${meta.version}
            AND d >= ${from}::date AND d <= ${to}::date
          ORDER BY d`)
      : await safe<EquityPt>(sql`
          SELECT d::text AS d, equity::float8 AS equity, spy_equity::float8 AS "spyEquity",
                 drawdown::float8 AS drawdown, is_holdout AS "isHoldout"
          FROM watchlist_sync.strategy_equity
          WHERE strategy_id = ${meta.strategyId} AND version = ${meta.version}
            AND d >= ${from}::date
          ORDER BY d`);

    const trades = to
      ? await safe<TradeRow>(sql`
          SELECT id::int AS id, entry_ts::text AS "entryTs", exit_ts::text AS "exitTs",
                 ticker, instrument, side, option_type AS "optionType",
                 strike::float8 AS strike, expiry::text AS expiry, dte_at_entry AS "dteAtEntry",
                 qty::float8 AS qty, entry_px::float8 AS "entryPx", exit_px::float8 AS "exitPx",
                 capital::float8 AS capital, pnl::float8 AS pnl, ret_pct::float8 AS "retPct",
                 trigger, exit_reason AS "exitReason", is_holdout AS "isHoldout"
          FROM watchlist_sync.strategy_trades
          WHERE strategy_id = ${meta.strategyId} AND version = ${meta.version}
            AND entry_ts::date >= ${from}::date AND entry_ts::date <= ${to}::date
          ORDER BY entry_ts`)
      : await safe<TradeRow>(sql`
          SELECT id::int AS id, entry_ts::text AS "entryTs", exit_ts::text AS "exitTs",
                 ticker, instrument, side, option_type AS "optionType",
                 strike::float8 AS strike, expiry::text AS expiry, dte_at_entry AS "dteAtEntry",
                 qty::float8 AS qty, entry_px::float8 AS "entryPx", exit_px::float8 AS "exitPx",
                 capital::float8 AS capital, pnl::float8 AS pnl, ret_pct::float8 AS "retPct",
                 trigger, exit_reason AS "exitReason", is_holdout AS "isHoldout"
          FROM watchlist_sync.strategy_trades
          WHERE strategy_id = ${meta.strategyId} AND version = ${meta.version}
            AND entry_ts::date >= ${from}::date
          ORDER BY entry_ts`);

    const stats = computeStats(equity, trades);

    res.json({
      strategy: meta,
      stats,
      equity,
      trades,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Today page (Jamie 11-17: "I have never seen a signal fire… no clue whether the app is running… no unified view").
 * GET /api/today/overview → { status, signals, puts }:
 *   status  last daily.py run (scripts/watchlist_sync/out/runs/*.json) + as-of of each producer table
 *   signals every working rule (research/studies/BOARD.md 'Works') with its backtest number, firing today?, last fire
 *   puts    put_recs_daily latest: best (every gate) first, then ≥ 80 %-odds options with their cautions
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SIGNALS: { id: string; name: string; trade: string; backtest: string; study: string }[] = [
  { id: "panic-puts-hiv", name: "Panic put", trade: "sell ~0.20Δ put ~30 DTE on the name",
    backtest: "≥ 2σ 5-day drop + IV30 > 48.7: kept +4.05 % vs +0.26 % any day", study: "S054" },
  { id: "vix-uninvert-put", name: "Market bottom (VIX÷VIX3M un-inverts)", trade: "buy 0.50Δ 30 DTE SPY/QQQ calls or sell 0.20Δ puts",
    backtest: "calls +34–43 % per $ vs any day; SPY +2.98 % next 21 d vs +1.10 %, up 79 % (34 fires since 2010)", study: "S172 · S172b" },
  { id: "vix-uninvert-put-hibeta", name: "Market bottom, high-beta names", trade: "sell 0.20Δ 30 DTE puts on top-beta fifth",
    backtest: "+3.0 % / +2.0 % per $ collateral per 30 d vs SPY put +0.9 / +0.6 (18 episodes, model prices)", study: "S172" },
  { id: "put_z50_dip_d20", name: "Dip below 50-day mean", trade: "sell 0.20Δ put", backtest: "paper rule — put-timing filter (A370), not yet graded live", study: "A370" },
  { id: "put_gap_up_5pct_d20", name: "Gap up ≥ 5 %", trade: "sell 0.20Δ put", backtest: "paper rule — put-timing filter (A370), not yet graded live", study: "A370" },
  { id: "put_climax_low_ivrv", name: "Selling climax, IV not rich", trade: "sell put", backtest: "paper rule — put-timing filter (A370)", study: "A370" },
  { id: "put_climax_spy_oversold", name: "Selling climax + SPY oversold", trade: "sell put", backtest: "paper rule — put-timing filter (A370)", study: "A370" },
];

function lastRun(): { at: string | null; status: string | null; failed: string[] } {
  try {
    const dir = resolve(ROOT, "scripts/watchlist_sync/out/runs");
    const f = readdirSync(dir).filter((x) => x.endsWith(".json")).sort().pop();
    if (!f) return { at: null, status: null, failed: [] };
    const j = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as { started?: string; status?: string; steps?: { step: string; ok: boolean }[] };
    return { at: j.started ?? null, status: j.status ?? null, failed: (j.steps ?? []).filter((s) => !s.ok).map((s) => s.step) };
  } catch {
    return { at: null, status: null, failed: [] };
  }
}

/** Seen tracking (Jamie 11-17: "a way to verify I have truly read the recommendation"): one row per item key the user
 *  clicked. Keys: sig:<strategy_id>:<ticker>:<as_of> · put:<ticker>:<as_of>. Unseen items render yellow on /today. */
let seenReady = false;
async function ensureSeen(): Promise<void> {
  if (seenReady) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_sync.rec_seen (
    item_key text PRIMARY KEY, kind text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now())`);
  seenReady = true;
}

router.post("/today/seen", requireAdmin, async (req, res, next) => {
  try {
    const keys = (Array.isArray(req.body?.keys) ? req.body.keys : []).filter((k: unknown): k is string =>
      typeof k === "string" && /^(sig|put):[\w.\-:]{1,120}$/.test(k)).slice(0, 500);
    await ensureSeen();
    for (const k of keys) {
      await db.execute(sql`INSERT INTO watchlist_sync.rec_seen (item_key, kind) VALUES (${k}, ${k.split(":")[0]})
        ON CONFLICT (item_key) DO NOTHING`);
    }
    res.json({ ok: true, n: keys.length });
  } catch (err) {
    next(err);
  }
});

router.get("/today/overview", requireAdmin, async (_req, res, next) => {
  try {
    await ensureSeen();
    const asOf = await safe<{ src: string; d: string | null }>(sql`
      SELECT 'putIdeas' AS src, MAX(computed_at)::text AS d FROM watchlist_sync.put_recs_daily
      UNION ALL SELECT 'todayList', MAX(as_of)::text FROM watchlist_sync.trade_funnel_daily WHERE stage = 'today'
      UNION ALL SELECT 'signals', MAX(as_of)::text FROM watchlist_sync.strategy_signals`);
    const fired = await safe<{ id: string; last: string; today: number; n5: number; names: string[] }>(sql`
      SELECT strategy_id AS id, MAX(as_of)::text AS last,
             (COUNT(DISTINCT ticker) FILTER (WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.strategy_signals)))::int AS today,
             (COUNT(DISTINCT as_of) FILTER (WHERE as_of >= current_date - 7))::int AS n5,
             (ARRAY_AGG(DISTINCT ticker) FILTER (WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.strategy_signals)))[1:8] AS names
      FROM watchlist_sync.strategy_signals GROUP BY strategy_id`);
    const byId = new Map(fired.map((f) => [f.id, f]));
    // every fire in the last 7 days (strategy × ticker × day) and whether Jamie clicked it — the seen-rate funnel
    const fires = await safe<{ key: string; id: string; ticker: string; d: string; seen: boolean }>(sql`
      SELECT DISTINCT 'sig:' || s.strategy_id || ':' || s.ticker || ':' || s.as_of::text AS key, s.strategy_id AS id, s.ticker,
             s.as_of::text AS d, (v.item_key IS NOT NULL) AS seen
      FROM watchlist_sync.strategy_signals s
      LEFT JOIN watchlist_sync.rec_seen v ON v.item_key = 'sig:' || s.strategy_id || ':' || s.ticker || ':' || s.as_of::text
      WHERE s.as_of >= current_date - 7`);
    const putSeen = new Set((await safe<{ k: string }>(sql`SELECT item_key AS k FROM watchlist_sync.rec_seen WHERE kind = 'put'`)).map((r) => r.k));
    const signals = SIGNALS.map((s) => {
      const f = byId.get(s.id);
      const latest = fires.filter((x) => x.id === s.id && x.d === f?.last);
      return { ...s, lastFired: f?.last ?? null, firingNames: f?.today ?? 0, daysFiredLast7: f?.n5 ?? 0, names: f?.names ?? [],
               keys: latest.map((x) => x.key), unseen: latest.filter((x) => !x.seen).length };
    });
    const puts = await safe<{ ticker: string; rank: number; p: Record<string, unknown> }>(sql`
      SELECT ticker, rank, payload AS p FROM watchlist_sync.put_recs_daily
      WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND pass ORDER BY rank`);
    const putAsOf = (asOf.find((r) => r.src === "putIdeas")?.d ?? "").slice(0, 10);
    const bySig = new Map<string, { fired: number; seen: number }>();
    for (const x of fires) {
      const b = bySig.get(x.id) ?? { fired: 0, seen: 0 };
      b.fired += 1; b.seen += x.seen ? 1 : 0; bySig.set(x.id, b);
    }
    res.json({
      status: { lastRun: lastRun(), asOf: Object.fromEntries(asOf.map((r) => [r.src, r.d])) },
      seen7d: { fired: fires.length, seen: fires.filter((x) => x.seen).length, bySignal: Object.fromEntries(bySig) },
      signals,
      puts: puts.map(({ ticker, rank, p }) => ({
        ticker, rank, tier: (p.tier as string) ?? "best", strike: p.strike, expiry: p.expiry, bid: p.bid, delta: p.delta,
        oddsOtm: p.odds_otm ?? (typeof p.delta === "number" ? 1 - Math.abs(p.delta) : null), incomeWkPct: p.income_wk_pct,
        why: p.why, cautions: (p.cautions as string[]) ?? [], key: `put:${ticker}:${putAsOf}`, seen: putSeen.has(`put:${ticker}:${putAsOf}`),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
