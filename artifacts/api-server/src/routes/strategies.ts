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
import { getIvTermStructure } from "../lib/options.js";
import { ivTermCache } from "./options.js";

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
    backtest: "calls +34–43 % per $ vs any day; SPY +2.98 % next 21 d vs +1.10 %, up 79 % (34 fires since 2010); 0.20Δ puts on ~1,000 names in the 10 days after: +0.58 % vs +0.27 % any day (40 episodes, p 0.03)", study: "S172 · S172b · S197b" },
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

// Bottom checklist (Jamie 11-17: "how will you know it's the right time to get long?"). Four tested/observable reads, no
// forecast: VIX term structure (S172 un-invert), SPY depth → 6-month odds (S198 C2), did the catalyst move hold, credit.
// S198 C2 (rerun 11-17, SPY 2009→, forward 126 sessions by depth off its high): mean · % up · worst.
const DEPTH_ODDS: { lo: number; hi: number; label: string; fwd: number; up: number; worst: number; months: number }[] = [
  { lo: -0.03, hi: 1, label: "0–3 % off", fwd: 4.6, up: 75, worst: -25, months: 154 },
  { lo: -0.05, hi: -0.03, label: "3–5 % off", fwd: 7.2, up: 85, worst: -21, months: 105 },
  { lo: -0.10, hi: -0.05, label: "5–10 % off", fwd: 9.2, up: 88, worst: -21, months: 81 },
  { lo: -0.20, hi: -0.10, label: "10–20 % off", fwd: 12.6, up: 87, worst: -13, months: 52 },
  { lo: -1, hi: -0.20, label: "20 %+ off", fwd: 18.6, up: 98, worst: -1, months: 12 },
];
type Check = { key: string; label: string; value: string; read: "up" | "down" | "wait"; why: string };

// Jamie's stock + option underlyings from the latest broker snapshot (catalysts and tenor cost follow his book, not a pick of ours).
async function holdingTickers(): Promise<string[]> {
  const rows = await safe<{ t: string }>(sql`
    WITH s AS (SELECT id FROM public.portfolio_snapshots ORDER BY id DESC LIMIT 1)
    SELECT DISTINCT symbol AS t FROM public.portfolio_positions p, s WHERE p.snapshot_id = s.id AND market_value > 500
    UNION SELECT DISTINCT symbol FROM public.portfolio_options o, s WHERE o.snapshot_id = s.id`);
  // keep operating companies only (universe = source_fundamentals); drops option-income ETFs like HOOY / NVDY
  const tickers = rows.map((r) => r.t).filter(Boolean);
  if (!tickers.length) return [];
  const known = await safe<{ t: string }>(sql`SELECT DISTINCT ticker AS t FROM public.source_fundamentals WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})`);
  return known.map((r) => r.t).sort();
}

type Series = { ratio: { date: string; value: number }[]; hy: { date: string; value: number }[] };
async function bottomChecklist(): Promise<{ checks: Check[]; asOf: string | null; series: Series }> {
  const checks: Check[] = [];
  // 1. VIX ÷ VIX3M: streak inverted, last un-invert fire (≥ 2 inverted days then < 1) = S172 market-bottom signal.
  const vr = await safe<{ date: string; r: number }>(sql`
    SELECT v.date::text AS date, (v.value / NULLIF(m.value, 0))::float8 AS r FROM watchlist_sync.macro_daily v
    JOIN watchlist_sync.macro_daily m ON m.series = 'vix3m' AND m.date = v.date
    WHERE v.series = 'vix' ORDER BY v.date DESC LIMIT 260`);
  if (vr.length) {
    const now = vr[0];
    let streak = 0; while (streak < vr.length && vr[streak].r >= 1) streak++;
    let fire: string | null = null;
    for (let i = 0; i + 2 < vr.length; i++) if (vr[i].r < 1 && vr[i + 1].r >= 1 && vr[i + 2].r >= 1) { fire = vr[i].date; break; }
    const tail = vr.slice(0, 6).reverse().map((x) => x.r.toFixed(2)).join(" → ");
    checks.push(streak > 0
      ? { key: "vix", label: "Fear curve (VIX ÷ VIX3M)", value: `${now.r.toFixed(2)} · inverted ${streak} day${streak > 1 ? "s" : ""}`, read: "wait",
          why: `Panic is on (${tail}). ${streak === 1 ? "Day 1 out of a calm curve usually fades: back below 1 next day 58 %, within 5 days 89 %; SPY next 21 d +1.8 % vs +1.1 % any day (S199, 81 cases since 2009). " : ""}The tested buy is the first close back below 1 after ≥ 2 inverted days: 30-day index calls +34–43 % per $ vs any day (S172). Single names at that fire: a basket of the most volatile fifth beat SPY +2.4 % in 21 d, +6.6 % in 63 d (52 fires, t 2.3–2.8) — but any one name only 52 % of the time; crashed names weaker (t 1.5) (S200).${streak >= 2 ? " Armed — next close below 1 fires it." : " Needs 1 more inverted day to arm."}` }
      : { key: "vix", label: "Fear curve (VIX ÷ VIX3M)", value: `${now.r.toFixed(2)} · calm`, read: fire && Date.parse(fire) >= Date.parse(now.date) - 10 * 864e5 ? "up" : "wait",
          why: `${fire ? `Last market-bottom fire ${fire.slice(5)} (S172: index calls +34–43 % per $ vs any day).` : "No un-invert fire in the last year."} ${tail}` });
  }
  // 2. SPY depth off its high → 6-month odds (deeper = better; S198 C2).
  const spy = await safe<{ date: string; c: number; hi: number }>(sql`
    SELECT MAX(date)::text AS date, (ARRAY_AGG(close ORDER BY date DESC))[1]::float8 AS c, MAX(close)::float8 AS hi
    FROM (SELECT date, close FROM public.prices_historical WHERE ticker = 'SPY' ORDER BY date DESC LIMIT 252) t`);
  if (spy[0]?.c) {
    const dd = spy[0].c / spy[0].hi - 1;
    const b = DEPTH_ODDS.find((x) => dd > x.lo && dd <= x.hi) ?? DEPTH_ODDS[0];
    const deeper = DEPTH_ODDS[DEPTH_ODDS.indexOf(b) + 1];
    checks.push({ key: "depth", label: "SPY off its high", value: `${(dd * 100).toFixed(1)} % → 6 m +${b.fwd} %, up ${b.up} %`, read: dd <= -0.05 ? "up" : "wait",
      why: `Since 2009, SPY ${b.label} its high: next 6 months +${b.fwd} % on average, up ${b.up} % of the time, worst ${b.worst} % (${b.months} months of data) vs +4.6 % near highs.${deeper ? ` If it falls to ${deeper.label}: +${deeper.fwd} %, up ${deeper.up} % — a further drop is a better entry, not a reason to bail.` : ""} Near-term bounce edge: none (S198).` });
  }
  // 3. Did the catalyst move hold? Jamie's holdings reporting in the last 5 days (close before vs day 1 and latest).
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;
  const held = await holdingTickers();
  const cal = held.length ? await safe<{ t: string; rd: string; recent: boolean }>(sql`
    SELECT ticker AS t, report_date::text AS rd, (report_date <= current_date) AS recent FROM public.earnings_calendar
    WHERE ticker IN (${sql.join(held.map((t) => sql`${t}`), sql`, `)}) AND report_date BETWEEN current_date - 5 AND current_date + 90
    ORDER BY report_date`) : [];
  const recent = [...new Set(cal.filter((c) => c.recent).map((c) => c.t))];
  const next = cal.find((c) => !c.recent);
  if (!recent.length) checks.push({ key: "cat-none", label: "Your names' earnings", value: next ? `none this week · next ${next.t} ${next.rd.slice(5)}` : "none in 90 days", read: "wait",
    why: "Your holdings already reported Q3 — no company catalyst left until the next season. 'Bad news baked in → reversal' does not hold as a rule: names down ≥ 20 % into earnings during a market dip reacted median −1.1 %, up 46 % (S201, 161 reports, 13 quarters)." });
  for (const t of recent) {
    const rows = await safe<{ rd: string; date: string; c: number }>(sql`
      WITH r AS (SELECT MAX(report_date) AS rd FROM public.earnings_calendar WHERE ticker = ${t} AND report_date <= current_date)
      SELECT r.rd::text AS rd, p.date::text AS date, p.close::float8 AS c FROM r JOIN public.prices_historical p
        ON p.ticker = ${t} AND p.date >= r.rd ORDER BY p.date LIMIT 6`);
    if (!rows.length) continue;
    const pre = rows[0].date === rows[0].rd ? rows[0] : null; // report after the close of rd
    const post = rows.filter((x) => x.date > rows[0].rd);
    if (!pre || !post.length) {
      checks.push({ key: `cat-${t}`, label: `${t} earnings reaction`, value: `reported ${rows[0].rd.slice(5)} · first session pending`, read: "wait",
        why: "Watch day 1 and whether it holds through day 2–3 — a beat the price keeps is the meaningful case. Names down ≥ 20 % into a report during a market dip reacted median −1.1 % (S201), so 'baked in' alone is not an edge." });
      continue;
    }
    const d1 = post[0].c / pre.c - 1, last = post[post.length - 1], since = last.c / pre.c - 1;
    const held = post.length >= 2 && d1 > 0 && since >= d1 / 2;
    checks.push({ key: `cat-${t}`, label: `${t} earnings reaction`, value: `day 1 ${pct(d1)} · now ${pct(since)} (${post.length} session${post.length > 1 ? "s" : ""})`,
      read: post.length < 2 ? "wait" : held ? "up" : "down",
      why: post.length < 2 ? "One session in — wait for day 2–3 before reading it." : held ? "Up on the report and still holding most of it — buyers accept the story." : d1 > 0 ? "Up on the report but gave most of it back — sellers used the news to exit." : "Down on the report and not recovered — the report did not mark a low." });
  }
  // 4. Credit (HY OAS, FRED): the selloff started with CoreWeave debt — stocks up while spreads widen = suspect bounce.
  const hy = await safe<{ date: string; v: number; v10: number | null; pct: number }>(sql`
    WITH s AS (SELECT date, value::float8 AS v FROM watchlist_sync.macro_daily WHERE series = 'hy_oas')
    SELECT (SELECT MAX(date)::text FROM s) AS date, (SELECT v FROM s ORDER BY date DESC LIMIT 1) AS v,
           (SELECT v FROM s ORDER BY date DESC OFFSET 10 LIMIT 1) AS v10,
           (100 * AVG((v <= (SELECT v FROM s ORDER BY date DESC LIMIT 1))::int))::float8 AS pct FROM s`);
  if (hy[0]?.v != null) {
    const { v, v10, pct, date } = hy[0];
    const ch = v10 != null ? v - v10 : 0;
    checks.push({ key: "credit", label: "Junk-bond spread", value: `${v.toFixed(2)} % (${ch >= 0 ? "+" : ""}${ch.toFixed(2)} in 10 d)`, read: ch > 0.3 ? "down" : ch < -0.1 ? "up" : "wait",
      why: `${date.slice(5)}: ${pct.toFixed(0)}th percentile of the last 3 years (2020 panic peaked near 10 %). ${ch > 0.3 ? "Widening fast — credit is not buying the bounce." : "Not a credit event: debt markets are calm while stocks fell."} Untested as a timing rule here — context only.` });
  }
  const hyS = await safe<{ date: string; value: number }>(sql`
    SELECT date::text AS date, value::float8 AS value FROM watchlist_sync.macro_daily
    WHERE series = 'hy_oas' AND date >= current_date - 400 ORDER BY date`);
  const asOf = vr[0]?.date ?? null;
  return { checks, asOf, series: { ratio: vr.map((x) => ({ date: x.date, value: Math.round(x.r * 1000) / 1000 })).reverse(), hy: hyS } };
}

// Jamie 11-17: "6 m is the worst point on the VIX curve — I'd rather buy the cheaper 3 m." Per holding: ATM IV at 3 M vs 6 M
// (live chain, cached 1 h, shared with /options/:t/term-structure) and ATM call cost ≈ 0.4·σ·√T as % of spot.
router.get("/today/tenor-cost", requireAdmin, async (_req, res, next) => {
  try {
    const tickers = ["SPY", ...(await holdingTickers())];
    const rows = await Promise.all(tickers.map(async (t) => {
      const pts = await Promise.race([
        ivTermCache.getOrCompute(t, () => getIvTermStructure(t)),
        new Promise<null>((r) => setTimeout(() => r(null), 8000)), // deadline per vendor call (rule 8c)
      ]).catch(() => null);
      const ok = (p?: { iv: number; dte: number }) => (p && p.iv >= 0.05 && p.iv < 5 ? p : undefined); // GOSS 11-17 returned iv 1e-5 = no quote
      const m3 = ok(pts?.find((p) => p.label === "3M")), m6 = ok(pts?.find((p) => p.label === "6M"));
      if (!m3?.iv || !m6?.iv) return { ticker: t, iv3: m3?.iv ?? null, iv6: m6?.iv ?? null, cost3: null, cost6: null, dte3: m3?.dte ?? null, dte6: m6?.dte ?? null };
      const cost = (p: { iv: number; dte: number }) => 0.4 * p.iv * Math.sqrt(p.dte / 365);
      return { ticker: t, iv3: m3.iv, iv6: m6.iv, cost3: cost(m3), cost6: cost(m6), dte3: m3.dte, dte6: m6.dte };
    }));
    res.json({ rows });
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
    // S197b (11-17, 2009→): panic puts sold while VIX ÷ VIX3M ≥ 1 earn no more than calm (+0.24 vs +0.25 %, 77 episodes)
    const vixRows = await safe<{ series: string; value: number; date: string }>(sql`
      SELECT DISTINCT ON (series) series, value::float8 AS value, date::text AS date FROM watchlist_sync.macro_daily
      WHERE series IN ('vix', 'vix3m') ORDER BY series, date DESC`);
    const vix = vixRows.find((r) => r.series === "vix"), vix3m = vixRows.find((r) => r.series === "vix3m");
    const vixRatio = vix && vix3m && vix.date === vix3m.date && vix3m.value > 0 ? vix.value / vix3m.value : null;
    const cautionFor = (id: string): string | null => id === "panic-puts-hiv" && vixRatio != null && vixRatio >= 1
      ? `VIX ÷ VIX3M ${vixRatio.toFixed(2)} (${vix!.date.slice(5)}) — still inverted: panic puts then earn no more than on calm days (+0.24 % vs +0.25 %, 77 episodes since 2009; since 2017 worst 10 % −11.1 vs −8.2). Normal size, not bigger. Puts on names that did NOT just crash earn +0.74 % here (S197b).`
      : null;
    const signals = SIGNALS.map((s) => {
      const f = byId.get(s.id);
      const latest = fires.filter((x) => x.id === s.id && x.d === f?.last);
      return { ...s, lastFired: f?.last ?? null, firingNames: f?.today ?? 0, daysFiredLast7: f?.n5 ?? 0, names: f?.names ?? [],
               keys: latest.map((x) => x.key), unseen: latest.filter((x) => !x.seen).length, caution: cautionFor(s.id) };
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
      bottom: await bottomChecklist(),
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
