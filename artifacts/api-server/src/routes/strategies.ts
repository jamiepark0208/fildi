/**
 * Strategy Library (A175) — read-only. Tables written by Claude's A176 runner
 * (scripts/watchlist_sync/analysis/strategy_lib.py). This route never computes trades.
 *
 * GET /api/strategies              — list + headline stats (admin)
 * GET /api/strategies/:id          — meta, stats, equity, trades (admin)
 */
import { Router } from "express";
import { isMarketOpen } from "../lib/market-hours.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getIvTermStructure } from "../lib/options.js";
import { ivTermCache } from "./options.js";
import { normCDF } from "../lib/options-greeks.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { readChainSnapshot } from "../lib/options-chain-store.js";
import { rankerChains } from "../lib/structures/ranker-chain.js";
import { frontSkew, levelsFromBars, pickFundingPut, pickRiskReversal, RR_PARAMS, type Bar } from "../lib/risk-reversal.js";
import { allocate, optionSource, rankSources, stockSource, type Need, type Source } from "../lib/capital-plan.js";

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

// Jamie 11-17 (S198 follow-up): "your open long calls — odds to breakeven". Latest RH snapshot, market-implied (IV, no drift):
// P(expire above breakeven), P(touch it before expiry) ≈ 2 × that (reflection), move needed, value left, theta/day.
router.get("/today/long-calls", requireAdmin, async (_req, res, next) => {
  try {
    const rows = await safe<{ account: string; ticker: string; strike: number; expiry: string; qty: number; cost: number; mark: number | null;
      iv: number | null; theta: number | null; spot: number | null; spot_date: string | null; snap_at: string }>(sql`
      WITH s AS (SELECT id, imported_at FROM public.portfolio_snapshots ORDER BY id DESC LIMIT 1)
      SELECT o.account, UPPER(o.symbol) AS ticker, o.strike::float8 AS strike, o.expiration::text AS expiry, o.qty::float8 AS qty,
             o.avg_premium::float8 / 100 AS cost, o.mark_price::float8 AS mark, o.iv::float8 AS iv, o.theta::float8 AS theta,
             p.close AS spot, p.date AS spot_date, s.imported_at::text AS snap_at
      FROM public.portfolio_options o JOIN s ON o.snapshot_id = s.id
      LEFT JOIN LATERAL (SELECT close::float8 AS close, date::text AS date FROM public.prices_historical h
                         WHERE UPPER(h.ticker) = UPPER(o.symbol) ORDER BY date DESC LIMIT 1) p ON true
      WHERE o.direction = 'long' AND o.option_type = 'call' AND o.expiration >= CURRENT_DATE
      ORDER BY o.expiration, o.symbol, o.strike`);
    const today = Date.now();
    const out = rows.map((r) => {
      const days = Math.max(1, Math.round((Date.parse(r.expiry + "T16:00:00-05:00") - today) / 86_400_000));
      const be = r.strike + r.cost;
      const iv = r.iv != null && r.iv > 0.05 && r.iv < 5 ? r.iv : null; // same junk-IV guard as tenor-cost
      const sd = iv != null ? iv * Math.sqrt(days / 365) : null;
      const pBe = r.spot && sd ? 1 - normCDF((Math.log(be / r.spot) + 0.5 * sd * sd) / sd) : null;
      const pK = r.spot && sd ? 1 - normCDF((Math.log(r.strike / r.spot) + 0.5 * sd * sd) / sd) : null;
      return { account: r.account.slice(-4), ticker: r.ticker, strike: r.strike, expiry: r.expiry, days, qty: r.qty,
        cost: r.cost, mark: r.mark, breakeven: be, spot: r.spot, spotDate: r.spot_date,
        moveToBe: r.spot ? be / r.spot - 1 : null, sdMove: sd, pBreakeven: pBe, pTouch: pBe != null ? Math.min(1, 2 * pBe) : null, pItm: pK,
        valueLeft: r.mark != null ? r.mark * 100 * r.qty : null, paid: r.cost * 100 * r.qty,
        thetaDay: r.theta != null ? r.theta * 100 * r.qty : null };
    });
    res.json({ rows: out, snapAt: rows[0]?.snap_at ?? null });
  } catch (err) {
    next(err);
  }
});

// Jamie 11-18: put-funded calls (risk reversal) — sell an OTM put at support on a name worth owning, use the credit
// to buy a longer OTM call below resistance. Pool = holdings + Model List green names (best `own` + most crashed).
// Chains = stored + Schwab ladder (rankerChains, 15-min cache, 12 s deadline); 4 names at a time; whole answer cached 15 min.
const rrCache = new TTLCache<unknown>(15 * 60 * 1000, "today-risk-reversals", 4);
async function riskReversals() {
  const held = await holdingTickers();
  const pool = await safe<{ t: string; own: number | null; color: string | null; dd: number | null }>(sql`
    WITH v AS (SELECT model_version FROM watchlist_sync.fit_scores ORDER BY computed_at DESC LIMIT 1),
    f AS (SELECT s.ticker, s.own::float8 AS own, s.color FROM watchlist_sync.fit_scores s, v WHERE s.model_version = v.model_version),
    d AS (SELECT ticker, (ARRAY_AGG(close ORDER BY date DESC))[1]::float8 / NULLIF(MAX(high), 0)::float8 - 1 AS dd
          FROM public.prices_historical WHERE date >= current_date - 365 GROUP BY ticker),
    g AS (SELECT f.ticker, f.own, f.color, d.dd FROM f LEFT JOIN d USING (ticker) WHERE f.color = 'green'),
    pick AS ((SELECT ticker FROM g ORDER BY own DESC NULLS LAST LIMIT 12)
             UNION (SELECT ticker FROM g WHERE dd <= -0.25 ORDER BY own DESC NULLS LAST LIMIT 12)
             UNION (SELECT UNNEST(ARRAY[${sql.join((held.length ? held : ["__"]).map((t) => sql`${t}`), sql`, `)}]::text[])))
    SELECT p.ticker AS t, f.own, f.color, d.dd FROM pick p LEFT JOIN f USING (ticker) LEFT JOIN d USING (ticker)`);
  // Step 3 (Jamie 11-18 "fund an existing long call"): open long calls in the latest RH snapshot → a put on the same name.
  const heldCalls = await safe<{ account: string; ticker: string; strike: number; expiry: string; qty: number; cost: number;
    mark: number | null; iv: number | null }>(sql`
    WITH s AS (SELECT id FROM public.portfolio_snapshots ORDER BY id DESC LIMIT 1)
    SELECT o.account, UPPER(o.symbol) AS ticker, o.strike::float8 AS strike, o.expiration::text AS expiry, o.qty::float8 AS qty,
           o.avg_premium::float8 / 100 AS cost, o.mark_price::float8 AS mark, o.iv::float8 AS iv
    FROM public.portfolio_options o JOIN s ON o.snapshot_id = s.id
    WHERE o.direction = 'long' AND o.option_type = 'call' AND o.expiration >= CURRENT_DATE`);
  // Step 4 (Jamie 11-19 "I don't have enough cash for NVDA puts"): fit each idea to its account's cash. Margin loan →
  // no new puts (standing rule 10-06, S012; applied to every margin account — same process across IRA/FILDI/MOM).
  const accts = new Map((await safe<{ account: string; nickname: string | null; cash: number; loan: number }>(sql`
    SELECT account, nickname, cash::float8 AS cash, COALESCE(margin_used, 0)::float8 AS loan FROM public.portfolio_account_summaries
    WHERE snapshot_id = (SELECT MAX(id) FROM public.portfolio_snapshots)`)).map((a) => [a.account, a]));
  const cashFit = (account: string, fp: { cashIfAssigned: number; spread: { collateral: number } | null }) => {
    const a = accts.get(account);
    if (!a) return null;
    const cash = Math.max(0, a.cash), loan = a.loan > 0 || a.cash < 0 ? Math.max(a.loan, -a.cash) : 0;
    return { name: a.nickname, cash, loan, putFits: loan === 0 && cash >= fp.cashIfAssigned,
      spreadFits: fp.spread != null && loan === 0 && cash >= fp.spread.collateral,
      needPut: Math.max(0, fp.cashIfAssigned - cash) + loan, needSpread: fp.spread ? Math.max(0, fp.spread.collateral - cash) + loan : null };
  };
  const funding: unknown[] = [];
  const out: unknown[] = [];
  const skipped: { ticker: string; why: string }[] = [];
  const liveSkew: (NonNullable<ReturnType<typeof frontSkew>> & { ticker: string })[] = [];
  // A Schwab ladder that times out (12 s) or comes back empty gets ONE retry after the first pass (Jamie 11-20: "no live
  // chain" rows vanished from Today); only a second failure is reported.
  let queue = pool;
  const retry: typeof pool = [];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const row = queue[i++]!;
      const t = row.t;
      try {
        const snap = await readChainSnapshot(t).catch(() => null);
        const { chains, filled } = await rankerChains(t, snap?.chains ?? [], RR_PARAMS.callDte[1]);
        const spot = chains[0]?.spot;
        if (!filled && queue === pool) { retry.push(row); continue; }
        if (!spot || !filled) { skipped.push({ ticker: t, why: filled ? "no spot" : "Schwab chain did not answer twice — next refresh retries" }); continue; }
        const bars = await safe<Bar>(sql`SELECT date::text AS date, high::float8 AS high, low::float8 AS low, close::float8 AS close
          FROM (SELECT * FROM public.prices_historical WHERE ticker = ${t} ORDER BY date DESC LIMIT 260) x ORDER BY date`);
        const lv = levelsFromBars(bars, spot);
        const fs = frontSkew(chains);
        if (fs) liveSkew.push({ ticker: t, ...fs });
        let any = false;
        for (const dir of ["bull", "bear"] as const) {
          const pair = pickRiskReversal(chains, spot, lv, RR_PARAMS, dir);
          if (!pair) continue;
          any = true;
          // Front IV inflated by a report inside the short window = event gap risk, not skew (ZM 11-18: edge 22 pts, RR25 0.6)
          const er = await safe<{ d: string }>(sql`SELECT MIN(report_date)::text AS d FROM public.earnings_calendar
            WHERE ticker = ${t} AND report_date >= current_date AND report_date <= ${pair.long.expiry}::date`);
          const erDate = er[0]?.d ?? null;
          out.push({ ticker: t, held: held.includes(t), own: row.own, color: row.color, offHigh: row.dd, ...pair,
            earnings: erDate, earningsInShort: erDate != null && erDate <= pair.short.expiry,
            supports: lv.support.slice(0, 3), resistances: lv.resistance.slice(0, 3) });
        }
        for (const hc of heldCalls.filter((x) => x.ticker === t)) {
          const days = Math.max(1, Math.round((Date.parse(hc.expiry + "T16:00:00-05:00") - Date.now()) / 86_400_000));
          const call = { strike: hc.strike, expiry: hc.expiry, days, qty: hc.qty, cost: hc.cost, mark: hc.mark };
          const fp = pickFundingPut(chains, spot, lv, call, hc.iv);
          funding.push(fp ? { ticker: t, account: hc.account.slice(-4), fullAccount: hc.account, call, ...fp, fit: cashFit(hc.account, fp) }
            : { ticker: t, account: hc.account.slice(-4), call, short: null,
                why: days < RR_PARAMS.putDte[0] ? `call expires in ${days} d — no put window left` : "no quoted put 14–45 DTE at support before the call expires" });
        }
        if (!any) skipped.push({ ticker: t, why: "no quoted short 14–45 DTE / long 85–190 DTE in the Δ bands" });
      } catch (e) {
        skipped.push({ ticker: t, why: e instanceof Error ? e.message.slice(0, 80) : "error" });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  if (retry.length) { queue = retry; i = 0; await Promise.all(Array.from({ length: 2 }, () => worker())); }
  // Step 2 (Jamie 11-18 "relative ranking"): front-month 25Δ skew vs the name's own last 60 days + vs its sector today
  // (watchlist_sync.rr_skew_daily ← scripts/watchlist_sync/rr_skew.py, ~200–400 names/day from option_chain_history).
  // Live chains → today's row in the same history (big names the chain store skips: MU, NVDA, AMZN, SKHY …).
  if (liveSkew.length) await db.execute(sql`INSERT INTO watchlist_sync.rr_skew_daily (ticker, as_of, expiry, dte, rr25, atm_iv, p25, c25)
    VALUES ${sql.join(liveSkew.map((x) => sql`(${x.ticker}, current_date, ${x.expiry}::date, ${x.dte}, ${x.rr25}, ${x.atm}, ${x.p25}, ${x.c25})`), sql`, `)}
    ON CONFLICT (ticker, as_of) DO UPDATE SET expiry = EXCLUDED.expiry, dte = EXCLUDED.dte, rr25 = EXCLUDED.rr25,
      atm_iv = EXCLUDED.atm_iv, p25 = EXCLUDED.p25, c25 = EXCLUDED.c25, computed_at = now()`).catch(() => undefined);
  const ranks = await skewRanks([...new Set(out.map((r) => (r as { ticker: string }).ticker))]);
  for (const r of out as { ticker: string; skewRank?: unknown }[]) r.skewRank = ranks.get(r.ticker) ?? null;
  // Regime picks which list shows first (both always shown): fear curve ≥ 0.95 or the pool's median name ≥ 20 % off
  // its high → bull (crashed + fear rich → sell puts); else bear (calm + extended → sell calls).
  const vr = await safe<{ r: number }>(sql`SELECT (v.value / NULLIF(m.value, 0))::float8 AS r FROM watchlist_sync.macro_daily v
    JOIN watchlist_sync.macro_daily m ON m.series = 'vix3m' AND m.date = v.date WHERE v.series = 'vix' ORDER BY v.date DESC LIMIT 1`);
  const dds = pool.map((x) => x.dd).filter((x): x is number => x != null).sort((a, b) => a - b);
  const medDd = dds.length ? dds[Math.floor(dds.length / 2)] : null;
  const fear = vr[0]?.r ?? null;
  const defaultDirection = (fear != null && fear >= 0.95) || (medDd != null && medDd <= -0.2) ? "bull" : "bear";
  // every held call gets a row — a missing chain says why instead of vanishing
  const done = new Set((funding as { ticker: string }[]).map((x) => x.ticker));
  for (const hc of heldCalls) if (!done.has(hc.ticker))
    funding.push({ ticker: hc.ticker, account: hc.account.slice(-4), short: null,
      why: skipped.find((x) => x.ticker === hc.ticker)?.why ?? "not in the pool (holdings list missed it)" });
  // Jamie 11-19 "is Fildi set up to highlight all these perspectives?": every RR / funding row carries Fildi's own put-engine
  // verdict (pass, tier, cautions), news/event notes from the last 14 days, and the market state — rank + explain, never hide.
  const views = await fildiViews([...new Set([...(out as { ticker: string }[]), ...(funding as { ticker: string }[])].map((r) => r.ticker))]);
  for (const r of [...out, ...funding] as { ticker: string; view?: unknown }[]) r.view = views.get(r.ticker) ?? null;
  // Jamie 11-19 "don't exclude ideas based on capital … recommend how best to create that capital": every row keeps showing;
  // each gets a cash plan — fits now, or which holdings to sell (lib/capital-plan.ts), cash shared across rows per account.
  const capital = await capitalPlans(accts, funding as FundRow[], out as RRRow[]).catch((e) => ({ error: String(e).slice(0, 120) }));
  const market = await marketRead();
  return { rows: out, funding, market, skipped, capital, asOf: new Date().toISOString(), regime: { fear, medianOffHigh: medDd, defaultDirection } };
}
type FundRow = { ticker: string; account: string; fullAccount?: string; call?: { strike: number; expiry: string };
  short: unknown; cashIfAssigned?: number; view?: FildiView | null; payback?: number; capital?: unknown };
type RRRow = { ticker: string; direction?: string; earningsInShort?: boolean; volEdge?: number; cashIfAssigned: number | null; view?: FildiView | null; capital?: unknown };
async function capitalPlans(accts: Map<string, { account: string; nickname: string | null; cash: number; loan: number }>,
  funding: FundRow[], rr: RRRow[]) {
  const snap = sql`(SELECT MAX(id) FROM public.portfolio_snapshots)`;
  const stocks = await safe<{ account: string; t: string; q: number; px: number; avg: number | null }>(sql`
    SELECT account, UPPER(symbol) AS t, quantity::float8 AS q, (market_value / NULLIF(quantity, 0))::float8 AS px, avg_cost::float8 AS avg
    FROM public.portfolio_positions WHERE snapshot_id = ${snap} AND quantity > 0`);
  const opts = await safe<{ account: string; t: string; type: "call" | "put"; dir: "long" | "short"; k: number; e: string; q: number;
    mark: number | null; cost: number | null; iv: number | null }>(sql`
    SELECT account, UPPER(symbol) AS t, option_type AS type, direction AS dir, strike::float8 AS k, expiration::text AS e, qty::float8 AS q,
           mark_price::float8 AS mark, avg_premium::float8 / 100 AS cost, iv::float8 AS iv
    FROM public.portfolio_options WHERE snapshot_id = ${snap} AND expiration >= CURRENT_DATE`);
  const tickers = [...new Set([...stocks.map((s) => s.t), ...opts.map((o) => o.t)])];
  const list = sql.join((tickers.length ? tickers : ["__"]).map((t) => sql`${t}`), sql`, `);
  const views = await safe<{ t: string; f: string | null; v: string | null; p2f: number | null }>(sql`
    WITH mi AS (SELECT UPPER(ticker) t, (array_agg(folder_key ORDER BY CASE folder_key WHEN 'avoid' THEN 0 WHEN 'trim_risk' THEN 1
                  WHEN 'own' THEN 2 ELSE 3 END))[1] f, MAX(verdict) v
                FROM watchlist_sync.model_items WHERE run_id = (SELECT MAX(id) FROM watchlist_sync.model_runs) GROUP BY 1),
         fv AS (SELECT DISTINCT ON (ticker) UPPER(ticker) t, price_to_fair::float8 p2f FROM public.fair_value_snapshots
                WHERE UPPER(ticker) IN (${list}) ORDER BY ticker, as_of DESC)
    SELECT x.t, mi.f, mi.v, fv.p2f FROM UNNEST(ARRAY[${list}]::text[]) x(t) LEFT JOIN mi USING (t) LEFT JOIN fv USING (t)`);
  const vmap = new Map(views.map((v) => [v.t, v]));
  const lv = new Map<string, { spot: number; sup: number | null; res: number | null; offHigh: number | null }>();
  for (const t of tickers) {
    const bars = await safe<Bar>(sql`SELECT date::text AS date, high::float8 AS high, low::float8 AS low, close::float8 AS close
      FROM (SELECT * FROM public.prices_historical WHERE ticker = ${t} ORDER BY date DESC LIMIT 260) x ORDER BY date`);
    const spot = bars[bars.length - 1]?.close;
    if (!spot) continue;
    const l = levelsFromBars(bars, spot);
    const hi = Math.max(...bars.map((b) => b.high));
    // a level 1–2 % away is noise for a hold/sell call (ONDS 11-19: R/R 20.8) → nearest level ≥ 3 % from spot
    lv.set(t, { spot, sup: l.support.find((x) => x.price <= spot * 0.97)?.price ?? null,
      res: l.resistance.find((x) => x.price >= spot * 1.03)?.price ?? null, offHigh: hi > 0 ? spot / hi - 1 : null });
  }
  const A = [...accts.values()].map((a) => ({ account: a.account, name: a.nickname ?? a.account.slice(-4),
    cash: a.cash, loan: a.loan > 0 || a.cash < 0 ? Math.max(a.loan, -a.cash) : 0, taxable: !/ira/i.test(a.nickname ?? "") }));
  const taxable = new Map(A.map((a) => [a.account, a.taxable]));
  const locked = (acct: string, t: string) => 100 * opts.filter((o) => o.account === acct && o.t === t && o.type === "call" && o.dir === "short")
    .reduce((s, o) => s + o.q, 0);
  const sources: Source[] = [];
  for (const s of stocks) {
    const v = vmap.get(s.t), l = lv.get(s.t);
    const src = stockSource({ account: s.account, ticker: s.t, qty: s.q, px: s.px, avgCost: s.avg, folder: v?.f ?? null, verdict: v?.v ?? null,
      p2f: v?.p2f ?? null, offHigh: l?.offHigh ?? null, support: l?.sup ?? null, resistance: l?.res ?? null, lockedShares: locked(s.account, s.t) },
      taxable.get(s.account) ?? true);
    if (src) sources.push(src);
  }
  for (const o of opts) {
    const spot = lv.get(o.t)?.spot;
    const days = Math.max(1, Math.round((Date.parse(o.e + "T16:00:00-05:00") - Date.now()) / 86_400_000));
    const iv = o.iv != null && o.iv > 0.05 && o.iv < 5 ? o.iv : null;
    const be = o.type === "call" ? o.k + (o.cost ?? 0) : o.k - (o.cost ?? 0);
    const sd = iv && spot ? iv * Math.sqrt(days / 365) : null;
    const pAbv = sd && spot ? 1 - normCDF((Math.log(be / spot) + 0.5 * sd * sd) / sd) : null;
    const src = optionSource({ account: o.account, ticker: o.t, type: o.type, dir: o.dir, strike: o.k, expiry: o.e, qty: o.q, mark: o.mark,
      cost: o.cost, pBe: pAbv == null ? null : o.type === "call" ? pAbv : 1 - pAbv }, taxable.get(o.account) ?? true);
    if (src) sources.push(src);
  }
  // Priority: puts that fund calls you already own (engine passes first, as the card sorts), then new bullish RR ideas.
  // same order the card shows: engine passes first; RR rows: earnings-in-short last, engine passes, then vol edge
  const pass = (v?: FildiView | null) => Number(!!v?.engine?.pass);
  const fOrder = funding.map((f, i) => ({ f, i })).sort((a, b) => pass(b.f.view) - pass(a.f.view));
  const rOrder = rr.map((r, i) => ({ r, i })).sort((a, b) => Number(!!a.r.earningsInShort) - Number(!!b.r.earningsInShort)
    || pass(b.r.view) - pass(a.r.view) || (b.r.volEdge ?? 0) - (a.r.volEdge ?? 0));
  const needs: Need[] = [];
  fOrder.forEach(({ f, i }) => {
    if (!f.short || !f.cashIfAssigned || !f.fullAccount || !f.call) return;
    needs.push({ id: `f${i}`, account: f.fullAccount, ticker: f.ticker, need: f.cashIfAssigned,
      excludeKeys: [`opt:${f.fullAccount}:${f.ticker} ${f.call.strike}C ${f.call.expiry.slice(5)}`] });
  });
  rOrder.forEach(({ r, i }) => {
    if (r.direction === "bear" || !r.cashIfAssigned) return;
    needs.push({ id: `r${i}`, account: null, ticker: r.ticker, need: r.cashIfAssigned });
  });
  const plans = allocate(A, sources, needs);
  funding.forEach((f, i) => { if (plans.has(`f${i}`)) f.capital = plans.get(`f${i}`); });
  rr.forEach((r, i) => { if (plans.has(`r${i}`)) r.capital = plans.get(`r${i}`); });
  return { accounts: A.map((a) => ({ name: a.name, cash: Math.max(0, a.cash), loan: a.loan, taxable: a.taxable,
    sellOrder: rankSources(sources.filter((s) => s.account === a.account)).slice(0, 8)
      .map((s) => ({ what: s.what, cash: Math.round(s.cash), tier: s.tier, why: s.why })) })) };
}
type FildiView = { engine: { pass: boolean; tier: string | null; rank: number; strike: number | null; expiry: string | null;
  why: string | null; cautions: string[] } | null; engineAsOf: string | null; notes: { date: string; kind: string; text: string }[] };
async function fildiViews(tickers: string[]): Promise<Map<string, FildiView>> {
  const m = new Map<string, FildiView>();
  if (!tickers.length) return m;
  const list = sql.join(tickers.map((t) => sql`${t}`), sql`, `);
  const eng = await safe<{ ticker: string; as_of: string; pass: boolean; rank: number; p: Record<string, unknown> }>(sql`
    SELECT ticker, as_of::text AS as_of, pass, rank, payload AS p FROM watchlist_sync.put_recs_daily
    WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND ticker IN (${list})`);
  const notes = await safe<{ ticker: string; d: string; kind: string; body: string }>(sql`
    SELECT ticker, as_of::text AS d, tags->>0 AS kind, body FROM public.fund_score_notes
    WHERE ticker IN (${list}) AND as_of >= current_date - 14 AND tags ?| array['character', 'earnings', 'trade', 'levels']
    ORDER BY as_of DESC, id DESC`);
  const asOf = eng[0]?.as_of ?? null;
  for (const t of tickers) {
    const e = eng.find((x) => x.ticker === t);
    const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
    m.set(t, {
      engine: e ? { pass: e.pass, tier: (e.p.tier as string) ?? null, rank: e.rank, strike: num(e.p.strike), expiry: (e.p.expiry as string) ?? null,
        why: (e.p.why as string) ?? null, cautions: Array.isArray(e.p.cautions) ? (e.p.cautions as string[]) : [] } : null,
      engineAsOf: asOf,
      notes: notes.filter((n) => n.ticker === t).slice(0, 3).map((n) => ({ date: n.d, kind: n.kind, text: n.body.slice(0, 220) })),
    });
  }
  return m;
}
// One line on the market for put sellers, from the studies (S172 / S197b / S199) + credit (HY OAS).
async function marketRead() {
  const vr = await safe<{ date: string; r: number }>(sql`
    SELECT v.date::text AS date, (v.value / NULLIF(m.value, 0))::float8 AS r FROM watchlist_sync.macro_daily v
    JOIN watchlist_sync.macro_daily m ON m.series = 'vix3m' AND m.date = v.date WHERE v.series = 'vix' ORDER BY v.date DESC LIMIT 30`);
  const hy = await safe<{ v: number }>(sql`SELECT value::float8 AS v FROM watchlist_sync.macro_daily WHERE series = 'hy_oas' ORDER BY date DESC LIMIT 6`);
  let streak = 0; while (streak < vr.length && vr[streak].r >= 1) streak++;
  const justUninverted = vr.length > 2 && vr[0].r < 1 && vr[1].r >= 1 && vr[2].r >= 1;
  const hy5 = hy.length >= 6 ? hy[0].v - hy[5].v : null;
  const read = justUninverted
    ? "Fear curve just un-inverted — the tested time to sell puts: +0.50 % vs +0.25 % on calm days, names that did not just crash +0.58 % vs +0.27 % (S197b, 2009→)."
    : streak > 0
      ? `Fear curve inverted ${streak} day${streak > 1 ? "s" : ""} (VIX ÷ VIX3M ${vr[0].r.toFixed(2)}): puts sold now earn no more than on calm days (+0.24 % vs +0.25 %, S197b) — the better entry is the first close back below 1.`
      : "Fear curve calm: ordinary put returns (S197b baseline).";
  const credit = hy5 == null ? "" : hy5 >= 0.2 ? ` Junk-bond spread +${hy5.toFixed(2)} in 5 sessions (${hy[0].v.toFixed(2)} %) — credit is widening.` : "";
  return { fear: vr[0]?.r ?? null, invertedDays: streak, justUninverted, hy: hy[0]?.v ?? null, hy5, read: read + credit };
}
type SkewRank = { rr25: number; asOf: string; dte: number; ownPct: number | null; ownN: number; ownMedian: number | null;
  sector: string | null; sectorPct: number | null; sectorN: number; sectorMedian: number | null; universePct: number | null };
async function skewRanks(tickers: string[]): Promise<Map<string, SkewRank>> {
  const m = new Map<string, SkewRank>();
  if (!tickers.length) return m;
  const rows = await safe<SkewRank & { ticker: string }>(sql`
    WITH d AS (SELECT MAX(as_of) AS a FROM watchlist_sync.rr_skew_daily),
    last AS (SELECT DISTINCT ON (ticker) ticker, as_of, rr25, dte FROM watchlist_sync.rr_skew_daily, d
             WHERE as_of >= d.a - 4 AND rr25 IS NOT NULL ORDER BY ticker, as_of DESC),
    -- GICS industry (TSM vs semis, SNDK vs storage); under 5 peers today → GICS sector
    g AS (SELECT l.*, c.gics_industry AS ind, c.gics_sector AS gsec FROM last l LEFT JOIN research_common.security_class c USING (ticker)),
    gn AS (SELECT g.*, COUNT(*) OVER (PARTITION BY ind) AS ind_n FROM g),
    sec AS (SELECT ticker, as_of, rr25, dte, CASE WHEN ind IS NOT NULL AND ind_n >= 5 THEN ind ELSE gsec END AS sector FROM gn),
    xs AS (SELECT ticker, sector, PERCENT_RANK() OVER (ORDER BY rr25) AS upct,
             CASE WHEN sector IS NULL THEN NULL ELSE PERCENT_RANK() OVER (PARTITION BY sector ORDER BY rr25) END AS spct,
             COUNT(*) OVER (PARTITION BY sector) AS sn FROM sec),
    sm AS (SELECT sector, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rr25) AS smed FROM sec WHERE sector IS NOT NULL GROUP BY sector),
    own AS (SELECT h.ticker, COUNT(*) AS n, AVG((h.rr25 <= l.rr25)::int)::float8 AS pct,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.rr25) AS med
            FROM watchlist_sync.rr_skew_daily h JOIN last l USING (ticker)
            WHERE h.as_of >= l.as_of - 60 AND h.as_of < l.as_of AND h.rr25 IS NOT NULL GROUP BY h.ticker)
    SELECT s.ticker, s.rr25::float8 AS "rr25", s.as_of::text AS "asOf", s.dte AS "dte",
           o.pct AS "ownPct", COALESCE(o.n, 0)::int AS "ownN", o.med::float8 AS "ownMedian",
           s.sector, x.spct::float8 AS "sectorPct", x.sn::int AS "sectorN", sm.smed::float8 AS "sectorMedian", x.upct::float8 AS "universePct"
    FROM sec s JOIN xs x USING (ticker) LEFT JOIN sm ON sm.sector = s.sector LEFT JOIN own o USING (ticker)
    WHERE s.ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})`);
  for (const r of rows) {
    // n floors: own pct needs ≥ 10 prior days, sector pct ≥ 5 peers — else null (shown as "—", never a guess)
    m.set(r.ticker, { ...r, ownPct: r.ownN >= 10 ? r.ownPct : null, ownMedian: r.ownN >= 10 ? r.ownMedian : null,
      sectorPct: r.sectorN >= 5 ? r.sectorPct : null, sectorMedian: r.sectorN >= 5 ? r.sectorMedian : null });
  }
  return m;
}

// Cold start (8 restarts on 11-18 → p50 18.7 s): serve the last saved answer (≤ 24 h) and recompute behind.
async function rrSaved(): Promise<unknown | null> {
  const r = await safe<{ payload: unknown }>(sql`SELECT payload FROM watchlist_sync.rr_answer
    WHERE id = 1 AND saved_at > now() - interval '24 hours'`);
  return r[0]?.payload ?? null;
}
async function riskReversalsSaved() {
  const v = await riskReversals();
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_sync.rr_answer (id int PRIMARY KEY, saved_at timestamptz NOT NULL, payload jsonb NOT NULL)`).catch(() => undefined);
  await db.execute(sql`INSERT INTO watchlist_sync.rr_answer (id, saved_at, payload) VALUES (1, now(), ${JSON.stringify(v)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET saved_at = now(), payload = EXCLUDED.payload`).catch(() => undefined);
  return v;
}
// Jamie 11-20 "Today too slow": the in-memory lastGood lived 90 min, so the first open after a quiet stretch waited for a
// full recompute (p90 18.7 s, 09:30 open 24.6 s). Now: fresh cache → else the last saved answer (≤ 24 h, every compute
// writes it) right away + recompute behind → only a never-computed day waits. Market hours: refresh every 15 min so the
// saved answer is never older than one cycle.
router.get("/today/risk-reversals", requireAdmin, async (_req, res, next) => {
  try {
    const hit = rrCache.get("all");
    if (hit !== undefined) { res.json(hit); return; }
    const saved = await rrSaved().catch(() => null);
    if (saved) {
      void rrCache.getOrCompute("all", riskReversalsSaved).catch(() => undefined);
      res.json({ ...(saved as object), stale: true });
      return;
    }
    res.json(await rrCache.getOrCompute("all", riskReversalsSaved));
  } catch (err) {
    next(err);
  }
});
setInterval(() => {
  if (isMarketOpen()) void rrCache.getOrCompute("all", riskReversalsSaved).catch(() => undefined);   // ~45 ladder calls / 15 min
}, 15 * 60 * 1000).unref();

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
