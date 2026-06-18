import { z } from "zod";
import YahooFinanceClass from "yahoo-finance2";
import { ECONOMIC_EVENTS } from "./macro-data.js";
import { WATCHLIST } from "./constants.js";
import { loadMacroCache } from "./macro-data.js";

const yahooFinance = new YahooFinanceClass();

// ── Zod schema ─────────────────────────────────────────────────────────────────

export const EventTodaySchema = z.object({
  date: z.string(),
  event: z.string(),
  importance: z.enum(["high", "medium", "low"]),
});

export const MetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  direction: z.enum(["up", "down", "flat"]),
});

export const BulletSchema = z.object({
  id: z.string(),
  category: z.enum(["tape", "macro", "sector", "watchlist", "event", "geopolitical"]),
  title: z.string().max(120),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  tickers: z.array(z.string()).optional(),
  metric: MetricSchema.optional(),
});

export const WatchlistMoverSchema = z.object({
  ticker: z.string(),
  changePct: z.number(),
  blurb: z.string(),
});

export const HighlightsPayloadSchema = z.object({
  generatedAt: z.string(),
  marketDate: z.string(),
  headline: z.string().max(120),
  eventsToday: z.array(EventTodaySchema),
  bullets: z.array(BulletSchema).max(20),
  watchlistMovers: z.array(WatchlistMoverSchema),
});

export type HighlightsPayload = z.infer<typeof HighlightsPayloadSchema>;

// ── News fetching ──────────────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  ticker?: string;
}

async function fetchGoogleNewsRss(query: string, maxItems = 6): Promise<NewsItem[]> {
  const q = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (macro fetcher)" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    const items: NewsItem[] = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null && items.length < maxItems) {
      const block = m[1];
      const title = (/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
      const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "").trim();
      const source = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
      if (title) items.push({ title, source: source || "Google News", publishedAt: pubDate });
    }
    return items;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

async function fetchYahooTickerNews(ticker: string, max = 5): Promise<NewsItem[]> {
  try {
    const result = await yahooFinance.search(
      ticker, { newsCount: max, quotesCount: 0 }, { validateResult: false }
    );
    const news = ((result as Record<string, unknown>)["news"] ?? []) as Record<string, unknown>[];
    return news
      .slice(0, max)
      .filter((n) => typeof n["title"] === "string")
      .map((n) => ({
        title: n["title"] as string,
        source: (n["publisher"] as string) || "Yahoo Finance",
        publishedAt: n["providerPublishTime"]
          ? new Date((n["providerPublishTime"] as number) * 1000).toISOString()
          : "",
        ticker,
      }));
  } catch {
    return [];
  }
}

// ── Quote fetching ─────────────────────────────────────────────────────────────

interface QuoteSnap {
  ticker: string;
  label: string;
  price: number | null;
  changePct: number | null;
}

async function fetchQuotes(tickers: { symbol: string; label: string }[]): Promise<QuoteSnap[]> {
  const results = await Promise.allSettled(
    tickers.map(async ({ symbol, label }) => {
      const q = (await yahooFinance.quote(symbol, {}, { validateResult: false })) as Record<string, unknown>;
      return {
        ticker: symbol,
        label,
        price: typeof q["regularMarketPrice"] === "number" ? q["regularMarketPrice"] : null,
        changePct: typeof q["regularMarketChangePercent"] === "number" ? q["regularMarketChangePercent"] : null,
      } as QuoteSnap;
    })
  );
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { ticker: tickers[i].symbol, label: tickers[i].label, price: null, changePct: null }
  );
}

// ── Facts packet ───────────────────────────────────────────────────────────────

export interface FactsPacket {
  marketDate: string;
  news: NewsItem[];
  eventsToday: { date: string; event: string; importance: string }[];
  eventsThisWeek: { date: string; event: string; importance: string }[];
  macroSnapshot: Record<string, { label: string; value: string; date: string | null }>;
  marketSnapshot: { ticker: string; label: string; price: string; changePct: string }[];
  watchlistMovers: { ticker: string; changePct: number; price: number | null }[];
  marketDirection: string;
}

export async function buildFactsPacket(): Promise<FactsPacket> {
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const eventsToday = ECONOMIC_EVENTS.filter((e) => e.date === today);
  const eventsThisWeek = ECONOMIC_EVENTS.filter((e) => e.date > today && e.date <= weekEnd);

  // Core market quotes
  const CORE = [
    { symbol: "SPY",   label: "SPY"       },
    { symbol: "QQQ",   label: "QQQ"       },
    { symbol: "IWM",   label: "IWM"       },
    { symbol: "^VIX",  label: "VIX"       },
    { symbol: "^TNX",  label: "10Y Yield" },
    { symbol: "NVDA",  label: "NVDA"      },
    { symbol: "AAPL",  label: "AAPL"      },
    { symbol: "TSLA",  label: "TSLA"      },
    { symbol: "AMZN",  label: "AMZN"      },
    { symbol: "GOOGL", label: "GOOGL"     },
    { symbol: "META",  label: "META"      },
    { symbol: "MSFT",  label: "MSFT"      },
  ];

  const watchlistSymbols = WATCHLIST.map((t) => ({ symbol: t, label: t }));

  const [coreSnaps, watchlistSnaps] = await Promise.all([
    fetchQuotes(CORE),
    fetchQuotes(watchlistSymbols),
  ]);

  // Top watchlist movers by |changePct|
  const movers = watchlistSnaps
    .filter((q) => q.changePct !== null)
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
    .slice(0, 8);

  const topMoverTickers = movers.slice(0, 5).map((m) => m.ticker);

  // SPY direction hint
  const spySnap = coreSnaps.find((q) => q.ticker === "SPY");
  const spyPct = spySnap?.changePct ?? null;
  const marketDirection =
    spyPct == null ? "mixed"
    : spyPct > 1   ? `sharply higher (+${spyPct.toFixed(2)}%)`
    : spyPct > 0.3 ? `higher (+${spyPct.toFixed(2)}%)`
    : spyPct < -1  ? `sharply lower (${spyPct.toFixed(2)}%)`
    : spyPct < -0.3 ? `lower (${spyPct.toFixed(2)}%)`
    : `roughly flat (${spyPct.toFixed(2)}%)`;

  // News queries
  const broadQueries = [
    "stock market today " + today,
    "Federal Reserve interest rates",
    "S&P 500 market move",
    "bond yields stocks",
    "sector rotation stocks today",
  ];
  if (eventsToday.some((e) => /fomc|fed/i.test(e.event))) {
    broadQueries.push("FOMC Federal Reserve decision");
  }
  if (eventsToday.some((e) => /cpi|inflation/i.test(e.event))) {
    broadQueries.push("CPI inflation report");
  }

  // Fetch news in parallel (broad + per ticker)
  const [broadResults, ...tickerResults] = await Promise.allSettled([
    Promise.all(broadQueries.map((q) => fetchGoogleNewsRss(q, 5))),
    ...topMoverTickers.map((t) => fetchYahooTickerNews(t, 5)),
  ]);

  const allNews: NewsItem[] = [];
  const seenTitles = new Set<string>();
  const dedupeAdd = (items: NewsItem[]) => {
    for (const item of items) {
      const key = item.title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 70);
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        allNews.push(item);
      }
    }
  };

  if (broadResults.status === "fulfilled") {
    for (const batch of broadResults.value) dedupeAdd(batch);
  }
  for (const r of tickerResults) {
    if (r.status === "fulfilled") dedupeAdd(r.value);
  }

  // Macro snapshot from cache
  const macroCache = loadMacroCache();
  const macroSnapshot: FactsPacket["macroSnapshot"] = {};
  if (macroCache) {
    const s = macroCache.series;
    const f = (v: number | null, d: number) => (v != null ? v.toFixed(d) : "N/A");
    macroSnapshot["vix"]             = { label: "VIX",            value: f(macroCache.vix.value, 2),   date: today };
    macroSnapshot["yield10y"]        = { label: "10Y Yield",      value: f(macroCache.yield10y.value, 3) + "%", date: today };
    macroSnapshot["yield2y"]         = { label: "2Y Yield",       value: f(macroCache.yield2y.value, 3) + "%", date: today };
    macroSnapshot["fedFundsRate"]    = { label: "Fed Funds",      value: f(s.fedFundsRate.value, 2) + "%", date: s.fedFundsRate.date };
    macroSnapshot["cpi"]             = { label: "CPI YoY",        value: f(s.cpi.yoy, 1) + "%",        date: s.cpi.date };
    macroSnapshot["corePce"]         = { label: "Core PCE YoY",   value: f(s.corePce.yoy, 1) + "%",    date: s.corePce.date };
    macroSnapshot["unemployment"]    = { label: "Unemployment",   value: f(s.unemployment.value, 1) + "%", date: s.unemployment.date };
    macroSnapshot["nonfarmPayrolls"] = { label: "Nonfarm Payrolls", value: f(s.nonfarmPayrolls.value, 0) + "K", date: s.nonfarmPayrolls.date };
    macroSnapshot["gdp"]             = { label: "Real GDP",       value: f(s.gdp.value, 1) + "%",      date: s.gdp.date };
    macroSnapshot["retailSales"]     = { label: "Retail Sales",   value: "$" + (s.retailSales.value != null ? (s.retailSales.value / 1000).toFixed(1) + "B" : "N/A"), date: s.retailSales.date };
  }

  const fmt2 = (n: number | null) => (n != null ? n.toFixed(2) : "N/A");
  const fmtPct = (n: number | null) => (n != null ? (n >= 0 ? "+" : "") + n.toFixed(2) + "%" : "N/A");

  return {
    marketDate: today,
    news: allNews.slice(0, 45),
    eventsToday,
    eventsThisWeek,
    macroSnapshot,
    marketSnapshot: coreSnaps.map((q) => ({
      ticker: q.ticker,
      label: q.label,
      price: fmt2(q.price),
      changePct: fmtPct(q.changePct),
    })),
    watchlistMovers: movers.map((m) => ({ ticker: m.ticker, changePct: m.changePct!, price: m.price })),
    marketDirection,
  };
}

// ── AI prompt ─────────────────────────────────────────────────────────────────

export function buildHighlightsPrompt(packet: FactsPacket): string {
  const newsBlock = packet.news
    .map((n, i) => `[${i + 1}] ${n.title}${n.ticker ? ` (re: ${n.ticker})` : ""}`)
    .join("\n");

  const eventsBlock = [
    ...packet.eventsToday.map((e) => `TODAY ${e.date}: ${e.event} [${e.importance}]`),
    ...packet.eventsThisWeek.map((e) => `THIS WEEK ${e.date}: ${e.event} [${e.importance}]`),
  ].join("\n") || "None";

  const snapshotBlock = packet.marketSnapshot
    .map((q) => `${q.label}: ${q.price} (${q.changePct})`)
    .join("  |  ");

  const moversBlock = packet.watchlistMovers
    .map((m) => `${m.ticker}: ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%`)
    .join("  |  ");

  const macroBlock = Object.values(packet.macroSnapshot)
    .map((s) => `${s.label}: ${s.value}${s.date ? ` (as of ${s.date})` : ""}`)
    .join("  |  ");

  return `You are a macro analyst writing today's market brief for an options trader who sells OTM puts.
TODAY: ${packet.marketDate}
Market is trading ${packet.marketDirection}.

=== SCHEDULED CALENDAR EVENTS ===
${eventsBlock}

=== LIVE MARKET SNAPSHOT ===
${snapshotBlock}

=== WATCHLIST MOVERS (top by magnitude) ===
${moversBlock}

=== MACRO BACKDROP (FRED cache) ===
${macroBlock}

=== NEWS HEADLINES (deduplicated, numbered) ===
${newsBlock}

=== YOUR TASK ===
Write a structured JSON brief. Rules:
1. EVERY bullet must trace back to a headline number above, a calendar event, or a market snapshot number. Reference the source implicitly in the body.
2. If an FOMC or Fed event appears in today's calendar, it MUST appear in the headline or first bullet with today's date.
3. If a high-importance event is scheduled today, lead with it.
4. Pick 8–15 of the most market-moving items. Skip noise, duplicates, and stale fundamentals.
5. For watchlistMovers: pair each ticker's changePct with the best matching headline. If no headline, write "rotation-driven" or "no headline catalyst".
6. Category rules: tape=market/index moves, macro=Fed/yields/data, sector=industry rotation, watchlist=specific tickers, event=scheduled releases, geopolitical=geopolitics/oil/trade.
7. Do NOT invent prices, events, or narratives not in the facts above.

Respond ONLY with valid JSON matching this exact shape (no markdown, no explanation):
{
  "generatedAt": "${new Date().toISOString()}",
  "marketDate": "${packet.marketDate}",
  "headline": "<max 90 chars — most important thing happening today>",
  "eventsToday": [
    { "date": "<YYYY-MM-DD>", "event": "<name>", "importance": "high|medium|low" }
  ],
  "bullets": [
    {
      "id": "b1",
      "category": "tape|macro|sector|watchlist|event|geopolitical",
      "title": "<max 60 chars>",
      "body": "<max 25 words — specific, cite numbers>",
      "tickers": ["TICK"],
      "metric": { "label": "<short label>", "value": "<value>", "direction": "up|down|flat" }
    }
  ],
  "watchlistMovers": [
    { "ticker": "TICK", "changePct": 0.0, "blurb": "<max 15 words>" }
  ]
}`;
}

// ── Parse + validate ───────────────────────────────────────────────────────────

export function parseHighlightsResponse(text: string, marketDate: string): HighlightsPayload {
  try {
    // Try extracting JSON from markdown code block first, then bare JSON
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = codeBlock ? codeBlock[1].trim() : text.trim();

    // Find the outermost JSON object in case there's surrounding text
    const startIdx = candidate.indexOf("{");
    const endIdx   = candidate.lastIndexOf("}");
    const jsonStr  = startIdx >= 0 && endIdx > startIdx
      ? candidate.slice(startIdx, endIdx + 1)
      : candidate;

    const raw = JSON.parse(jsonStr);

    // Coerce watchlistMovers.changePct to number if model returned string
    if (Array.isArray(raw.watchlistMovers)) {
      for (const m of raw.watchlistMovers) {
        if (typeof m.changePct === "string") m.changePct = parseFloat(m.changePct);
      }
    }

    const result = HighlightsPayloadSchema.parse(raw);
    return result;
  } catch (err) {
    console.error("[macro-highlights] parse failed:", err instanceof Error ? err.message : err);
    console.error("[macro-highlights] raw text length:", text.length, "preview:", text.slice(0, 300));
    return fallbackPayload(marketDate);
  }
}

// ── Fallback ───────────────────────────────────────────────────────────────────

export function fallbackPayload(marketDate: string): HighlightsPayload {
  return {
    generatedAt: new Date().toISOString(),
    marketDate,
    headline: "Macro highlights temporarily unavailable",
    eventsToday: [],
    bullets: [{
      id: "fallback-1",
      category: "tape",
      title: "Generation failed",
      body: "Could not parse highlights. Try regenerating.",
    }],
    watchlistMovers: [],
  };
}

// ── Legacy detection ───────────────────────────────────────────────────────────

export function isLegacyHighlights(data: unknown): boolean {
  return (
    data != null &&
    typeof data === "object" &&
    "content" in (data as object) &&
    typeof (data as Record<string, unknown>)["content"] === "string" &&
    !("bullets" in (data as object))
  );
}
