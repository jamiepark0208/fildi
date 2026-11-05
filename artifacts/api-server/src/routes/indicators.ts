import { Router } from "express";
import { db, indicatorScorecard } from "@workspace/db";
import { INDICATORS } from "@workspace/indicators";
import { TTLCache } from "../lib/ttl-cache.js";
import { shapeScorecard, type IndMeta, type ScorecardIndicator } from "../lib/indicator-scorecard-api.js";
import { getIndicators, getIndicatorsBatch } from "../lib/indicators.js";
import { getUserWatchlistTickers, isTickerOnUserWatchlist } from "../lib/watchlist-tickers.js";

const router = Router();

const scorecardCache = new TTLCache<ScorecardIndicator[]>(10 * 60 * 1000, "indicator-scorecard", 2);

// GET /api/indicators/scorecard — graded track record per indicator (DB read only; must precede /:ticker)
router.get("/indicators/scorecard", async (_req, res, next) => {
  try {
    const data = await scorecardCache.getOrCompute("all", async () => {
      const rows = await db.select().from(indicatorScorecard);
      const metas: IndMeta[] = INDICATORS.map((d) => ({
        id: d.id, label: d.label, version: d.version, title: d.title,
        source: { url: d.source.url, author: d.source.author }, timeframes: d.timeframes,
      }));
      return shapeScorecard(rows, metas);
    });
    res.json({ indicators: data });
  } catch (err) { next(err); }
});

// GET /api/indicators/:ticker
// ?refresh=true  forces recompute for this ticker only, overwrites indicator_cache
router.get("/indicators/:ticker", async (req, res) => {
  const ticker  = req.params.ticker.toUpperCase();
  const refresh = req.query.refresh === "true";
  if (!(await isTickerOnUserWatchlist(req.session.userId!, ticker))) {
    return res.status(404).json({ error: `Unknown ticker: ${ticker}` });
  }
  try {
    const result = await getIndicators(ticker, refresh);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/indicators/batch
// ?tickers=NVDA,AAPL  (omit = caller's full watchlist)
// ?refresh=true        re-fetches only the tickers listed (or all if none listed)
router.get("/indicators/batch", async (req, res) => {
  const raw     = typeof req.query.tickers === "string" ? req.query.tickers : "";
  const refresh = req.query.refresh === "true";
  const tickers = raw
    ? raw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    : await getUserWatchlistTickers(req.session.userId!);

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
