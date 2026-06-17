import YahooFinanceClass from "yahoo-finance2";
import { eq } from "drizzle-orm";
import { db, dataSources, watchlist } from "@workspace/db";
import { WATCHLIST } from "./constants.js";
import {
  type FredSeries,
  type MacroData,
  type MacroEvent,
  getEventsForDate,
  getEventsThisWeek,
} from "./macro-data.js";
import {
  dedupeHeadlines,
  type NewsHeadline,
  type MacroHighlightsPayload,
} from "./macro-highlight-utils.js";

export {
  parseMacroHighlightsPayload,
  fallbackHighlightsPayload,
  type MacroHighlightsPayload,
  type NewsHeadline,
} from "./macro-highlight-utils.js";

const yahooFinance = new YahooFinanceClass();

export interface QuoteSnapshot {
  symbol: string;
  label: string;
  price: number | null;
  changePct: number | null;
}

export interface WatchlistMoverSnapshot {
  ticker: string;
  changePct: number;
  price: number | null;
}

export interface MacroReleaseSnapshot {
  label: string;
  value: string;
  releaseDate: string;
}

export interface MacroHighlightContext {
  marketDate: string;
  headlines: NewsHeadline[];
  eventsToday: MacroEvent[];
  eventsThisWeek: MacroEvent[];
  macroReleases: MacroReleaseSnapshot[];
  quotes: QuoteSnapshot[];
  watchlistMovers: WatchlistMoverSnapshot[];
  hints: {
    iwmMinusSpy: number | null;
    megaCapAvgChg: number | null;
    vixLevel: number | null;
    vixRegime: string;
    marketDirection: string;
  };
}

const MEGA_CAPS = ["NVDA", "AAPL", "AMZN", "GOOGL", "MSFT"] as const;

const QUOTE_INSTRUMENTS: { symbol: string; label: string }[] = [
  { symbol: "SPY", label: "SPY" },
  { symbol: "QQQ", label: "QQQ" },
  { symbol: "IWM", label: "IWM" },
  { symbol: "DIA", label: "DIA" },
  { symbol: "^VIX", label: "VIX" },
  { symbol: "^RUT", label: "RUT" },
  { symbol: "XLK", label: "XLK" },
  { symbol: "XLE", label: "XLE" },
  { symbol: "CL=F", label: "WTI" },
  { symbol: "GLD", label: "GLD" },
  { symbol: "UUP", label: "DXY" },
];

const BROAD_NEWS_QUERIES = [
  "stock market today",
  "FOMC federal reserve",
  "S&P 500 markets",
  "oil prices economy",
];

const SERIES_LABELS: Record<string, string> = {
  cpi: "CPI",
  coreCpi: "Core CPI",
  corePce: "Core PCE",
  unemployment: "Unemployment",
  nonfarmPayrolls: "Nonfarm Payrolls",
  jolts: "JOLTS",
  gdp: "Real GDP",
  ppi: "PPI",
  retailSales: "Retail Sales",
  consumerSentiment: "Consumer Sentiment",
  fedFundsRate: "Fed Funds Rate",
};

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Constants ─────────────────────────────────────────────────────────────────

export async function fetchGoogleNewsRss(
  query: string,
  limit = 6,
): Promise<NewsHeadline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (news fetcher)" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();

    const items: NewsHeadline[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = m[1];
      const title = (/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
        .trim();
      const linkMatch =
        /<link>([\s\S]*?)<\/link>/.exec(block) ?? /<a href="([^"]+)"/.exec(block);
      const link = linkMatch?.[1]?.trim() ?? "";
      const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "").trim();
      const source = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
        .trim();
      if (title && link) {
        items.push({
          title,
          url: link,
          source: source || "Google News",
          publishedAt: pubDate,
        });
      }
    }
    return items;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

// ── Yahoo ticker news ───────────────────────────────────────────────────────────

async function fetchYahooTickerNews(ticker: string, limit = 5): Promise<NewsHeadline[]> {
  try {
    const result = await yahooFinance.search(
      ticker,
      { newsCount: limit, quotesCount: 0 },
      { validateResult: false },
    );
    const news = ((result as { news?: Array<Record<string, unknown>> }).news ?? []).slice(
      0,
      limit,
    );
    return news
      .map((n) => ({
        title: String(n.title ?? ""),
        url: String(n.link ?? n.url ?? ""),
        source: String(n.publisher ?? "Yahoo Finance"),
        publishedAt: n.providerPublishTime
          ? new Date(Number(n.providerPublishTime) * 1000).toISOString()
          : "",
        tickers: [ticker.toUpperCase()],
      }))
      .filter((n) => n.title.length > 0);
  } catch {
    return [];
  }
}

// ── Finnhub company news (news endpoint only) ───────────────────────────────────

async function resetFinnhubBudgetIfNeeded(): Promise<void> {
  const today = todayStr();
  const rows = await db.select().from(dataSources).where(eq(dataSources.name, "finnhub"));
  for (const row of rows) {
    if (row.lastResetDate !== today) {
      await db
        .update(dataSources)
        .set({ callsToday: 0, lastResetDate: today })
        .where(eq(dataSources.id, row.id));
    }
  }
}

async function getFinnhubBudgetRemaining(): Promise<number> {
  await resetFinnhubBudgetIfNeeded();
  const rows = await db.select().from(dataSources).where(eq(dataSources.name, "finnhub"));
  const row = rows[0];
  if (!row || !row.isActive) return 0;
  return Math.max(0, row.dailyLimit - row.callsToday);
}

async function incrementFinnhubCalls(): Promise<void> {
  const rows = await db.select().from(dataSources).where(eq(dataSources.name, "finnhub"));
  const row = rows[0];
  if (!row) return;
  await db
    .update(dataSources)
    .set({ callsToday: row.callsToday + 1 })
    .where(eq(dataSources.id, row.id));
}

async function fetchFinnhubCompanyNews(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<NewsHeadline[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const remaining = await getFinnhubBudgetRemaining();
  if (remaining <= 0) return [];

  const url =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}` +
    `&from=${fromDate}&to=${toDate}&token=${apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    await incrementFinnhubCalls();

    const items = (await res.json()) as Array<{
      headline?: string;
      summary?: string;
      source?: string;
      url?: string;
      datetime?: number;
    }>;

    return (items ?? [])
      .slice(0, 5)
      .map((n) => ({
        title: n.headline ?? "",
        url: n.url ?? "",
        source: n.source ?? "Finnhub",
        publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : "",
        tickers: [ticker.toUpperCase()],
      }))
      .filter((n) => n.title.length > 0);
  } catch {
    return [];
  }
}

// ── Market news gatherer ────────────────────────────────────────────────────────

export async function fetchMarketNews(opts: {
  watchlistTickers: string[];
  moverTickers: string[];
}): Promise<NewsHeadline[]> {
  const tickerSet = new Set<string>([
    ...MEGA_CAPS,
    ...opts.watchlistTickers.slice(0, 12),
    ...opts.moverTickers,
  ]);

  const fromDate = addDaysIso(todayStr(), -2);
  const toDate = todayStr();

  const googleSettled = await Promise.allSettled(
    [
      ...BROAD_NEWS_QUERIES.map((q) => fetchGoogleNewsRss(q, 5)),
      ...opts.moverTickers.slice(0, 6).map((t) => fetchGoogleNewsRss(`${t} stock`, 4)),
    ],
  );

  const yahooSettled = await Promise.allSettled(
    [...tickerSet].slice(0, 14).map((t) => fetchYahooTickerNews(t, 4)),
  );

  const finnhubSettled = await Promise.allSettled(
    opts.moverTickers.slice(0, 3).map((t) => fetchFinnhubCompanyNews(t, fromDate, toDate)),
  );

  const raw: NewsHeadline[] = [];
  for (const r of googleSettled) {
    if (r.status === "fulfilled") raw.push(...r.value);
  }
  for (const r of yahooSettled) {
    if (r.status === "fulfilled") raw.push(...r.value);
  }
  for (const r of finnhubSettled) {
    if (r.status === "fulfilled") raw.push(...r.value);
  }

  return dedupeHeadlines(raw).slice(0, 40);
}

// ── Quotes ──────────────────────────────────────────────────────────────────────

async function fetchQuoteSnapshots(): Promise<QuoteSnapshot[]> {
  const settled = await Promise.allSettled(
    QUOTE_INSTRUMENTS.map(async ({ symbol, label }) => {
      const q = await yahooFinance.quote(symbol, {}, { validateResult: false });
      const rec = q as Record<string, unknown>;
      return {
        symbol,
        label,
        price: typeof rec.regularMarketPrice === "number" ? rec.regularMarketPrice : null,
        changePct:
          typeof rec.regularMarketChangePercent === "number"
            ? rec.regularMarketChangePercent
            : null,
      } satisfies QuoteSnapshot;
    }),
  );

  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          symbol: QUOTE_INSTRUMENTS[i].symbol,
          label: QUOTE_INSTRUMENTS[i].label,
          price: null,
          changePct: null,
        },
  );
}

async function fetchWatchlistMovers(tickers: string[]): Promise<WatchlistMoverSnapshot[]> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()))].slice(0, 24);
  if (unique.length === 0) return [];

  const settled = await Promise.allSettled(
    unique.map(async (ticker) => {
      const q = await yahooFinance.quote(ticker, {}, { validateResult: false });
      const rec = q as Record<string, unknown>;
      const changePct =
        typeof rec.regularMarketChangePercent === "number"
          ? rec.regularMarketChangePercent
          : null;
      const price =
        typeof rec.regularMarketPrice === "number" ? rec.regularMarketPrice : null;
      if (changePct == null) return null;
      return { ticker, changePct, price } satisfies WatchlistMoverSnapshot;
    }),
  );

  const movers = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((m): m is WatchlistMoverSnapshot => m != null)
    .sort((a, b) => b.changePct - a.changePct);

  const top = movers.slice(0, 3);
  const bottom = movers.slice(-3).reverse();
  const combined = [...top];
  for (const m of bottom) {
    if (!combined.some((c) => c.ticker === m.ticker)) combined.push(m);
  }
  return combined.slice(0, 6);
}

export async function getWatchlistTickers(userId?: number): Promise<string[]> {
  if (userId) {
    const rows = await db
      .select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(eq(watchlist.userId, userId));
    if (rows.length > 0) return rows.map((r) => r.ticker.toUpperCase());
  }
  return WATCHLIST;
}

// ── FRED release snapshots ──────────────────────────────────────────────────────

function fmtSeriesValue(key: string, s: FredSeries): string {
  if (s.value == null) return "N/A";
  if (key === "nonfarmPayrolls") return `${s.value.toLocaleString()}K`;
  if (key === "retailSales") return `$${(s.value / 1000).toFixed(1)}B`;
  if (key === "consumerSentiment") return s.value.toFixed(1);
  if (s.yoy != null) return `${s.yoy > 0 ? "+" : ""}${s.yoy.toFixed(1)}% YoY`;
  return `${s.value.toFixed(2)}${s.unit === "%" ? "%" : ""}`;
}

function buildMacroReleases(macroData: MacroData, today: string): MacroReleaseSnapshot[] {
  const windowStart = addDaysIso(today, -3);
  const out: MacroReleaseSnapshot[] = [];

  for (const [key, series] of Object.entries(macroData.series)) {
    if (!series.date) continue;
    if (series.date < windowStart || series.date > today) continue;
    out.push({
      label: SERIES_LABELS[key] ?? key,
      value: fmtSeriesValue(key, series),
      releaseDate: series.date,
    });
  }

  return out;
}

// ── Context builder ─────────────────────────────────────────────────────────────

export async function buildMacroHighlightContext(
  macroData: MacroData,
  userId?: number,
): Promise<MacroHighlightContext> {
  const marketDate = new Date().toISOString().slice(0, 10);
  const watchlistTickers = await getWatchlistTickers(userId);

  const [quotes, watchlistMovers] = await Promise.all([
    fetchQuoteSnapshots(),
    fetchWatchlistMovers(watchlistTickers),
  ]);

  const moverTickers = watchlistMovers.map((m) => m.ticker);
  const headlines = await fetchMarketNews({ watchlistTickers, moverTickers });

  const eventsToday = getEventsForDate(marketDate);
  const eventsThisWeek = getEventsThisWeek(marketDate);
  const macroReleases = buildMacroReleases(macroData, marketDate);

  const bySymbol = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
  const spyPct = bySymbol["SPY"]?.changePct ?? null;
  const iwmPct = bySymbol["IWM"]?.changePct ?? null;
  const iwmMinusSpy =
    spyPct != null && iwmPct != null ? +(iwmPct - spyPct).toFixed(2) : null;

  const megaQuotes = await Promise.allSettled(
    MEGA_CAPS.map((t) => yahooFinance.quote(t, {}, { validateResult: false })),
  );
  const megaChanges = megaQuotes
    .map((r) =>
      r.status === "fulfilled"
        ? ((r.value as Record<string, unknown>).regularMarketChangePercent as number | null)
        : null,
    )
    .filter((v): v is number => v != null);
  const megaCapAvgChg =
    megaChanges.length > 0
      ? +(megaChanges.reduce((a, b) => a + b, 0) / megaChanges.length).toFixed(2)
      : null;

  const vixLevel = bySymbol["^VIX"]?.price ?? macroData.vix.value;
  const marketDirection =
    spyPct == null
      ? "mixed"
      : spyPct > 0.5
        ? `up (+${spyPct.toFixed(2)}%)`
        : spyPct < -0.5
          ? `down (${spyPct.toFixed(2)}%)`
          : "flat";

  return {
    marketDate,
    headlines,
    eventsToday,
    eventsThisWeek,
    macroReleases,
    quotes,
    watchlistMovers,
    hints: {
      iwmMinusSpy,
      megaCapAvgChg,
      vixLevel,
      vixRegime: macroData.vix.level,
      marketDirection,
    },
  };
}
