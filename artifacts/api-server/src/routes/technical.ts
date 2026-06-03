import { Router } from "express";
import { getAllCachedIndicators, getIndicators, getIndicatorsBatch, type IndicatorResult } from "../lib/indicators.js";
import { WATCHLIST } from "../lib/constants.js";

const router = Router();

// GET /api/technical/scorecard
// Returns indicator rows for all watchlist tickers.
// Reads from today's cache where available; computes fresh from stored OHLCV
// for any ticker not yet cached today (no Yahoo Finance calls for warm data).
router.get("/technical/scorecard", async (_req, res) => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const cached = await getAllCachedIndicators();
    const map    = new Map(cached.map(r => [r.ticker, r]));

    // Find tickers missing from today's cache and compute them from stored OHLCV
    const missing = WATCHLIST.filter(t => !map.has(t) || map.get(t)!.scoredDate !== today);
    if (missing.length > 0) {
      const fresh = await getIndicatorsBatch(missing, false);
      for (const [ticker, result] of Object.entries(fresh)) {
        if (!("error" in result)) map.set(ticker, result as IndicatorResult);
      }
    }

    const results: Array<IndicatorResult & { stale: boolean }> = WATCHLIST.map(ticker => {
      const row = map.get(ticker);
      if (row) return { ...row, stale: row.scoredDate !== today };
      return {
        ticker, scoredDate: "", rsi: 0, mfi: 0,
        rsiThreshold: 40, mfiThreshold: 25,
        rsiOk: false, mfiOk: false,
        signal: "NO" as const, tier: 2 as const,
        atr: null, macdCross: null, stoch: null,
        return5d: null, position52w: null, vsSpy20d: null,
        earningsDate: null, rsiYesterday: 0, price: 0,
        ivCurrent: 0, ivPercentile: 50, ma200: null,
        stale: true,
      };
    });

    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// POST /api/technical/refresh/:ticker
// Force-recomputes a single ticker and updates indicator_cache.
router.post("/technical/refresh/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!WATCHLIST.includes(ticker)) {
    return res.status(404).json({ error: `${ticker} not in watchlist` });
  }
  try {
    const result = await getIndicators(ticker, true);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
