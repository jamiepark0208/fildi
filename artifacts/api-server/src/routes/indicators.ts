import { Router } from "express";
import { getIndicators, getIndicatorsBatch } from "../lib/indicators.js";
import { WATCHLIST } from "../lib/constants.js";

const router = Router();

// GET /api/indicators/:ticker
// ?refresh=true  forces recompute for this ticker only, overwrites scorecard_cache
router.get("/api/indicators/:ticker", async (req, res) => {
  const ticker  = req.params.ticker.toUpperCase();
  const refresh = req.query.refresh === "true";
  try {
    const result = await getIndicators(ticker, refresh);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/indicators/batch
// ?tickers=NVDA,AAPL  (omit = all 31)
// ?refresh=true        re-fetches only the tickers listed (or all if none listed)
router.get("/api/indicators/batch", async (req, res) => {
  const raw     = typeof req.query.tickers === "string" ? req.query.tickers : "";
  const refresh = req.query.refresh === "true";
  const tickers = raw
    ? raw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    : WATCHLIST;

  if (tickers.some(t => t.length === 0 || t.length > 10)) {
    return res.status(400).json({ error: "Invalid tickers param" });
  }

  try {
    const results = await getIndicatorsBatch(tickers, refresh);
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
