import { Router } from "express";
import { getOptionsChain, getOptionPositionQuote, getIvTermStructure, withFreshDte, type OptionsChainResult, type IvTermPoint } from "../lib/options.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { readLatestOptionRankings, computeAndPersistOptionScores } from "../lib/option-score-snapshots.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getAllTechnicalsRows } from "../lib/technicals-db.js";
import { selectPremiumCandidates } from "@workspace/option-scoring";

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

async function fetchOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  // getOrCompute: concurrent requests for the same ticker share one upstream chain fetch.
  return withFreshDte(await optionsCache.getOrCompute(ticker, () => getOptionsChain(ticker)));
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

// GET /api/options/rankings?side=put|call — Overall board from nightly snapshots
router.get("/options/rankings", async (req, res) => {
  const sideRaw = String(req.query.side ?? "put").toLowerCase();
  const side = sideRaw === "call" ? "call" : "put";
  try {
    const { rows, asOf, computedAt } = await readLatestOptionRankings(side);
    return res.json({ side, asOf, computedAt, rankings: rows });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
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
