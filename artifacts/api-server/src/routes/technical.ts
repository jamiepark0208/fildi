import { Router } from "express";
import { getAllCachedIndicators, getIndicators, type IndicatorResult } from "../lib/indicators.js";
import { WATCHLIST } from "../lib/constants.js";

const router = Router();

// GET /api/technical/scorecard
// Returns today's cached indicator rows for all watchlist tickers.
// Includes a `stale` flag if a ticker has no data for today.
router.get("/technical/scorecard", async (_req, res) => {
  try {
    const cached = await getAllCachedIndicators();
    const cachedMap = new Map(cached.map(r => [r.ticker, r]));
    const today     = new Date().toISOString().slice(0, 10);

    // For any ticker missing today's row, return a lightweight placeholder
    // marked stale so the UI can show a "refresh" prompt instead of an error.
    const results: Array<IndicatorResult & { stale: boolean }> = WATCHLIST.map(ticker => {
      const row = cachedMap.get(ticker);
      if (row) return { ...row, stale: row.scoredDate !== today };
      // No data at all — return a minimal stub so the ticker still appears
      return {
        ticker,
        scoredDate:   "",
        rsi:          0, mfi: 0,
        rsiThreshold: 40, mfiThreshold: 25,
        rsiOk: false, mfiOk: false,
        signal:       "NO" as const,
        tier:         2 as const,
        atr: null, macdCross: null, stoch: null,
        return5d: null, position52w: null, vsSpy20d: null,
        earningsDate: null,
        stale:        true,
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
