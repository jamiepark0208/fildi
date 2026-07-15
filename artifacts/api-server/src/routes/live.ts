import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
import { liveHotlist, MARKET_CONTEXT_SYMBOLS, type HotlistEntry } from "../lib/live-hotlist.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { logger } from "../lib/logger.js";

const yahooFinance = new YahooFinanceClass();
const router = Router();

export interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

// Real-time, never persisted (Tier B) — short TTL since this is a live-context strip.
export const marketContextCache = new TTLCache<MarketContextQuote[]>(60 * 1000, "live-market-context");

async function fetchMarketContext(): Promise<MarketContextQuote[]> {
  const cached = marketContextCache.get("shared");
  if (cached) return cached;

  try {
    const quotes = await (yahooFinance as any).quote(
      MARKET_CONTEXT_SYMBOLS,
      {},
      { validateResult: false },
    ) as Array<{ symbol?: string; regularMarketPrice?: number; regularMarketChangePercent?: number }>;

    const result: MarketContextQuote[] = MARKET_CONTEXT_SYMBOLS.map((ticker, i) => ({
      ticker,
      price: quotes[i]?.regularMarketPrice ?? null,
      changePercent: quotes[i]?.regularMarketChangePercent ?? null,
    }));
    marketContextCache.set("shared", result);
    return result;
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, "live: market context quote fetch failed");
    return MARKET_CONTEXT_SYMBOLS.map(ticker => ({ ticker, price: null, changePercent: null }));
  }
}

async function snapshot(): Promise<{ hotlist: HotlistEntry[]; marketContext: MarketContextQuote[]; lastRefreshedAt: number | null }> {
  return {
    hotlist: liveHotlist.getCurrentEntries(),
    marketContext: await fetchMarketContext(),
    lastRefreshedAt: liveHotlist.getLastRefreshedAt(),
  };
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
    marketContextCache.delete("shared");
    res.json(await snapshot());
  } catch (err) {
    next(err);
  }
});

export default router;
