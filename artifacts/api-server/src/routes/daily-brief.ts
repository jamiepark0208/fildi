import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const yahooFinance = new YahooFinanceClass();
const anthropic    = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
const router       = Router();

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dir       = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dir, "..", "..");
const CONTEXT_PATH = join(ROOT, "brief-context.json");
const HISTORY_PATH = join(ROOT, "brief-history.json");

// ── Context file ──────────────────────────────────────────────────────────────

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

// ── History (file-backed, one brief per date) ─────────────────────────────────

const MAX_HISTORY = 90;

function loadHistory(): DailyBrief[] {
  try {
    if (existsSync(HISTORY_PATH)) {
      const raw = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      return Array.isArray(raw) ? raw : (raw.briefs ?? []);
    }
  } catch {}
  return [];
}

function saveHistory(briefs: DailyBrief[]) {
  const sorted = [...briefs]
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
    .slice(0, MAX_HISTORY);
  writeFileSync(HISTORY_PATH, JSON.stringify(sorted, null, 2));
}

function upsertBrief(brief: DailyBrief) {
  const history = loadHistory();
  const idx = history.findIndex(b => b.date === brief.date);
  if (idx >= 0) history[idx] = brief; else history.push(brief);
  saveHistory(history);
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

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
        price:     q.regularMarketPrice         ?? null,
        change:    q.regularMarketChange        ?? null,
        changePct: q.regularMarketChangePercent ?? null,
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

// ── AI brief generator ────────────────────────────────────────────────────────

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
    ctx.strategy   && `INVESTOR STRATEGY: ${ctx.strategy}`,
    ctx.portfolios && `PORTFOLIOS: ${ctx.portfolios}`,
    ctx.macroFocus.length  > 0 && `MACRO PRIORITIES:\n${ctx.macroFocus.map(f => `• ${f}`).join("\n")}`,
    ctx.watchSignals.length > 0 && `TICKER WATCH SIGNALS:\n${ctx.watchSignals.map(s => `• ${s}`).join("\n")}`,
    ctx.riskRules.length   > 0 && `RISK RULES:\n${ctx.riskRules.map(r => `• ${r}`).join("\n")}`,
    ctx.userNotes  && `USER NOTES: ${ctx.userNotes}`,
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

// GET /api/daily-brief/market — live prices only, no AI, called on every page load
router.get("/daily-brief/market", async (_req, res) => {
  try {
    const marketData = await fetchMarketData();
    return res.json({ marketData });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/daily-brief/history — all past briefs, newest first
router.get("/daily-brief/history", (_req, res) => {
  const history = loadHistory().sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
  );
  return res.json(history);
});

// GET /api/daily-brief — return today's stored brief or { noData: true }; ?refresh=true regenerates
router.get("/daily-brief", async (req, res) => {
  const raw     = typeof req.query["tickers"] === "string" ? req.query["tickers"] : "";
  const refresh = req.query["refresh"] === "true";
  const tickers = raw ? raw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean) : [];
  const today   = todayLabel();

  if (!refresh) {
    const todayBrief = loadHistory().find(b => b.date === today);
    if (todayBrief) return res.json({ ...todayBrief, fromCache: true });
    return res.json({ noData: true });
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

    upsertBrief(brief);
    return res.json(brief);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /api/daily-brief/context
router.get("/daily-brief/context", (_req, res) => {
  return res.json(loadContext());
});

// PATCH /api/daily-brief/context
router.patch("/daily-brief/context", (req, res) => {
  try {
    const ctx  = loadContext();
    const body = req.body as Partial<BriefContext>;
    if (body.strategy      !== undefined) ctx.strategy      = body.strategy;
    if (body.portfolios    !== undefined) ctx.portfolios    = body.portfolios;
    if (body.macroFocus    !== undefined) ctx.macroFocus    = body.macroFocus;
    if (body.watchSignals  !== undefined) ctx.watchSignals  = body.watchSignals;
    if (body.riskRules     !== undefined) ctx.riskRules     = body.riskRules;
    if (body.userNotes     !== undefined) ctx.userNotes     = body.userNotes;
    saveContext(ctx);
    return res.json({ ok: true, ctx });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
