import { Router } from "express";
import { liveHotlist, rallySignal, MARKET_CONTEXT_SYMBOLS, type HotlistEntry, type HotlistSide } from "../lib/live-hotlist.js";
import { getLivePrices, livePriceCache } from "../lib/live-quote.js";
import { getLiveIndicatorOverlay } from "../lib/indicators.js";
import { fetchGlobalMovers } from "../lib/live-movers.js";
import { getTodaysCheckpoints } from "../lib/intraday-regime.js";
import { getTodaysEntrySignals, computeEntryStats } from "../lib/intraday-entry-signals.js";
import { getPatternDigest } from "../lib/intraday-pattern-digest.js";
import { TTLCache } from "../lib/ttl-cache.js";

const router = Router();

export interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

async function fetchMarketContext(): Promise<MarketContextQuote[]> {
  const live = await getLivePrices(MARKET_CONTEXT_SYMBOLS);
  return MARKET_CONTEXT_SYMBOLS.map(ticker => ({
    ticker,
    price: live.get(ticker)?.price ?? null,
    changePercent: live.get(ticker)?.changePercent ?? null,
  }));
}

/** Overlay live price + intraday-refreshed RSI/MFI/Stoch/MACD/signal onto the daily-derived hot list. */
async function liveHotlistEntries(side: HotlistSide): Promise<HotlistEntry[]> {
  const entries = liveHotlist.getEntries(side);
  if (entries.length === 0) return entries;

  const tickers = entries.map(e => e.ticker);
  const [live, indicatorOverlay] = await Promise.all([
    getLivePrices(tickers),
    getLiveIndicatorOverlay(tickers),
  ]);

  return entries.map(e => {
    const merged = {
      ...e,
      price: live.get(e.ticker)?.price ?? e.price,
      ...indicatorOverlay.get(e.ticker),
    };
    // The overlay's signal is oversold-based; recompute for the rally side from overlaid values.
    if (side === "rally") merged.signal = rallySignal(merged.rsi, merged.mfi);
    return merged;
  });
}

async function snapshot(): Promise<{ hotlist: HotlistEntry[]; rallyHotlist: HotlistEntry[]; marketContext: MarketContextQuote[]; lastRefreshedAt: number | null }> {
  const [hotlist, rallyHotlist, marketContext] = await Promise.all([
    liveHotlistEntries("dip"),
    liveHotlistEntries("rally"),
    fetchMarketContext(),
  ]);
  return { hotlist, rallyHotlist, marketContext, lastRefreshedAt: liveHotlist.getLastRefreshedAt() };
}

// Prototype: no background refresh loop yet (see live-hotlist.ts ENABLE_AUTO_REFRESH).
// This endpoint is button-triggered from the Live tab.
router.get("/live/state", async (_req, res, next) => {
  try {
    if (liveHotlist.getLastRefreshedAt() === null) await liveHotlist.refresh();
    res.json(await snapshot());
  } catch (err) {
    next(err);
  }
});

router.post("/live/refresh", async (_req, res, next) => {
  try {
    await liveHotlist.refresh();
    livePriceCache.clear();
    res.json(await snapshot());
  } catch (err) {
    next(err);
  }
});

router.get("/live/movers", async (_req, res, next) => {
  try {
    res.json({ global: await fetchGlobalMovers() });
  } catch (err) {
    next(err);
  }
});

router.get("/live/regime", async (_req, res, next) => {
  try {
    res.json(await getTodaysCheckpoints());
  } catch (err) {
    next(err);
  }
});

// New graded rows land at most once/session (checkpoint grading is nightly/Saturday),
// so a long TTL avoids recomputing this aggregate on every Live tab load.
const patternDigestCache = new TTLCache<Awaited<ReturnType<typeof getPatternDigest>>>(6 * 60 * 60 * 1000, "pattern-digest", 4);

router.get("/live/pattern-digest", async (req, res, next) => {
  try {
    const sessionsBack = Math.min(60, Math.max(5, parseInt(String(req.query["sessions"] ?? "20"), 10) || 20));
    const data = await patternDigestCache.getOrCompute(String(sessionsBack), () => getPatternDigest(sessionsBack));
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/live/entry-signals", async (_req, res, next) => {
  try {
    res.json(await getTodaysEntrySignals());
  } catch (err) {
    next(err);
  }
});

router.get("/live/entry-stats", async (_req, res, next) => {
  try {
    res.json(await computeEntryStats(30));
  } catch (err) {
    next(err);
  }
});

export default router;
