import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import Anthropic from "@anthropic-ai/sdk";
import YahooFinanceClass from "yahoo-finance2";
const yahooFinance = new YahooFinanceClass();
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  fetchMacroData,
  fetchMacroCharts,
  fetchIndicatorHistory,
  loadMacroCache,
  saveMacroCache,
  isCacheStale,
  loadChartsCache,
  saveChartsCache,
  isChartsCacheStale,
  FED_MEMBERS,
  ECONOMIC_EVENTS,
  BANK_RESEARCH_DEFAULT,
  SEP_PROJECTIONS,
  SEP_DATE,
  INDICATOR_SERIES,
  MacroData,
  BankResearch,
} from "../lib/macro-data.js";
import {
  buildFactsPacket,
  buildHighlightsPrompt,
  parseHighlightsResponse,
  fallbackPayload,
  isLegacyHighlights,
} from "../lib/macro-highlights.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, "..", "..");

const HIGHLIGHTS_FILE    = join(ROOT, "macro-highlights.json");
const BANK_RESEARCH_FILE = join(ROOT, "macro-bank-research.json");

const router = Router();

// ── Macro data ────────────────────────────────────────────────────────────────

router.get("/data", async (_req: Request, res: Response) => {
  let cached = loadMacroCache();
  if (cached && !isCacheStale(cached, 4)) return res.json(cached);
  try {
    const fresh = await fetchMacroData();
    saveMacroCache(fresh);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] fetchMacroData failed:", err);
    if (cached) return res.json(cached);
    return res.status(500).json({ error: "Failed to fetch macro data and no cache available" });
  }
});

router.post("/refresh", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const fresh = await fetchMacroData();
    saveMacroCache(fresh);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] refresh failed:", err);
    return res.status(500).json({ error: "Failed to refresh macro data" });
  }
});

// ── Charts data ───────────────────────────────────────────────────────────────

router.get("/charts", async (_req: Request, res: Response) => {
  let cached = loadChartsCache();
  if (cached && !isChartsCacheStale(cached, 4)) return res.json(cached);
  try {
    const fresh = await fetchMacroCharts();
    saveChartsCache(fresh);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] fetchMacroCharts failed:", err);
    if (cached) return res.json(cached);
    return res.status(500).json({ error: "Failed to fetch macro charts" });
  }
});

// ── Indicator history ─────────────────────────────────────────────────────────

router.get("/indicator-history", async (req: Request, res: Response) => {
  const key = req.query["key"] as string | undefined;
  if (!key || !INDICATOR_SERIES[key]) {
    return res.status(400).json({ error: "Unknown indicator key" });
  }
  const meta = INDICATOR_SERIES[key];
  try {
    const periodsForYoY = meta.isYoY ? 12 : 0;
    const data = await fetchIndicatorHistory(meta.id, periodsForYoY, 4380); // ~12 years
    return res.json({ key, label: meta.label, unit: meta.unit, isYoY: !!meta.isYoY, data });
  } catch (err) {
    console.error("[macro] indicator-history failed:", err);
    return res.status(500).json({ error: "Failed to fetch indicator history" });
  }
});

// ── SEP actuals ───────────────────────────────────────────────────────────────
// Returns recent actual values for each SEP metric from FRED

router.get("/sep-actuals", async (_req: Request, res: Response) => {
  try {
    const [gdpData, pcePData, unemploymentData, ffData] = await Promise.allSettled([
      fetchIndicatorHistory("A191RL1Q225SBEA", 0, 3650),    // GDP quarterly
      fetchIndicatorHistory("PCEPILFE", 12, 3650),           // Core PCE YoY
      fetchIndicatorHistory("UNRATE", 0, 3650),              // Unemployment
      fetchIndicatorHistory("DFF", 0, 3650),                 // Fed Funds
    ]);

    return res.json({
      gdp:          gdpData.status === "fulfilled"          ? gdpData.value          : [],
      corePce:      pcePData.status === "fulfilled"         ? pcePData.value         : [],
      unemployment: unemploymentData.status === "fulfilled" ? unemploymentData.value : [],
      fedFunds:     ffData.status === "fulfilled"           ? ffData.value           : [],
    });
  } catch (err) {
    console.error("[macro] sep-actuals failed:", err);
    return res.status(500).json({ error: "Failed to fetch SEP actuals" });
  }
});

// ── Bank news ─────────────────────────────────────────────────────────────────

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

async function fetchBankNews(bankName: string): Promise<NewsArticle[]> {
  const query = encodeURIComponent(`${bankName} market outlook OR rate view OR trading strategy`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
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

    // Parse RSS items via regex
    const items: NewsArticle[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 5) {
      const block = m[1];
      const title     = (/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
      const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block) ??
                        /<a href="([^"]+)"/.exec(block);
      const link      = linkMatch?.[1]?.trim() ?? "";
      const pubDate   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "").trim();
      const source    = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
      if (title && link) {
        items.push({ title, url: link, source: source || "Google News", publishedAt: pubDate });
      }
    }
    return items;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

router.get("/bank-news", async (req: Request, res: Response) => {
  const bank = req.query["bank"] as string | undefined;
  if (!bank) return res.status(400).json({ error: "bank query param required" });
  try {
    const articles = await fetchBankNews(bank);
    return res.json(articles);
  } catch (err) {
    console.error("[macro] bank-news failed:", err);
    return res.status(500).json({ error: "Failed to fetch bank news" });
  }
});

// ── Highlights ────────────────────────────────────────────────────────────────

router.get("/highlights", (_req: Request, res: Response) => {
  try {
    if (!existsSync(HIGHLIGHTS_FILE)) return res.json({ noData: true });
    const raw = JSON.parse(readFileSync(HIGHLIGHTS_FILE, "utf-8")) as Record<string, unknown>;

    // Legacy format: old free-text { content } cache
    if (isLegacyHighlights(raw)) return res.json({ legacy: true });

    // Expire highlights after midnight
    const today = new Date().toISOString().slice(0, 10);
    const generatedDay = typeof raw["generatedAt"] === "string" ? raw["generatedAt"].slice(0, 10) : "";
    if (generatedDay < today) return res.json({ noData: true });

    return res.json(raw);
  } catch {
    return res.json({ noData: true });
  }
});

router.post("/highlights/generate", requireAdmin, async (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const packet = await buildFactsPacket();
    const prompt = buildHighlightsPrompt(packet);

    const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const result = parseHighlightsResponse(text, today);
    writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(result, null, 2), "utf-8");
    return res.json(result);
  } catch (err) {
    console.error("[macro] highlights/generate failed:", err);
    const fb = fallbackPayload(today);
    return res.status(500).json(fb);
  }
});

// ── Fed members ───────────────────────────────────────────────────────────────

router.get("/fed-members", (_req: Request, res: Response) => {
  return res.json(FED_MEMBERS);
});

// ── Events ────────────────────────────────────────────────────────────────────

router.get("/events", (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  return res.json(ECONOMIC_EVENTS.filter((e) => e.date >= today));
});

// ── SEP projections ───────────────────────────────────────────────────────────

router.get("/sep-projections", (_req: Request, res: Response) => {
  return res.json({ projections: SEP_PROJECTIONS, asOf: SEP_DATE });
});

// ── Bank research ─────────────────────────────────────────────────────────────

function loadBankResearch(): BankResearch[] {
  try {
    if (!existsSync(BANK_RESEARCH_FILE)) return BANK_RESEARCH_DEFAULT;
    return JSON.parse(readFileSync(BANK_RESEARCH_FILE, "utf-8")) as BankResearch[];
  } catch {
    return BANK_RESEARCH_DEFAULT;
  }
}

router.get("/bank-research", (_req: Request, res: Response) => {
  return res.json(loadBankResearch());
});

router.post("/bank-research/generate", requireAdmin, async (_req: Request, res: Response) => {
  try {
    let macroData: MacroData | null = loadMacroCache();
    if (!macroData) {
      macroData = await fetchMacroData();
      saveMacroCache(macroData);
    }

    const existing = loadBankResearch();
    const bankList = existing.map((b) => b.name).join(", ");

    const prompt = `You are a macro strategist summarizing major bank views for an options trader.

Current macro context (${macroData.fetchedAt.slice(0, 10)}):
- VIX ${macroData.vix.value?.toFixed(1) ?? "N/A"} (${macroData.vix.level})
- Core PCE YoY: ${macroData.series.corePce.yoy?.toFixed(1) ?? "N/A"}%
- Unemployment: ${macroData.series.unemployment.value?.toFixed(1) ?? "N/A"}%
- GDP: ${macroData.series.gdp.value?.toFixed(1) ?? "N/A"}% annualized
- Fed Funds: ${macroData.series.fedFundsRate.value?.toFixed(2) ?? "N/A"}%
- 10Y Yield: ${macroData.yield10y.value?.toFixed(3) ?? "N/A"}%

For each of these banks: ${bankList}

Respond with a JSON array. Each object must have exactly these fields:
{
  "name": "<full bank name>",
  "shortName": "<3-5 char abbreviation>",
  "stance": "<bullish|neutral|bearish>",
  "rateView": "<short rate cut forecast, e.g. '2 cuts 2026'>",
  "summary": "<1-2 sentence specific market view, cite macro rationale>",
  "lastUpdated": "${new Date().toISOString().slice(0, 10)}"
}

Base stances on publicly known views and the current macro context. Return ONLY the JSON array, no other text.`;

    const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "[]";
    let updated: BankResearch[];
    try {
      updated = JSON.parse(text) as BankResearch[];
    } catch {
      return res.json(existing);
    }

    writeFileSync(BANK_RESEARCH_FILE, JSON.stringify(updated, null, 2), "utf-8");
    return res.json(updated);
  } catch (err) {
    console.error("[macro] bank-research/generate failed:", err);
    return res.status(500).json({ error: "Failed to generate bank research" });
  }
});

export default router;
