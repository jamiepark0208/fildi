import { Router } from "express";
import { getOptionsChain, getOptionPositionQuote, getIvTermStructure, withFreshDte, type OptionsChainResult, type IvTermPoint } from "../lib/options.js";
import { buildPositionQuote } from "../lib/options-position-quote.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { readLatestOptionRankings, computeAndPersistOptionScores, readStructuresBoard, readIdeaStructures } from "../lib/option-score-snapshots.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { readStructureBacktest } from "../lib/structure-backtest.js";
import { getAllTechnicalsRows } from "../lib/technicals-db.js";
import { getLivePrices } from "../lib/live-quote.js";
import { rankingsWantLivePrices } from "../lib/rankings-live-prices.js";
import { assessOptionChainQuoteDq, selectPremiumCandidates } from "@workspace/option-scoring";
import { getOptionsChainSourceStats } from "../lib/options-chain-source-stats.js";
import { chainIsFresh, chainUniverse, engineExpiry, inMarketHours, readChainSnapshot, saveChainSnapshot, staleChainTickers } from "../lib/options-chain-store.js";
import { type Leg, priceStructure } from "../lib/structures/legs.js";
import { rankStructuresForView, type MarketView } from "../lib/structures/rank.js";
import { rankerChains } from "../lib/structures/ranker-chain.js";
import { buildTemplate, type TemplateId } from "../lib/structures/templates.js";
import { getSchwabChainForExpiry } from "../lib/schwab-client.js";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { betaVsSpy, type Pt } from "../lib/book-risk.js";
import { cleanQuoteReqs, quoteFromChains, type LegQuote, type QuoteReq } from "../lib/structures/ticket-quotes.js";

const router = Router();

export const optionsCache = new TTLCache<OptionsChainResult[]>(30 * 60 * 1000, 'options', 1000); // key = ticker
export const ivTermCache = new TTLCache<IvTermPoint[]>(60 * 60 * 1000, 'options-iv-term', 500); // key = ticker

// GET /api/options/position-quote?ticker=NVDA&expiry=2026-06-20&strike=850&type=call
// MUST be declared before /options/:ticker so it isn't captured by the wildcard
router.get("/options/position-quote", async (req, res) => {
  const { ticker, expiry, strike, type } = req.query;
  if (
    typeof ticker !== "string" || !/^[A-Z0-9._-]{1,15}$/i.test(ticker) ||
    typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
    typeof strike !== "string" || isNaN(Number(strike)) ||
    (type !== "call" && type !== "put")
  ) {
    return res.status(400).json({ error: "Invalid parameters" });
  }
  const T = ticker.toUpperCase(), K = Number(strike), kind = type as "call" | "put";
  // Yahoo first (6 s); fails / no contract → stored chain + Schwab (same path as the trade ticket).
  const yahoo = await withDeadline(getOptionPositionQuote(T, expiry, K, kind).catch(() => null), 6000);
  if (yahoo && (yahoo.bid != null || yahoo.ask != null || yahoo.lastPrice != null)) return res.json(yahoo);
  try {
    const chains = await legChains(T, [expiry]);
    const q = quoteFromChains(chains, { ticker: T, kind, strike: K, expiry }, null);
    if (!q.quoted) return res.status(404).json({ error: q.reason ?? "no quote" });
    const mid = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : (q.bid ?? q.ask);
    return res.json(buildPositionQuote(T, expiry, K, kind, { bid: q.bid, ask: q.ask, lastPrice: null, midPrice: mid, iv: q.iv, spot: q.spot ?? 0 }));
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

/** Vendor fetch → memory + DB snapshot. getOrCompute: concurrent callers share one upstream fetch. */
function refreshChain(ticker: string): Promise<OptionsChainResult[]> {
  return optionsCache.getOrCompute(ticker, async () => {
    const chains = await getOptionsChain(ticker);
    // The engine's expiry can fall outside the 2 nearest (Mon expiry, same-day listing) → the ladder re-picked a strike (10-28).
    const exp = await engineExpiry(ticker).catch(() => null);
    if (exp && !chains.some((c) => c.expiry === exp)) {
      const extra = await getSchwabChainForExpiry(ticker, exp);
      if (extra) chains.push(extra);
    }
    void saveChainSnapshot(ticker, chains);
    return chains;
  });
}

const bgRefreshAt = new Map<string, number>();

/** Memory → saved DB snapshot (stale ones refresh in the background) → vendor only when nothing is saved (10-28). */
async function fetchOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  const mem = optionsCache.get(ticker);
  if (mem) return withFreshDte(mem);
  const snap = await readChainSnapshot(ticker).catch(() => null);
  if (snap) {
    // stale → answer with the saved chain flagged `stale`, refresh behind it; the page re-asks and gets the fresh one
    if (!chainIsFresh(snap.fetchedAt)) {
      // 11-11: after hours a thin / failing name stays stale forever → every page re-ask was another vendor call
      const cool = inMarketHours() ? 5 * 60_000 : 60 * 60_000;
      if (Date.now() - (bgRefreshAt.get(ticker) ?? 0) > cool) {
        bgRefreshAt.set(ticker, Date.now());
        refreshChain(ticker).catch((err) => logger.warn({ ticker, err: String(err) }, "options: background chain refresh failed"));
      }
      return withFreshDte(snap.chains).map((c) => ({ ...c, stale: true }));
    }
    optionsCache.set(ticker, snap.chains);
    return withFreshDte(snap.chains);
  }
  return withFreshDte(await refreshChain(ticker));
}

/** Background chain warmer (10-28): one vendor call at a time (~4/min vs Schwab's 100/min), stale names only.
 *  A ticker whose chain fails is skipped for 2 h (no options / thin name) so it isn't retried every cycle. */
const warmFailedAt = new Map<string, number>();
let warming: Promise<void> | null = null;
function warmChains(tickers: string[]): Promise<void> {
  warming ??= (async () => {
    const queue = (await staleChainTickers(tickers)).filter((t) => Date.now() - (warmFailedAt.get(t) ?? 0) > 2 * 3_600_000);
    for (const t of queue) {
      await refreshChain(t).then(() => warmFailedAt.delete(t), () => { warmFailedAt.set(t, Date.now()); });
    }
  })().finally(() => { warming = null; });
  return warming;
}

/** Rankings tab opened → warm its top 40 now (at most every 10 min). */
let lastRankWarmAt = 0;
async function warmRankedChains(tickers: string[]): Promise<void> {
  if (Date.now() - lastRankWarmAt < 10 * 60_000) return;
  lastRankWarmAt = Date.now();
  await warmChains(tickers.slice(0, 40));
}

/** Every 10 min in market hours: watchlist + picks + Model List + top 40 put / 20 call ranks. Started by the first
 *  /options request so scripts that import this module never schedule vendor calls. unref → never holds a process open. */
let warmerStarted = false;
function startChainWarmer(): void {
  if (warmerStarted || process.env.NODE_ENV === "test" || process.env.DISABLE_CHAIN_WARMER === "1") return;
  warmerStarted = true;
  const tick = async () => {
    if (!inMarketHours()) return;
    const [uni, puts, calls] = await Promise.all([chainUniverse(), readLatestOptionRankings("put"), readLatestOptionRankings("call")]);
    await warmChains([...new Set([...puts.rows.slice(0, 40).map((r) => r.ticker), ...calls.rows.slice(0, 20).map((r) => r.ticker), ...uni])]);
  };
  const run = () => { tick().catch((err) => logger.warn({ err: String(err) }, "options: chain warmer tick failed")); };
  setTimeout(run, 5_000).unref();
  setInterval(run, 10 * 60_000).unref();
}
router.use("/options", (_req, _res, next) => { startChainWarmer(); next(); });

// GET /api/options/candidates — premium-IV universe for Overall (same filter as nightly job).
// Declared before /options/:ticker so "candidates" is not captured as a ticker.
router.get("/options/candidates", async (req, res) => {
  const limitRaw = parseInt(String(req.query.limit ?? "200"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(300, Math.max(20, limitRaw)) : 200;
  try {
    const rows = await getAllTechnicalsRows();
    const tickers = selectPremiumCandidates(
      rows.map((r) => ({
        ticker: r.ticker,
        atmPutIv: r.atmPutIv,
        ivVsRealizedVol: r.ivVsRealizedVol,
        technicalsCoverage: r.technicalsCoverage,
      })),
      limit,
    );
    return res.json({ tickers, count: tickers.length, limit });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/options/rankings?side=put|call[&livePrices=1]
// Overall board from nightly snapshots (DB). Default = DB only (A252) — no Schwab/Yahoo
// fan-out on every load. Opt in with livePrices=1; UI day-% uses GET /live/prices instead.
router.get("/options/rankings", async (req, res) => {
  const sideRaw = String(req.query.side ?? "put").toLowerCase();
  const side = sideRaw === "call" ? "call" : "put";
  const wantPrices = rankingsWantLivePrices(req.query.livePrices);
  try {
    const { rows, asOf, computedAt } = await readLatestOptionRankings(side);
    const prices: Record<string, { price: number | null; changePercent: number | null }> = {};
    if (wantPrices && rows.length > 0) {
      const live = await getLivePrices(rows.map((r) => r.ticker));
      for (const r of rows) {
        const q = live.get(r.ticker);
        prices[r.ticker] = { price: q?.price ?? null, changePercent: q?.changePercent ?? null };
      }
    }
    void warmRankedChains(rows.map((r) => r.ticker)).catch((err) => logger.warn({ err: String(err) }, "options: chain warm failed"));
    return res.json({ side, asOf, computedAt, rankings: rows, prices });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/options/structures — A192 Strategies board (nightly table; ≤ 5 names per structure, each ticker once).
router.get("/options/structures", async (_req, res) => {
  return res.json(await readStructuresBoard());
});

// GET /api/options/structures/idea/:ticker — A192 V3: every structure for one idea on one shared scenario set (3 lenses + baselines).
router.get("/options/structures/idea/:ticker", async (req, res) => {
  const out = await readIdeaStructures(String(req.params.ticker ?? ""));
  return out ? res.json(out) : res.status(404).json({ error: "no structure context for this ticker today" });
});

// GET /api/options/structures/backtest — S076: every structure backtested (summary, eras, regimes, equity, histogram, payoff template).
router.get("/options/structures/backtest", async (_req, res) => {
  return res.json(await readStructureBacktest());
});

// POST /api/options/structures/price — A192 Part L: price arbitrary legs from stored chain
router.post("/options/structures/price", async (req, res) => {
  const { ticker, legs, horizonDays } = req.body ?? {};
  if (typeof ticker !== "string" || !/^[A-Z]{1,10}$/i.test(ticker)) {
    return res.status(400).json({ error: "ticker required" });
  }
  if (!Array.isArray(legs) || legs.length === 0) {
    return res.status(400).json({ error: "legs required" });
  }
  const snap = await readChainSnapshot(ticker.toUpperCase()).catch(() => null);
  if (!snap?.chains?.length) {
    return res.status(404).json({ error: "no stored chain — refresh chain first" });
  }
  const spot = snap.chains[0].spot;
  const horizon = typeof horizonDays === "number" ? horizonDays : 30;
  try {
    // A205 unit 2: same chain fill as the Ranker (stored chain + cached ATM/back-month ladder) so ATM/ITM legs get quotes.
    const { chains, filled } = await rankerChains(ticker.toUpperCase(), snap.chains, horizon);
    const px = chains[0]?.spot ?? spot;
    const result = priceStructure(legs as Leg[], { spot: px, chains }, horizon);
    return res.json({ ticker: ticker.toUpperCase(), spot: px, asOf: snap.fetchedAt, ladderFilled: filled, ...result });
  } catch (err: unknown) {
    return res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

// POST /api/options/structures/template — A192 Part C: build template + price at fill
router.post("/options/structures/template", async (req, res) => {
  const { ticker, templateId, horizonDays } = req.body ?? {};
  if (typeof ticker !== "string" || !/^[A-Z]{1,10}$/i.test(ticker)) {
    return res.status(400).json({ error: "ticker required" });
  }
  if (typeof templateId !== "string") {
    return res.status(400).json({ error: "templateId required" });
  }
  const snap = await readChainSnapshot(ticker.toUpperCase()).catch(() => null);
  if (!snap?.chains?.length) {
    return res.status(404).json({ error: "no stored chain — refresh chain first" });
  }
  const horizon = typeof horizonDays === "number" ? horizonDays : 45;
  const { chains, filled } = await rankerChains(ticker.toUpperCase(), snap.chains, horizon);   // A205 unit 2
  const built = buildTemplate(templateId as TemplateId, { chains, horizonDays: horizon });
  if (!built?.legs.length) {
    return res.status(404).json({ error: "template could not be built from stored chain" });
  }
  try {
    const spot = chains[0]?.spot ?? snap.chains[0].spot;
    const result = priceStructure(built.legs, { spot, chains }, horizon);
    return res.json({
      ticker: ticker.toUpperCase(),
      templateId,
      ladderFilled: filled,
      legs: built.legs,
      noCredit: built.noCredit ?? false,
      spot,
      ...result,
    });
  } catch (err: unknown) {
    return res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

// POST /api/options/rankings/refresh — admin: recompute Overall snapshots now
router.post("/options/rankings/refresh", requireAdmin, async (req, res) => {
  try {
    const limit = typeof req.body?.limit === "number" ? req.body.limit : undefined;
    const result = await computeAndPersistOptionScores({ limit });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/options/batch?tickers=A,B,C — batched chain fetch, per-ticker optionsCache reuse.
// Caps concurrent Yahoo calls so a large watchlist doesn't fan out N simultaneous requests.
// MUST be declared before /options/:ticker so it isn't captured by the wildcard
/** Cap in-flight chain fetches. Cache hits skip Schwab throttle — higher concurrency helps. */
const OPTIONS_BATCH_CONCURRENCY = 8;

router.get("/options/batch", async (req, res) => {
  const { tickers } = req.query as { tickers?: string };
  if (!tickers || typeof tickers !== "string") {
    return res.status(400).json({ error: "tickers is required" });
  }
  const allKeys = [...new Set(tickers.split(",").map(t => t.trim().toUpperCase()).filter(Boolean))];
  if (allKeys.length === 0) {
    return res.status(400).json({ error: "tickers is required" });
  }

  // A malformed ticker (e.g. an index symbol like ^SPY, which the watchlist-add
  // endpoint accepts but which has no options chain) must not 400 the whole batch —
  // that would blank out every other valid ticker for a user who has one bad entry.
  const results: Record<string, OptionsChainResult[] | { error: string }> = {};
  const valid = allKeys.filter(k => {
    if (/^[A-Z]{1,10}$/.test(k)) return true;
    results[k] = { error: "Invalid ticker format" };
    return false;
  });
  // Serve cache hits first so progressive clients populate the table quickly.
  const keys = [
    ...valid.filter((k) => optionsCache.get(k)),
    ...valid.filter((k) => !optionsCache.get(k)),
  ];

  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try {
        results[key] = await fetchOptionsChain(key);
      } catch (err: any) {
        results[key] = { error: String(err?.message ?? err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(OPTIONS_BATCH_CONCURRENCY, keys.length) }, worker));

  return res.json(results);
});

/**
 * GET /api/options/quote-dq?tickers=A,B&side=put
 * Probe live chains and return bid data-quality (source + live-bid coverage).
 * "No live bid" = vendor returned bid=0 — not a trading preference.
 */
router.get("/options/quote-dq", async (req, res) => {
  const sideRaw = String(req.query.side ?? "put").toLowerCase();
  const isCall = sideRaw === "call";
  const raw = typeof req.query.tickers === "string" ? req.query.tickers : "";
  const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z]{1,10}$/.test(t)))].slice(0, 40);
  if (tickers.length === 0) {
    return res.status(400).json({ error: "tickers required" });
  }

  const processStats = getOptionsChainSourceStats();
  const rows: Array<{
    ticker: string;
    ok: boolean;
    error?: string;
    dq?: ReturnType<typeof assessOptionChainQuoteDq>;
  }> = [];

  // Sequential — each chain already budgets upstream; keep fan-out small for DQ probes.
  for (const ticker of tickers) {
    try {
      const chains = await fetchOptionsChain(ticker);
      const dq = assessOptionChainQuoteDq(chains, isCall);
      rows.push({ ticker, ok: !dq.degraded || dq.code === "yahoo_fallback", dq });
    } catch (err: unknown) {
      rows.push({ ticker, ok: false, error: String((err as Error)?.message ?? err) });
    }
  }

  const fail = rows.filter((r) => r.dq?.code === "zero_bids_schwab" || r.dq?.code === "zero_bids_yahoo" || r.error);
  return res.json({
    side: isCall ? "call" : "put",
    processStats,
    probed: rows.length,
    failCount: fail.length,
    rows,
  });
});

// GET /api/options/betas?tickers=NVDA,HOOD — 120-d beta vs SPY per ticker (trade ticket beta-weighted payoff).
// One query for all names; 6 h cache per ticker (daily bars). No history → beta null (UI uses 1).
const betaCache = new TTLCache<number | null>(6 * 60 * 60 * 1000, 'options-beta', 2000);
router.get("/options/betas", async (req, res) => {
  const want = [...new Set(String(req.query.tickers ?? "").toUpperCase().split(",").map((t) => t.trim())
    .filter((t) => /^[A-Z.]{1,10}$/.test(t)))].slice(0, 40);
  const out: Record<string, number | null> = {};
  const miss = want.filter((t) => { const v = betaCache.get(t); if (v !== undefined) out[t] = v; return v === undefined; });
  if (miss.length) {
    try {
      const names = sql.join([...miss, "SPY"].map((t) => sql`${t}`), sql`, `);
      const r = await db.execute(sql`SELECT ticker, date::text AS date, close::float8 AS close FROM (
          SELECT ticker, date, close, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
          FROM public.prices_historical WHERE ticker IN (${names})) x
        WHERE rn <= 140 ORDER BY ticker, date`);
      const rows = (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as { ticker: string; date: string; close: number }[];
      const by = new Map<string, Pt[]>();
      for (const x of rows) (by.get(x.ticker) ?? by.set(x.ticker, []).get(x.ticker)!).push({ date: x.date, close: x.close });
      const spy = by.get("SPY") ?? [];
      for (const t of miss) {
        const b = t === "SPY" ? 1 : betaVsSpy(by.get(t) ?? [], spy);
        betaCache.set(t, b);
        out[t] = b;
      }
    } catch (err) {
      logger.warn({ err }, "options/betas query failed");
      for (const t of miss) out[t] = null;
    }
  }
  res.json({ betas: out, window: "120d vs SPY", marketVol: await spyRealizedVol() });
});

// SPY 20-d realized vol (annualised) — market σ for the ticket's chance-of-profit model. 6 h cache.
async function spyRealizedVol(): Promise<number | null> {
  const hit = betaCache.get("__SPY_RV20");
  if (hit !== undefined) return hit;
  try {
    const r = await db.execute(sql`SELECT close::float8 AS close FROM public.prices_historical
      WHERE ticker = 'SPY' ORDER BY date DESC LIMIT 21`);
    const c = ((Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as { close: number }[]).map((x) => x.close).reverse();
    const rets = c.slice(1).map((v, i) => Math.log(v / c[i])).filter(Number.isFinite);
    const m = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
    const v = rets.length >= 15 ? Math.sqrt((rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) * 252) : null;
    betaCache.set("__SPY_RV20", v);
    return v;
  } catch { return null; }
}

const withDeadline = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/** Chains covering these expiries: stored chain + Schwab ladder, then one per-expiry Schwab fetch (8 s) per missing expiry (≤ 4). */
async function legChains(t: string, expiries: string[]): Promise<OptionsChainResult[]> {
  const maxDte = Math.max(30, ...expiries.map((e) => (Date.parse(e) - Date.now()) / 86_400_000));
  let chains: OptionsChainResult[] = [];
  try {
    const snap = await readChainSnapshot(t).catch(() => null);
    const base = snap?.chains?.length ? snap.chains : await fetchOptionsChain(t).catch(() => []);
    chains = (await rankerChains(t, base, Math.ceil(maxDte))).chains;
  } catch (err) {
    logger.warn({ t, err: String(err) }, "legChains: chain load failed");
  }
  const missing = [...new Set(expiries.filter((e) => !chains.some((c) => c.expiry === e)))];
  for (const ex of missing.slice(0, 4)) {
    const c = await withDeadline(getSchwabChainForExpiry(t, ex).catch(() => null), 8000);
    if (c) chains = [...chains, c];
  }
  return chains;
}

// POST /api/options/ticket-quotes {legs:[{ticker,kind,strike,expiry}]} — live bid/ask/IV/spot per trade-ticket leg.
// Same chains as /options/structures/price (stored chain + Schwab ladder); an expiry outside them → one
// per-expiry Schwab fetch (8 s deadline). ≤ 40 legs, ≤ 12 names, 3 names at a time.
router.post("/options/ticket-quotes", async (req, res) => {
  const reqs = cleanQuoteReqs(req.body?.legs);
  if (!reqs.length) return res.status(400).json({ error: "legs required" });
  const byTicker = new Map<string, QuoteReq[]>();
  for (const q of reqs) (byTicker.get(q.ticker) ?? byTicker.set(q.ticker, []).get(q.ticker)!).push(q);
  const names = [...byTicker.keys()].slice(0, 12);
  const quotes: (LegQuote & QuoteReq)[] = [];
  // One spot per name for every leg (live quote, else the chain's) so shares and options share an axis.
  const live = (await withDeadline(getLivePrices(names).catch(() => null), 5000)) ?? new Map();
  const one = async (t: string) => {
    const legsT = byTicker.get(t)!;
    const livePx = live.get(t)?.price ?? null;
    if (legsT.every((l) => l.kind === "stock")) {   // shares only → no chain call
      for (const q of legsT) quotes.push({ ...q, ...quoteFromChains([], q, livePx) });
      return;
    }
    const chains = await legChains(t, legsT.filter((l) => l.expiry).map((l) => l.expiry!));
    const spot = chains.find((c) => c.spot > 0)?.spot ?? null;
    for (const q of legsT) quotes.push({ ...q, ...quoteFromChains(chains, q, livePx ?? spot) });
  };
  for (let i = 0; i < names.length; i += 3) await Promise.all(names.slice(i, i + 3).map(one));
  for (const t of [...byTicker.keys()].slice(12)) {
    for (const q of byTicker.get(t)!) quotes.push({ ...q, bid: null, ask: null, iv: null, spot: null, quoted: false, reason: "over 12 names" });
  }
  return res.json({ asOf: Date.now(), quotes });
});

const MARKET_VIEWS = new Set(["bull", "bear", "neutral", "vol_up", "vol_down"]);

// GET /api/options/:ticker/structures/rank — A192 Part L view ranker (stored chain only)
router.get("/options/:ticker/structures/rank", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }
  const viewRaw = String(req.query.view ?? "neutral").toLowerCase();
  const view = (MARKET_VIEWS.has(viewRaw) ? viewRaw : "neutral") as MarketView;
  const horizon = Math.min(180, Math.max(1, parseInt(String(req.query.horizon ?? "30"), 10) || 30));
  const maxLoss = Math.max(100, parseFloat(String(req.query.maxLoss ?? "1000")) || 1000);
  const snap = await readChainSnapshot(ticker).catch(() => null);
  if (!snap?.chains?.length) {
    return res.status(404).json({ error: "no stored chain" });
  }
  try {
    const { chains, filled } = await rankerChains(ticker, snap.chains, horizon);   // A205: + ATM / back-month ladder
    const ranked = await rankStructuresForView({
      ticker,
      chains,
      view,
      horizonDays: horizon,
      maxLoss,
    });
    return res.json({ ...ranked, asOf: snap.fetchedAt, spot: chains[0]?.spot ?? snap.chains[0].spot, ladderFilled: filled });
  } catch (err: unknown) {
    return res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

// GET /api/options/:ticker/term-structure — ATM IV across the expiry calendar (1W/1M/2M/3M/6M/1Y)
// Extra path segment means this never collides with the /options/:ticker wildcard below.
router.get("/options/:ticker/term-structure", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }
  try {
    return res.json(await ivTermCache.getOrCompute(ticker, () => getIvTermStructure(ticker)));
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/options/:ticker  — full chain scan
router.get("/options/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: "Invalid ticker" });
  }
  try {
    const result = await fetchOptionsChain(ticker);
    return res.json(result);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // No listed expiries (e.g. LICN) = an empty chain, not a fault (callers show "no usable chain"; no console 4xx).
    if (/^No viable expiry/.test(msg)) return res.json([]);
    return res.status(500).json({ error: msg });
  }
});

export default router;
