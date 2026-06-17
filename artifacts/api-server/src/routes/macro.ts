import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
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
  BANK_RESEARCH_DEFAULT,
  SEP_PROJECTIONS,
  SEP_DATE,
  INDICATOR_SERIES,
  MacroData,
  BankResearch,
  getUnifiedMacroEvents,
} from "../lib/macro-data.js";
import {
  buildMacroHighlightContext,
  fetchGoogleNewsRss,
  parseMacroHighlightsPayload,
  fallbackHighlightsPayload,
  type MacroHighlightsPayload,
} from "../lib/macro-highlight-context.js";

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

router.post("/refresh", async (_req: Request, res: Response) => {
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
  const query = `${bankName} market outlook OR rate view OR trading strategy`;
  const items = await fetchGoogleNewsRss(query, 5);
  return items.map(({ title, url, source, publishedAt }) => ({
    title,
    url,
    source,
    publishedAt,
  }));
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
    const parsed = JSON.parse(readFileSync(HIGHLIGHTS_FILE, "utf-8")) as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
    const generatedDay = generatedAt.slice(0, 10);
    if (generatedDay < today) return res.json({ noData: true });

    if ("headline" in parsed && parseMacroHighlightsPayload(parsed)) {
      return res.json(parsed);
    }
    if ("content" in parsed) {
      return res.json({ noData: true, legacy: true });
    }
    return res.json({ noData: true });
  } catch {
    return res.json({ noData: true });
  }
});

async function generateMacroHighlights(
  macroData: MacroData,
  userId?: number,
): Promise<MacroHighlightsPayload> {
  const ctx = await buildMacroHighlightContext(macroData, userId);
  const factsJson = JSON.stringify(ctx, null, 2);

  const prompt = `You are a sharp market desk writer producing TODAY's macro highlights for an options trader.

TODAY: ${ctx.marketDate}
Market direction hint: ${ctx.hints.marketDirection}

You receive a facts packet (JSON). Write ONLY from evidence in the packet — headlines, calendar events, live quotes, and dated macro releases. Do NOT invent facts or cite fundamentals (revenue, P/E, margins) unless verbatim in a headline.

RULES:
1. Curate ruthlessly — from all headlines in the packet, pick the ~10 most market-moving stories (macro catalysts, large-cap news, sector rotation, geopolitical/oil). Skip minor, duplicate, or stale items.
2. Lead with news — every bullet must trace to a headline, event, or quote in the packet.
3. If eventsToday includes FOMC → MUST appear in headline or first bullet with today's date.
4. FRED/macroReleases: only cite if releaseDate is in packet; always include the release date.
5. Max 10 bullets; body max 20 words each — one concise sentence per bullet.
6. headline: one line, max 90 chars — direction + primary catalyst.
7. watchlistMovers: pair each mover's changePct with the best matching headline; if none, say "rotation-driven" or "no headline".
8. No fundamentals unless copied from a headline title.

Return ONLY valid JSON matching this schema (no markdown fences):
{
  "generatedAt": ISO8601 string,
  "marketDate": "${ctx.marketDate}",
  "headline": string,
  "eventsToday": [{ "date", "event", "importance": "high"|"medium"|"low" }],
  "bullets": [{ "id", "category": "tape"|"macro"|"sector"|"watchlist"|"event"|"geopolitical", "title", "body", "tags?", "tickers?", "metric?" }],
  "watchlistMovers": [{ "ticker", "changePct", "blurb" }]
}

FACTS PACKET:
${factsJson}`;

  const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1800,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const raw = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);
    const parsed = parseMacroHighlightsPayload(raw);
    if (parsed) {
      return {
        ...parsed,
        generatedAt: new Date().toISOString(),
        marketDate: ctx.marketDate,
        eventsToday: ctx.eventsToday.length > 0 ? ctx.eventsToday : parsed.eventsToday,
      };
    }
  } catch {
    // fall through to fallback
  }

  return fallbackHighlightsPayload(ctx.marketDate, "Could not parse AI response");
}

router.post("/highlights/generate", async (req: Request, res: Response) => {
  try {
    let macroData: MacroData | null = loadMacroCache();
    if (!macroData) {
      macroData = await fetchMacroData();
      saveMacroCache(macroData);
    }

    const userId = req.session?.userId as number | undefined;
    const result = await generateMacroHighlights(macroData, userId);
    writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(result, null, 2), "utf-8");
    return res.json(result);
  } catch (err) {
    console.error("[macro] highlights/generate failed:", err);
    return res.status(500).json({ error: "Failed to generate macro highlights" });
  }
});

// ── Fed members ───────────────────────────────────────────────────────────────

router.get("/fed-members", (_req: Request, res: Response) => {
  return res.json(FED_MEMBERS);
});

// ── Events ────────────────────────────────────────────────────────────────────

router.get("/events", (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  return res.json(getUnifiedMacroEvents().filter((e) => e.date >= today));
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

router.post("/bank-research/generate", async (_req: Request, res: Response) => {
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
