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
import { CHAIN_FRESH_MS, readChainSnapshot, saveChainSnapshot, staleChainTickers } from "../lib/options-chain-store.js";
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
    void saveChainSnapshot(ticker, chains);
    return chains;
  });
}

/** Memory → saved DB snapshot (stale ones refresh in the background) → vendor only when nothing is saved (10-28). */
async function fetchOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  const mem = optionsCache.get(ticker);
  if (mem) return withFreshDte(mem);
  const snap = await readChainSnapshot(ticker).catch(() => null);
  if (snap) {
    if (Date.now() - snap.fetchedAt > CHAIN_FRESH_MS) {
      refreshChain(ticker).catch((err) => logger.warn({ ticker, err: String(err) }, "options: background chain refresh failed"));
    } else optionsCache.set(ticker, snap.chains);
    return withFreshDte(snap.chains);
  }
  return withFreshDte(await refreshChain(ticker));
}

/** Rankings tab opened → refresh saved chains for the top names that are stale, 2 at a time, at most every 10 min. */
let lastWarmAt = 0;
async function warmRankedChains(tickers: string[]): Promise<void> {
  if (Date.now() - lastWarmAt < 10 * 60_000) return;
  lastWarmAt = Date.now();
  const queue = await staleChainTickers(tickers.slice(0, 40));
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await refreshChain(t).catch(() => undefined);
  };
  await Promise.all([worker(), worker()]);
}

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
