import { yahooFinance } from "./yahoo-client.js";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { getSchwabQuotes } from "./schwab-client.js";


export interface LivePrice {
  price: number | null;
  changePercent: number | null;
  /** Today's regular-session open — lets intraday consumers measure direction since the open instead of vs. prior close (gap days poison the latter). */
  open: number | null;
}

/**
 * Single golden-source live price cache — Breakdown, Portfolio quotes, and
 * Live Monitor all read through this so the displayed price is provably the
 * same number everywhere, instead of each page running its own Yahoo quote
 * call with its own TTL (previously: breakdown 2h, quotes 1h, market-context
 * 60s, live-hotlist stuck on yesterday's daily close).
 *
 * Schwab first for cache misses (batched /quotes); Yahoo fallback.
 */
export const livePriceCache = new TTLCache<LivePrice>(60 * 1000, "live-price", 2000);

/** Batched live price + change% lookup, per-ticker cached. */
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

  let stillMissing = missing;

  try {
    const schwab = await getSchwabQuotes(missing);
    if (schwab) {
      const next: string[] = [];
      for (const key of missing) {
        const q = schwab.get(key);
        if (q?.price != null) {
          const entry: LivePrice = {
            price: q.price,
            changePercent: q.changePercent,
            open: q.open,
          };
          livePriceCache.set(key, entry);
          result.set(key, entry);
        } else {
          next.push(key);
        }
      }
      stillMissing = next;
    }
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, "live-quote: Schwab batch failed — Yahoo fallback");
  }

  if (stillMissing.length === 0) return result;

  try {
    const quotes = await (yahooFinance as any).quote(
      stillMissing,
      {},
      { validateResult: false },
    ) as Array<{ symbol?: string; regularMarketPrice?: number; regularMarketChangePercent?: number; regularMarketOpen?: number }>;

    const bySymbol = new Map(quotes.map(q => [q.symbol, q]));
    for (const key of stillMissing) {
      const q = bySymbol.get(key);
      const entry: LivePrice = {
        price: q?.regularMarketPrice ?? null,
        changePercent: q?.regularMarketChangePercent ?? null,
        open: q?.regularMarketOpen ?? null,
      };
      if (entry.price != null) livePriceCache.set(key, entry);
      result.set(key, entry);
    }
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), tickers: stillMissing }, "live-quote: Yahoo batch quote fetch failed");
    for (const key of stillMissing) {
      if (!result.has(key)) result.set(key, { price: null, changePercent: null, open: null });
    }
  }

  return result;
}
