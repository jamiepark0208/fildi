import { Router } from "express";
import { getOptionsChain, getOptionPositionQuote, getIvTermStructure, withFreshDte, type OptionsChainResult, type IvTermPoint } from "../lib/options.js";
import { TTLCache } from "../lib/ttl-cache.js";

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
  const cached = optionsCache.get(ticker);
  if (cached) return withFreshDte(cached);
  const result = await getOptionsChain(ticker);
  optionsCache.set(ticker, result);
  return withFreshDte(result);
}

// GET /api/options/batch?tickers=A,B,C — batched chain fetch, per-ticker optionsCache reuse.
// Caps concurrent Yahoo calls so a large watchlist doesn't fan out N simultaneous requests.
// MUST be declared before /options/:ticker so it isn't captured by the wildcard
const OPTIONS_BATCH_CONCURRENCY = 6;

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
  const keys = allKeys.filter(k => {
    if (/^[A-Z]{1,10}$/.test(k)) return true;
    results[k] = { error: "Invalid ticker format" };
    return false;
  });

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
    const cached = ivTermCache.get(ticker);
    if (cached) return res.json(cached);
    const result = await getIvTermStructure(ticker);
    ivTermCache.set(ticker, result);
    return res.json(result);
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
