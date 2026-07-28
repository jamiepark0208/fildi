import YahooFinanceClass from "yahoo-finance2";
import { and, gte, inArray, isNotNull, eq } from "drizzle-orm";
import { db, pricesHistorical, tickerRegistry } from "@workspace/db";
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

export interface SectorMover {
  ticker: string;
  price: number;
  changePercent: number;
}

export interface SectorMoverGroup {
  sector: string;
  avgChangePercent: number;
  tickerCount: number;
  topGainers: SectorMover[];
  topLosers: SectorMover[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

// Fully DB-internal — zero external calls. Uses pricesHistorical (already fetched daily
// for the app's own 257-ticker fundamentals universe) joined against tickerRegistry.sector
// (already populated, indexed) to group day-over-day movers by sector.
export async function computeSectorMovers(): Promise<SectorMoverGroup[]> {
  const registryRows = await db.select({ ticker: tickerRegistry.ticker, sector: tickerRegistry.sector })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.isActive, true), isNotNull(tickerRegistry.sector)));
  if (registryRows.length === 0) return [];

  const sectorByTicker = new Map(registryRows.map(r => [r.ticker, r.sector as string]));
  const tickers = [...sectorByTicker.keys()];

  const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await db.select({ ticker: pricesHistorical.ticker, date: pricesHistorical.date, close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(inArray(pricesHistorical.ticker, tickers), gte(pricesHistorical.date, cutoff)))
    .orderBy(pricesHistorical.ticker, pricesHistorical.date);

  const seriesByTicker = new Map<string, { date: string; close: number }[]>();
  for (const r of rows) {
    if (r.close == null) continue;
    const arr = seriesByTicker.get(r.ticker) ?? [];
    arr.push({ date: r.date as string, close: parseFloat(r.close as string) });
    seriesByTicker.set(r.ticker, arr);
  }

  const bySector = new Map<string, (SectorMover & { sector: string })[]>();
  for (const [ticker, series] of seriesByTicker) {
    if (series.length < 2) continue;
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    if (prev.close === 0) continue;
    const sector = sectorByTicker.get(ticker);
    if (!sector) continue;
    const changePercent = round2((last.close - prev.close) / prev.close * 100);
    const arr = bySector.get(sector) ?? [];
    arr.push({ ticker, price: last.close, changePercent, sector });
    bySector.set(sector, arr);
  }

  const groups: SectorMoverGroup[] = [];
  for (const [sector, list] of bySector) {
    const sorted = [...list].sort((a, b) => b.changePercent - a.changePercent);
    const avgChangePercent = round2(list.reduce((s, m) => s + m.changePercent, 0) / list.length);
    groups.push({
      sector,
      avgChangePercent,
      tickerCount: list.length,
      topGainers: sorted.slice(0, 3).map(({ ticker, price, changePercent }) => ({ ticker, price, changePercent })),
      topLosers: sorted.slice(-3).reverse().map(({ ticker, price, changePercent }) => ({ ticker, price, changePercent })),
    });
  }
  groups.sort((a, b) => b.avgChangePercent - a.avgChangePercent);

  // Overlay golden-source live price onto the displayed top movers — avgChangePercent stays
  // derived from yesterday's-close-vs-prior-day (that's the sector signal), but any individual
  // ticker's shown price must match Breakdown/Live-quote exactly, not the stale DB close.
  const allTickers = groups.flatMap(g => [...g.topGainers, ...g.topLosers].map(m => m.ticker));
  const live = await getLivePrices(allTickers);
  for (const g of groups) {
    g.topGainers = g.topGainers.map(m => {
      const price = live.get(m.ticker.toUpperCase())?.price;
      return price != null ? { ...m, price } : m;
    });
    g.topLosers = g.topLosers.map(m => {
      const price = live.get(m.ticker.toUpperCase())?.price;
      return price != null ? { ...m, price } : m;
    });
  }

  return groups;
}
