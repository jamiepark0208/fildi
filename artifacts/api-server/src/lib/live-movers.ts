import YahooFinanceClass from "yahoo-finance2";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { getLivePrices } from "./live-quote.js";

const yahooFinance = new YahooFinanceClass();

export interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

// Free, built-in yahoo-finance2 predefined screener — no new dependency, no API key.
// Undocumented Yahoo internal endpoint, so validateResult is disabled and each list
// is fetched independently so one failing list doesn't take down the others.
export const screenerCache = new TTLCache<ScreenerMover[]>(5 * 60 * 1000, "live-screener", 10);

type ScrId = "day_gainers" | "day_losers" | "most_actives";

async function fetchScreenerList(scrIds: ScrId): Promise<ScreenerMover[]> {
  const cached = screenerCache.get(scrIds);
  if (cached) return cached;

  try {
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
    screenerCache.set(scrIds, movers);
    return movers;
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err), scrIds }, "live-movers: screener fetch failed");
    return [];
  }
}

// Overlays the golden-source live price (same cache Breakdown/Live-quote read) onto the
// screener's own price, so a ticker shown here always matches the price shown elsewhere.
// changePercent is left as the screener reported it — only price is guaranteed-consistent.
async function overlayLivePrices(movers: ScreenerMover[]): Promise<ScreenerMover[]> {
  if (movers.length === 0) return movers;
  const live = await getLivePrices(movers.map(m => m.ticker));
  return movers.map(m => {
    const price = live.get(m.ticker.toUpperCase())?.price;
    return price != null ? { ...m, price } : m;
  });
}

export async function fetchGlobalMovers(): Promise<{ gainers: ScreenerMover[]; losers: ScreenerMover[]; mostActive: ScreenerMover[] }> {
  const [gainers, losers, mostActive] = await Promise.all([
    fetchScreenerList("day_gainers"),
    fetchScreenerList("day_losers"),
    fetchScreenerList("most_actives"),
  ]);
  const [gOverlaid, lOverlaid, mOverlaid] = await Promise.all([
    overlayLivePrices(gainers),
    overlayLivePrices(losers),
    overlayLivePrices(mostActive),
  ]);
  return { gainers: gOverlaid, losers: lOverlaid, mostActive: mOverlaid };
}
