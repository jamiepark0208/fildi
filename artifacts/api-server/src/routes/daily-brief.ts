import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const yahooFinance = new YahooFinanceClass();
const anthropic    = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
const router       = Router();

// ── Context file (persistent learning/preferences) ────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
// Walk up from dist/ → project root where brief-context.json lives
const CONTEXT_PATH = join(__dir, "..", "brief-context.json");

interface BriefContext {
  version: number;
  strategy: string;
  portfolios: string;
  macroFocus: string[];
  watchSignals: string[];
  riskRules: string[];
  userNotes: string;
  lastUpdated: string;
}

function loadContext(): BriefContext {
  try {
    if (existsSync(CONTEXT_PATH)) return JSON.parse(readFileSync(CONTEXT_PATH, "utf8"));
  } catch {}
  return {
    version: 1, strategy: "Cash-secured put seller on tech/growth stocks.",
    portfolios: "IRA, FILDI, MOM", macroFocus: [], watchSignals: [],
    riskRules: [], userNotes: "", lastUpdated: new Date().toISOString().slice(0, 10),
  };
}

function saveContext(ctx: BriefContext) {
  ctx.lastUpdated = new Date().toISOString().slice(0, 10);
  writeFileSync(CONTEXT_PATH, JSON.stringify(ctx, null, 2));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketDataPoint {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
}

export interface DailyBrief {
  date: string;
  marketData: MarketDataPoint[];
  content: string;
  generatedAt: string;
  tickers: string[];
  fromCache: boolean;
}

// ── Brief cache (in-memory, keyed by date+tickers) ───────────────────────────

const cache  = new Map<string, { value: DailyBrief; ts: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

// ── Market instruments ────────────────────────────────────────────────────────

const MACRO_INSTRUMENTS = [
  { symbol: "^VIX",  label: "VIX"       },
  { symbol: "SPY",   label: "SPY"       },
  { symbol: "QQQ",   label: "QQQ"       },
  { symbol: "^TNX",  label: "10Y Yield" },
  { symbol: "ES=F",  label: "S&P Fut."  },
  { symbol: "NQ=F",  label: "NQ Fut."   },
  { symbol: "GLD",   label: "Gold"      },
  { symbol: "UUP",   label: "Dollar"    },
  { symbol: "TLT",   label: "Long Bond" },
];

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<MarketDataPoint[]> {
  const settled = await Promise.allSettled(
    MACRO_INSTRUMENTS.map(async ({ symbol, label }) => {
      const q = await yahooFinance.quote(symbol, {}, { validateResult: false });
      return {
        symbol, label,
        price:     q.regularMarketPrice            ?? null,
        change:    q.regularMarketChange           ?? null,
        changePct: q.regularMarketChangePercent    ?? null,
      } as MarketDataPoint;
    })
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { symbol: MACRO_INSTRUMENTS[i].symbol, label: MACRO_INSTRUMENTS[i].label, price: null, change: null, changePct: null }
  );
}

async function fetchTickerNews(tickers: string[]): Promise<{ ticker: string; headlines: string[] }[]> {
  const settled = await Promise.allSettled(
    tickers.slice(0, 12).map(async ticker => {
      const result = await yahooFinance.search(ticker, { newsCount: 6, quotesCount: 0 }, { validateResult: false });
      const headlines = ((result as any).news ?? []).slice(0, 6).map((n: any) => n.title).filter(Boolean);
      return { ticker, headlines };
    })
  );
  return settled
    .map((r, i) => r.status === "fulfilled" ? r.value : { ticker: tickers[i], headlines: [] })
    .filter(r => r.headlines.length > 0);
}

// ── Brief generator ───────────────────────────────────────────────────────────

async function generateBrief(
  marketData: MarketDataPoint[],
  tickerNews: { ticker: string; headlines: string[] }[],
  portfolioTickers: string[],
  date: string,
  ctx: BriefContext
): Promise<string> {
  const mdLines = marketData
    .filter(m => m.price !== null)
    .map(m => {
      const pct = m.changePct !== null ? ` (${m.changePct > 0 ? "+" : ""}${m.changePct.toFixed(2)}%)` : "";
      return `${m.label}: ${m.symbol === "^TNX" ? m.price!.toFixed(2) + "%" : m.price!.toFixed(2)}${pct}`;
    })
    .join(" | ");

  const newsBlock = tickerNews.length > 0
    ? tickerNews.map(t => `**${t.ticker}**: ${t.headlines.slice(0, 3).join(" · ")}`).join("\n")
    : "No specific ticker news retrieved.";

  const contextBlock = [
    ctx.strategy && `INVESTOR STRATEGY: ${ctx.strategy}`,
    ctx.portfolios && `PORTFOLIOS: ${ctx.portfolios}`,
    ctx.macroFocus.length > 0 && `MACRO PRIORITIES:\n${ctx.macroFocus.map(f => `• ${f}`).join("\n")}`,
    ctx.watchSignals.length > 0 && `TICKER WATCH SIGNALS:\n${ctx.watchSignals.map(s => `• ${s}`).join("\n")}`,
    ctx.riskRules.length > 0 && `RISK RULES:\n${ctx.riskRules.map(r => `• ${r}`).join("\n")}`,
    ctx.userNotes && `USER NOTES: ${ctx.userNotes}`,
  ].filter(Boolean).join("\n\n");

  const prompt = `You are a sharp portfolio analyst writing a daily briefing for a specific investor. Today is ${date}.

=== INVESTOR CONTEXT (use this to personalize every section) ===
${contextBlock}

=== LIVE MARKET DATA ===
${mdLines}

=== RECENT NEWS (auto-fetched for portfolio tickers) ===
${newsBlock}

CURRENT PORTFOLIO TICKERS: ${portfolioTickers.join(", ") || "(none provided — use watchlist signals from context)"}

Write a tight, actionable daily briefing in markdown. Follow this structure exactly:

## 🌍 Macro Environment
- 3 bullets. Cite the TNX yield and VIX level explicitly. Interpret their current readings relative to the investor's thresholds in their context.

## 📊 Market Pulse
- 3 bullets. Interpret SPY, QQQ, futures, and their divergences. Is this risk-on or risk-off? Why does it matter for selling puts today?

## 🏭 Sector & Stock Catalysts
- Up to 5 bullets. Name specific tickers from the portfolio. Pull from the news. Reference the watch signals in context where relevant.

## ⚠️ Risks This Week
- 2-3 bullets. Near-term catalysts that could spike volatility or move these stocks violently (earnings, macro data, geopolitical, regulatory).

## 💼 Portfolio Implications
- 3 bullets. Direct, specific, actionable. Should new puts be opened today, or wait? Which tickers look like good candidates right now given the signals? What premium environment does the current VIX support? Reference the risk rules.

Be specific and data-driven. Use numbers from the market data. Reference the investor's specific tickers, strategy, and risk rules. No generic financial advice.`;

  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 1200,
    messages:   [{ role: "user", content: prompt }],
  });

  return msg.content[0].type === "text" ? msg.content[0].text : "";
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/daily-brief
router.get("/daily-brief", async (req, res) => {
  const raw     = typeof req.query["tickers"] === "string" ? req.query["tickers"] : "";
  const refresh = req.query["refresh"] === "true";
  const tickers = raw
    ? raw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    : [];

  const today    = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  const cacheKey = `${today}|${tickers.sort().join(",")}`;

  if (!refresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      return res.json({ ...hit.value, fromCache: true });
    }
  }

  try {
    const ctx = loadContext();
    const [marketData, tickerNews] = await Promise.all([
      fetchMarketData(),
      fetchTickerNews(tickers),
    ]);

    const content = await generateBrief(marketData, tickerNews, tickers, today, ctx);

    const brief: DailyBrief = {
      date: today, marketData, content,
      generatedAt: new Date().toISOString(),
      tickers, fromCache: false,
    };

    cache.set(cacheKey, { value: brief, ts: Date.now() });
    return res.json(brief);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/daily-brief/context  — read current context
router.get("/daily-brief/context", (_req, res) => {
  return res.json(loadContext());
});

// PATCH /api/daily-brief/context  — update context fields
router.patch("/daily-brief/context", (req, res) => {
  try {
    const ctx = loadContext();
    const body = req.body as Partial<BriefContext>;

    if (body.strategy      !== undefined) ctx.strategy      = body.strategy;
    if (body.portfolios    !== undefined) ctx.portfolios    = body.portfolios;
    if (body.macroFocus    !== undefined) ctx.macroFocus    = body.macroFocus;
    if (body.watchSignals  !== undefined) ctx.watchSignals  = body.watchSignals;
    if (body.riskRules     !== undefined) ctx.riskRules     = body.riskRules;
    if (body.userNotes     !== undefined) ctx.userNotes     = body.userNotes;

    saveContext(ctx);
    // Bust the cache so next brief uses new context
    cache.clear();
    return res.json({ ok: true, ctx });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
