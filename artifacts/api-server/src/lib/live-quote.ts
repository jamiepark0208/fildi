import YahooFinanceClass from "yahoo-finance2";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

export interface LivePrice {
  price: number | null;
  changePercent: number | null;
}

/**
 * Single golden-source live price cache — Breakdown, Portfolio quotes, and
 * Live Monitor all read through this so the displayed price is provably the
 * same number everywhere, instead of each page running its own Yahoo quote
 * call with its own TTL (previously: breakdown 2h, quotes 1h, market-context
 * 60s, live-hotlist stuck on yesterday's daily close).
 */
export const livePriceCache = new TTLCache<LivePrice>(60 * 1000, "live-price", 2000);

/** Batched live price + change% lookup, per-ticker cached, one Yahoo call for all misses. */
export async function getLivePrices(tickers: string[]): Promise<Map<string, LivePrice>> {
  const result = new Map<string, LivePrice>();
  const keys = [...new Set(tickers.map(t => t.toUpperCase()))];
  const missing: string[] = [];

  for (const key of keys) {
    const cached = livePriceCache.get(key);
    if (cached) result.set(key, cached);
    else missing.push(key);
  }
  if (missing.length === 0) return result;

  try {
    const quotes = await (yahooFinance as any).quote(
      missing,
      {},
      { validateResult: false },
    ) as Array<{ symbol?: string; regularMarketPrice?: number; regularMarketChangePercent?: number }>;

    const bySymbol = new Map(quotes.map(q => [q.symbol, q]));
    for (const key of missing) {
      const q = bySymbol.get(key);
      const entry: LivePrice = {
        price: q?.regularMarketPrice ?? null,
        changePercent: q?.regularMarketChangePercent ?? null,
      };
      livePriceCache.set(key, entry);
      result.set(key, entry);
    }
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), tickers: missing }, "live-quote: batch quote fetch failed");
    for (const key of missing) result.set(key, { price: null, changePercent: null });
  }

  return result;
}
