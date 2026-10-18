import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { aiLimiter } from "../middleware/rateLimiter.js";
import { callHaiku } from "../lib/haiku.js";
import { yahooFinance } from "../lib/yahoo-client.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  fetchMacroData,
  fetchMacroCharts,
  fetchIndicatorHistory,
  fetchSectorRotation,
  loadMacroCache,
  saveMacroCache,
  isCacheStale,
  loadChartsCache,
  saveChartsCache,
  isChartsCacheStale,
  loadSectorRotationCache,
  saveSectorRotationCache,
  isSectorRotationCacheStale,
  FED_MEMBERS,
  ECONOMIC_EVENTS,
  BANK_RESEARCH_DEFAULT,
  SEP_PROJECTIONS,
  SEP_DATE,
  INDICATOR_SERIES,
  MacroData,
  BankResearch,
} from "../lib/macro-data.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { singleFlight } from "../lib/single-flight.js";
import {
  buildFactsPacket,
  buildHighlightsPrompt,
  parseHighlightsResponse,
  extractJsonText,
  fallbackPayload,
  isLegacyHighlights,
} from "../lib/macro-highlights.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, "..", "..");

const HIGHLIGHTS_FILE    = join(ROOT, "macro-highlights.json");
const BANK_RESEARCH_FILE = join(ROOT, "macro-bank-research.json");

// Caches for routes that previously had no backend caching. Exported so cache-registry.ts
// can surface them in the Cache Monitor tab — see bugs/5, same class of bug as profileCache
// previously going untracked (a cache existing here doesn't automatically show up there).
export const indicatorHistoryCache = new TTLCache<object>(30 * 60 * 1000, "macro-indicator-history");
export const sepActualsCache       = new TTLCache<object>(60 * 60 * 1000, "macro-sep-actuals");
export const sectorRotationCache   = new TTLCache<object>(30 * 60 * 1000, "macro-sector-rotation");
export const bankNewsCache         = new TTLCache<NewsArticle[]>(30 * 60 * 1000, "macro-bank-news", 50);

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

// ── Sector rotation (relative strength vs SPY, proxy only) ────────────────────

router.get("/sector-rotation", async (_req: Request, res: Response) => {
  try {
    // Memory TTL + disk (~5KB) so Heatmap/Liquidity don't re-hit Yahoo×50 after API restart.
    return res.json(
      await sectorRotationCache.getOrCompute("sector-rotation", async () => {
        const disk = loadSectorRotationCache();
        if (disk && !isSectorRotationCacheStale(disk)) return disk.points;
        const fresh = await fetchSectorRotation();
        try { saveSectorRotationCache(fresh); } catch { /* ignore disk write */ }
        return fresh;
      }),
    );
  } catch (err) {
    console.error("[macro] sector-rotation failed:", err);
    return res.status(500).json({ error: "Failed to fetch sector rotation" });
  }
});// ── Indicator history ─────────────────────────────────────────────────────────

router.get("/indicator-history", async (req: Request, res: Response) => {
  const key = req.query["key"] as string | undefined;
  if (!key || !INDICATOR_SERIES[key]) {
    return res.status(400).json({ error: "Unknown indicator key" });
  }
  const meta = INDICATOR_SERIES[key];
  try {
    const result = await indicatorHistoryCache.getOrCompute(key, async () => {
      const periodsForYoY = meta.isYoY ? 12 : 0;
      const data = await fetchIndicatorHistory(meta.id, periodsForYoY, 4380); // ~12 years
      return { key, label: meta.label, unit: meta.unit, isYoY: !!meta.isYoY, data };
    });
    return res.json(result);
  } catch (err) {
    console.error("[macro] indicator-history failed:", err);
    return res.status(500).json({ error: "Failed to fetch indicator history" });
  }
});

// ── SEP actuals ───────────────────────────────────────────────────────────────
// Returns recent actual values for each SEP metric from FRED

router.get("/sep-actuals", async (_req: Request, res: Response) => {
  try {
    const result = await sepActualsCache.getOrCompute("sep-actuals", async () => {
      const [gdpData, pcePData, unemploymentData, ffData] = await Promise.allSettled([
        fetchIndicatorHistory("A191RL1Q225SBEA", 0, 3650),    // GDP quarterly
        fetchIndicatorHistory("PCEPILFE", 12, 3650),           // Core PCE YoY
        fetchIndicatorHistory("UNRATE", 0, 3650),              // Unemployment
        fetchIndicatorHistory("DFF", 0, 3650),                 // Fed Funds
      ]);
      return {
        gdp:          gdpData.status === "fulfilled"          ? gdpData.value          : [],
        corePce:      pcePData.status === "fulfilled"         ? pcePData.value         : [],
        unemployment: unemploymentData.status === "fulfilled" ? unemploymentData.value : [],
        fedFunds:     ffData.status === "fulfilled"           ? ffData.value           : [],
      };
    });
    return res.json(result);
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

// Google News RSS, cached 30 min per bank and shared by concurrent callers. Empty results
// are not cached (fetchBankNews returns [] on failure too), so a blip doesn't stick.
async function getBankNews(bank: string): Promise<NewsArticle[]> {
  try {
    return await bankNewsCache.getOrCompute(bank.toLowerCase(), async () => {
      const items = await fetchBankNews(bank);
      if (items.length === 0) throw new Error("no articles");
      return items;
    });
  } catch {
    return [];
  }
}

router.get("/bank-news", async (req: Request, res: Response) => {
  const bank = req.query["bank"] as string | undefined;
  if (!bank) return res.status(400).json({ error: "bank query param required" });
  try {
    return res.json(await getBankNews(bank));
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

// One generation at a time — a double-click joins the in-flight Haiku call instead of paying twice.
const generateHighlights = singleFlight(async (userId: number | undefined) => {
  const today = new Date().toISOString().slice(0, 10);
  const packet = await buildFactsPacket();
  const prompt = buildHighlightsPrompt(packet);

  const { text } = await callHaiku({
    prompt,
    maxTokens: 1500,
    trigger: "macro-highlights",
    surfaceType: "macro-highlights",
    userId,
    ticker: "_",
  });
  const result = parseHighlightsResponse(text, today);
  writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(result, null, 2), "utf-8");
  return result;
});

router.post("/highlights/generate", requireAdmin, aiLimiter, async (req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    return res.json(await generateHighlights(req.session.userId));
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

// One generation at a time — a double-click joins the in-flight call.
// NOTE: stances feed regime-classifier's deriveBankLean — prompt changes here change the
// business-cycle regime, so they need a before/after review (AGENTS.md rule 5).
const generateBankResearch = singleFlight(async (userId: number | undefined): Promise<BankResearch[]> => {
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

  const { text } = await callHaiku({
    prompt,
    maxTokens: 2000,
    trigger: "macro-bank-research",
    surfaceType: "macro-bank-research",
    userId,
    ticker: "_",
  });
  let updated: unknown;
  try {
    updated = JSON.parse(extractJsonText(text || "[]", "["));
  } catch {
    return existing;
  }
  if (!Array.isArray(updated) || updated.length === 0) return existing;

  writeFileSync(BANK_RESEARCH_FILE, JSON.stringify(updated, null, 2), "utf-8");
  return updated as BankResearch[];
});

router.post("/bank-research/generate", requireAdmin, aiLimiter, async (req: Request, res: Response) => {
  try {
    return res.json(await generateBankResearch(req.session.userId));
  } catch (err) {
    console.error("[macro] bank-research/generate failed:", err);
    return res.status(500).json({ error: "Failed to generate bank research" });
  }
});

/** A96 — market breadth history (display only; not a signal). */
router.get("/breadth", async (_req: Request, res: Response) => {
  try {
    const { getBreadthHistory } = await import("../lib/market-breadth.js");
    const points = await getBreadthHistory(500);
    res.json({ points, note: "Display only — not a trading signal (S027)." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /macro/risk-free-rate — returns SOFR (or fedFundsRate fallback) from macro cache for scoring
router.get("/risk-free-rate", (_req: Request, res: Response) => {
  const data = loadMacroCache();
  if (!data) return res.json({ riskFreeRate: null });
  const rate = data.series.sofr?.value ?? data.series.fedFundsRate?.value ?? null;
  // FRED returns rates as percentage points (e.g. 5.33 for 5.33%) — convert to decimal for scoring
  return res.json({ riskFreeRate: rate !== null ? rate / 100 : null });
});

export default router;
