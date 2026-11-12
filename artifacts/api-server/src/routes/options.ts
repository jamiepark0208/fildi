import { Router } from "express";
import { getOptionsChain, getOptionPositionQuote, getIvTermStructure, withFreshDte, type OptionsChainResult, type IvTermPoint } from "../lib/options.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { readLatestOptionRankings, computeAndPersistOptionScores, readStructuresBoard } from "../lib/option-score-snapshots.js";
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
  try {
    const result = await getOptionPositionQuote(
      ticker.toUpperCase(),
      expiry,
      Number(strike),
      type as "call" | "put",
    );
    return res.json(result);
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
    const result = priceStructure(legs as Leg[], { spot, chains: snap.chains }, horizon);
    return res.json({ ticker: ticker.toUpperCase(), spot, asOf: snap.fetchedAt, ...result });
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
  const built = buildTemplate(templateId as TemplateId, { chains: snap.chains, horizonDays: horizon });
  if (!built?.legs.length) {
    return res.status(404).json({ error: "template could not be built from stored chain" });
  }
  try {
    const spot = snap.chains[0].spot;
    const result = priceStructure(built.legs, { spot, chains: snap.chains }, horizon);
    return res.json({
      ticker: ticker.toUpperCase(),
      templateId,
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
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
