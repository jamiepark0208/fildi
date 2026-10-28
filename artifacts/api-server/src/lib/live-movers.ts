import { yahooFinance } from "./yahoo-client.js";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { livePriceCache } from "./live-quote.js";


export interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

export type GlobalMovers = {
  gainers: ScreenerMover[];
  losers: ScreenerMover[];
  mostActive: ScreenerMover[];
};

// Free, built-in yahoo-finance2 predefined screener — no new dependency, no API key.
// Undocumented Yahoo internal endpoint, so validateResult is disabled and each list
// is fetched independently so one failing list doesn't take down the others.
export const screenerCache = new TTLCache<ScreenerMover[]>(5 * 60 * 1000, "live-screener", 10);

/** Combined movers response — short TTL so concurrent Live mounts share one cold fill. */
export const globalMoversCache = new TTLCache<GlobalMovers>(90 * 1000, "live-movers-combined", 4);

type ScrId = "day_gainers" | "day_losers" | "most_actives";

/** Heatmap only needs ~12 tiles; Yahoo validation noise grows with count. */
const SCREENER_COUNT = 15;

async function fetchScreenerList(scrIds: ScrId): Promise<ScreenerMover[]> {
  try {
    // Failures throw out of getOrCompute and are not cached; the catch below returns [].
    return await screenerCache.getOrCompute(scrIds, () => fetchScreenerUncached(scrIds));
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), scrIds }, "live-movers: screener fetch failed");
    return [];
  }
}

function mapScreenerQuotes(quotes: any[]): ScreenerMover[] {
  return quotes.map((q) => ({
    ticker: String(q.symbol ?? ""),
    price: q.regularMarketPrice ?? q.fulldayPrice ?? null,
    changePercent: q.regularMarketChangePercent ?? q.fulldayChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
  })).filter((m) => m.ticker);
}

/** Direct predefined-screener HTTP — yahoo-finance2 crumb/fetch often dies while this still works. */
async function fetchScreenerHttp(scrIds: ScrId): Promise<ScreenerMover[]> {
  const url =
    `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved` +
    `?count=${SCREENER_COUNT}&scrIds=${encodeURIComponent(scrIds)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { finance?: { result?: Array<{ quotes?: any[] }> } };
  return mapScreenerQuotes(body?.finance?.result?.[0]?.quotes ?? []);
}

async function fetchScreenerUncached(scrIds: ScrId): Promise<ScreenerMover[]> {
  // Prefer raw HTTP — yahoo-finance2 crumb + schema validation is slow/flaky and
  // often throws FailedYahooValidationError (or TypeError: fetch failed) on Live.
  try {
    const httpMovers = await fetchScreenerHttp(scrIds);
    if (httpMovers.length > 0) return httpMovers;
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), scrIds }, "live-movers: HTTP screener failed — SDK fallback");
  }

  let res: any;
  try {
    res = await (yahooFinance as any).screener(
      { scrIds, count: SCREENER_COUNT },
      { validateResult: false },
    );
  } catch (err: any) {
    // v3.14.1 throws FailedYahooValidationError even with validateResult:false on
    // some lists (day_gainers), but the error object still carries the full parsed
    // payload in .result — recover it instead of dropping the whole list.
    if (err?.name === "FailedYahooValidationError" && err.result?.quotes) {
      res = err.result;
    } else {
      throw err;
    }
  }
  return mapScreenerQuotes(res?.quotes ?? []);
}

// Overlay only *already-cached* golden-source quotes — never await a batch on
// the Live mount path. Apply price + changePercent together so % never drifts
// from a Schwab price paired with a Yahoo screener %.
function applyCachedLivePrices(movers: ScreenerMover[]): ScreenerMover[] {
  if (movers.length === 0) return movers;
  return movers.map((m) => {
    const q = livePriceCache.get(m.ticker.toUpperCase());
    if (!q) return m;
    return {
      ...m,
      price: q.price ?? m.price,
      changePercent: q.changePercent ?? m.changePercent,
    };
  });
}

async function fetchGlobalMoversUncached(): Promise<GlobalMovers> {
  const [gainers, losers, mostActive] = await Promise.all([
    fetchScreenerList("day_gainers"),
    fetchScreenerList("day_losers"),
    fetchScreenerList("most_actives"),
  ]);
  return {
    gainers: applyCachedLivePrices(gainers),
    losers: applyCachedLivePrices(losers),
    mostActive: applyCachedLivePrices(mostActive),
  };
}

export async function fetchGlobalMovers(): Promise<GlobalMovers> {
  return globalMoversCache.getOrCompute("global", fetchGlobalMoversUncached);
}
