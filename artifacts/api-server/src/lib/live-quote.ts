import {
  yahooFinance,
  withDeadline,
  isYahooCircuitOpen,
  noteYahooFailure,
  noteYahooSuccess,
} from "./yahoo-client.js";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { getSchwabQuotes } from "./schwab-client.js";


export interface LivePrice {
  price: number | null;
  /** Day change in percent points (e.g. −6.83 = −6.83%), same as Yahoo regularMarketChangePercent. */
  changePercent: number | null;
  /** Absolute $ day change when the vendor provides it (Schwab netChange). */
  change?: number | null;
  /** Today's regular-session open — lets intraday consumers measure direction since the open instead of vs. prior close (gap days poison the latter). */
  open: number | null;
  /** Vendor that filled the cache entry (provenance for hover tips). */
  source?: "schwab" | "yahoo";
  /** When this cache entry was written (ISO). */
  asOf?: string;
}

/**
 * Single golden-source live price cache — Breakdown, Portfolio quotes, and
 * Live Monitor all read through this so the displayed price is provably the
 * same number everywhere, instead of each page running its own Yahoo quote
 * call with its own TTL (previously: breakdown 2h, quotes 1h, market-context
 * 60s, live-hotlist stuck on yesterday's daily close).
 *
 * TTL CBA (desk day-% / Live movers, not HFT):
 *   60s  → freshest, ~2× vendor load vs 120s, more 429/hang surface
 *   120s → pick: half the quote traffic, still fine for % day / movers strip
 *   180–300s → quieter vendors, day-% feels sticky on Live/Options boards
 * Schwab first for cache misses (batched /quotes); Yahoo fallback.
 */
export const LIVE_PRICE_TTL_MS = 120_000;
export const livePriceCache = new TTLCache<LivePrice>(LIVE_PRICE_TTL_MS, "live-price", 2000);

/** Last good price per ticker (10-28): boards poll every 120 s = the TTL, so almost every poll missed the cache and
 *  waited 0.3–0.9 s on Schwab. A price < 10 min old is now served at once and refreshed in the background. */
const lastGood = new Map<string, { v: LivePrice; at: number }>();
const STALE_OK_MS = 10 * 60_000;
const bgInFlight = new Set<string>();

function remember(key: string, entry: LivePrice): void {
  livePriceCache.set(key, entry);
  lastGood.set(key, { v: entry, at: Date.now() });
}

/** Batched live price + change% lookup, per-ticker cached; stale-while-revalidate up to STALE_OK_MS. */
export async function getLivePrices(tickers: string[]): Promise<Map<string, LivePrice>> {
  const result = new Map<string, LivePrice>();
  const blocking: string[] = [];
  const background: string[] = [];
  for (const key of new Set(tickers.map(t => t.toUpperCase()))) {
    const cached = livePriceCache.get(key);
    if (cached) { result.set(key, cached); continue; }
    const lg = lastGood.get(key);
    if (lg && Date.now() - lg.at < STALE_OK_MS) {
      result.set(key, lg.v);
      if (!bgInFlight.has(key)) background.push(key);
    } else blocking.push(key);
  }
  if (background.length > 0) {
    for (const k of background) bgInFlight.add(k);
    void fetchLivePrices(background)
      .catch((err) => logger.warn({ err: String(err) }, "live-quote: background refresh failed"))
      .finally(() => { for (const k of background) bgInFlight.delete(k); });
  }
  if (blocking.length > 0) for (const [k, v] of await fetchLivePrices(blocking)) result.set(k, v);
  return result;
}

async function fetchLivePrices(tickers: string[]): Promise<Map<string, LivePrice>> {
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

  // Schwab has no Asia / caret indices (^KS11, ^VIX, …) — skip so we don't burn
  // ~10s on a failing /quotes round-trip before Yahoo.
  const schwabKeys = missing.filter((k) => !k.startsWith("^"));
  const indexKeys = missing.filter((k) => k.startsWith("^"));

  try {
    if (schwabKeys.length > 0) {
      const schwab = await getSchwabQuotes(schwabKeys);
      if (schwab) {
        const next: string[] = [...indexKeys];
        for (const key of schwabKeys) {
          const q = schwab.get(key);
          if (q?.price != null) {
            const entry: LivePrice = {
              price: q.price,
              changePercent: q.changePercent,
              change: q.change ?? null,
              open: q.open,
              source: "schwab",
              asOf: new Date().toISOString(),
            };
            remember(key, entry);
            result.set(key, entry);
          } else {
            next.push(key);
          }
        }
        stillMissing = next;
      } else {
        stillMissing = missing;
      }
    }
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, "live-quote: Schwab batch failed — Yahoo fallback");
  }

  if (stillMissing.length === 0) return result;

  if (isYahooCircuitOpen()) {
    for (const key of stillMissing) {
      if (!result.has(key)) result.set(key, { price: null, changePercent: null, open: null });
    }
    return result;
  }

  try {
    const quotes = await withDeadline(
      (yahooFinance as any).quote(
        stillMissing,
        {},
        { validateResult: false },
      ) as Promise<Array<{
        symbol?: string;
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
        regularMarketChange?: number;
        regularMarketOpen?: number;
      }>>,
      5_000,
      "yahoo.quote",
    );

    noteYahooSuccess();
    const bySymbol = new Map(quotes.map(q => [q.symbol, q]));
    for (const key of stillMissing) {
      const q = bySymbol.get(key);
      const entry: LivePrice = {
        price: q?.regularMarketPrice ?? null,
        changePercent: q?.regularMarketChangePercent ?? null,
        change: q?.regularMarketChange ?? null,
        open: q?.regularMarketOpen ?? null,
        source: "yahoo",
        asOf: new Date().toISOString(),
      };
      if (entry.price != null) remember(key, entry);
      result.set(key, entry);
    }
  } catch (err: any) {
    noteYahooFailure(err);
    logger.warn({ err: String(err?.message ?? err), tickers: stillMissing }, "live-quote: Yahoo batch quote fetch failed");
    for (const key of stillMissing) {
      if (!result.has(key)) result.set(key, { price: null, changePercent: null, open: null });
    }
  }

  return result;
}
