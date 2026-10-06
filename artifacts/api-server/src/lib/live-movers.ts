import { yahooFinance } from "./yahoo-client.js";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { getLivePrices, type LivePrice } from "./live-quote.js";


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

async function fetchScreenerList(scrIds: ScrId): Promise<ScreenerMover[]> {
  try {
    // Failures throw out of getOrCompute and are not cached; the catch below returns [].
    return await screenerCache.getOrCompute(scrIds, () => fetchScreenerUncached(scrIds));
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), scrIds }, "live-movers: screener fetch failed");
    return [];
  }
}

async function fetchScreenerUncached(scrIds: ScrId): Promise<ScreenerMover[]> {
  let res: any;
  try {
    res = await (yahooFinance as any).screener(
      { scrIds, count: 25 },
      { validateResult: false },
    );
  } catch (err: any) {
    // v3.14.1 throws FailedYahooValidationError even with validateResult:false on
    // some lists (day_gainers), but the error object still carries the full parsed
    // payload in .result — recover it instead of dropping the whole list.
    if (err?.name === "FailedYahooValidationError" && err.result?.quotes) res = err.result;
    else throw err;
  }
  const quotes: any[] = res?.quotes ?? [];
  const movers: ScreenerMover[] = quotes.map(q => ({
    ticker: q.symbol,
    price: q.regularMarketPrice ?? null,
    changePercent: q.regularMarketChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
  }));
  return movers;
}

// Overlays the golden-source live price (same cache Breakdown/Live-quote read) onto the
// screener's own price, so a ticker shown here always matches the price shown elsewhere.
// changePercent is left as the screener reported it — only price is guaranteed-consistent.
function applyLivePrices(movers: ScreenerMover[], live: Map<string, LivePrice>): ScreenerMover[] {
  if (movers.length === 0) return movers;
  return movers.map(m => {
    const price = live.get(m.ticker.toUpperCase())?.price;
    return price != null ? { ...m, price } : m;
  });
}

async function fetchGlobalMoversUncached(): Promise<GlobalMovers> {
  const [gainers, losers, mostActive] = await Promise.all([
    fetchScreenerList("day_gainers"),
    fetchScreenerList("day_losers"),
    fetchScreenerList("most_actives"),
  ]);
  const union = [...new Set([...gainers, ...losers, ...mostActive].map(m => m.ticker))];
  const live = union.length > 0 ? await getLivePrices(union) : new Map<string, LivePrice>();
  return {
    gainers: applyLivePrices(gainers, live),
    losers: applyLivePrices(losers, live),
    mostActive: applyLivePrices(mostActive, live),
  };
}

export async function fetchGlobalMovers(): Promise<GlobalMovers> {
  return globalMoversCache.getOrCompute("global", fetchGlobalMoversUncached);
}
