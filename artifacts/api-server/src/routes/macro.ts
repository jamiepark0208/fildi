import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
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
  readMacroCacheFile,
  saveMacroCache,
  isCacheStale,
  loadChartsCache,
  saveChartsCache,
  isChartsCacheStale,
  readChartsCacheFile,
  chartsSeriesOk,
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
  MacroCharts,
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
import { mergeWithPrior } from "../lib/macro/macro-merge.js";

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

function yieldCurveOk(data: MacroData | null | undefined): boolean {
  return !!data?.yieldCurve?.some((p) => p.current != null);
}

function withPriorYieldCurve(fresh: MacroData, prior: MacroData | null): MacroData {
  if (yieldCurveOk(fresh) || !yieldCurveOk(prior)) return fresh;
  return { ...fresh, yieldCurve: prior!.yieldCurve, yield2y: prior!.yield2y, yieldSpread: prior!.yieldSpread };
}

function persistMacroData(fresh: MacroData, prior: MacroData | null): MacroData {
  const merged = mergeWithPrior(withPriorYieldCurve(fresh, prior), prior); // A303: every other field too
  // Never write a blank curve — that poisoned the 4h cache and made Regime spin for ~30s every open.
  if (yieldCurveOk(merged)) saveMacroCache(merged);
  else console.warn("[macro] skip cache save — yield curve still empty after refresh");
  return merged;
}

router.get("/data", async (_req: Request, res: Response) => {
  let cached = loadMacroCache();
  if (cached && !isCacheStale(cached, 4)) return res.json(cached);
  // Disk may hold a prior good curve even when loadMacroCache rejects a poisoned/empty file.
  const prior = cached ?? readMacroCacheFile();
  try {
    const fresh = persistMacroData(await fetchMacroData(), prior);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] fetchMacroData failed:", err);
    if (cached) return res.json(cached);
    if (yieldCurveOk(prior)) return res.json(prior!);
    return res.status(500).json({ error: "Failed to fetch macro data and no cache available" });
  }
});

router.post("/refresh", requireAdmin, async (_req: Request, res: Response) => {
  const prior = loadMacroCache() ?? readMacroCacheFile();
  try {
    const fresh = persistMacroData(await fetchMacroData(), prior);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] refresh failed:", err);
    return res.status(500).json({ error: "Failed to refresh macro data" });
  }
});

// ── Charts data ───────────────────────────────────────────────────────────────

const CHART_SERIES_KEYS = [
  "vixHistory", "fedFundsHistory", "tenYearHistory", "fearGreedHistory",
  "hySpreadHistory", "igSpreadHistory", "putCallHistory", "putCallRatioHistory",
  "gscpiHistory", "moneyMarketHistory", "nfciHistory", "copperGoldHistory",
  "dxyHistory", "fedAssetsHistory", "tgaHistory", "rrpHistory", "reservesHistory",
  "netLiquidityHistory", "sofrIorbSpreadHistory", "moveHistory",
] as const;

function withPriorChartSeries(fresh: MacroCharts, prior: MacroCharts | null): MacroCharts {
  if (!prior) return fresh;
  const merged = { ...fresh };
  for (const k of CHART_SERIES_KEYS) {
    const cur = fresh[k];
    const old = prior[k];
    if (Array.isArray(cur) && cur.length === 0 && Array.isArray(old) && old.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[k] = old;
    }
  }
  // Recompute implications when we salvaged liquidity/vol inputs from prior.
  if (merged.hySpreadHistory !== fresh.hySpreadHistory
    || merged.nfciHistory !== fresh.nfciHistory
    || merged.fedAssetsHistory !== fresh.fedAssetsHistory
    || merged.netLiquidityHistory !== fresh.netLiquidityHistory
    || merged.sofrIorbSpreadHistory !== fresh.sofrIorbSpreadHistory) {
    // leave prior implications if present — avoid blank overall when series salvaged
    if (!fresh.liquidityImplications?.signals?.length && prior.liquidityImplications) {
      merged.liquidityImplications = prior.liquidityImplications;
    }
  }
  if (merged.hySpreadHistory !== fresh.hySpreadHistory
    || merged.moveHistory !== fresh.moveHistory
    || merged.putCallRatioHistory !== fresh.putCallRatioHistory) {
    if (!fresh.volatilityImplications?.signals?.length && prior.volatilityImplications) {
      merged.volatilityImplications = prior.volatilityImplications;
    }
  }
  return merged;
}

function persistMacroCharts(fresh: MacroCharts, prior: MacroCharts | null): MacroCharts {
  const merged = mergeWithPrior(withPriorChartSeries(fresh, prior), prior); // A303: every other field too
  if (chartsSeriesOk(merged)) saveChartsCache(merged);
  else console.warn("[macro] skip charts cache save — critical series still empty after refresh");
  return merged;
}

router.get("/charts", async (_req: Request, res: Response) => {
  let cached = loadChartsCache();
  if (cached && !isChartsCacheStale(cached, 4)) return res.json(cached);
  const prior = cached ?? readChartsCacheFile();
  try {
    const fresh = persistMacroCharts(await fetchMacroCharts(), prior);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] fetchMacroCharts failed:", err);
    if (cached) return res.json(cached);
    if (chartsSeriesOk(prior)) return res.json(prior!);
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

router.get("/events", async (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
  try {
    const { getEconomicCalendar } = await import("../lib/economic-calendar.js");
    return res.json(await getEconomicCalendar(today, to));
  } catch (err) {
    console.error("[macro] events fetch failed:", err);
    return res.json(ECONOMIC_EVENTS.filter((e) => e.date >= today));
  }
});

/** Watchlist next report dates — requester's own watchlist only (A235; was union of all users). */
router.get("/watchlist-earnings", requireAuth, async (req: Request, res: Response) => {
  try {
    const { getUserWatchlistTickers } = await import("../lib/watchlist-tickers.js");
    const { getUpcomingEarningsDates } = await import("../lib/earnings-history.js");
    const tickers = await getUserWatchlistTickers(req.session.userId!);
    const dates = await getUpcomingEarningsDates(tickers);
    const rows = Object.entries(dates)
      .filter((entry): entry is [string, string] => entry[1] != null && entry[1] !== "")
      .map(([ticker, date]) => ({ ticker, date }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker))
      .slice(0, 60);
    return res.json({ earnings: rows });
  } catch (err) {
    console.error("[macro] watchlist-earnings failed:", err);
    return res.json({ earnings: [] });
  }
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

/** A85 — Voices: figure registry + latest views (Phase 1; Brier badges Phase 2). */
router.get("/voices", async (_req: Request, res: Response) => {
  try {
    const { getVoicesSummary } = await import("../lib/figure-views.js");
    const voices = await getVoicesSummary();
    res.json({
      voices,
      note: "A85 — registry + Fed ingest + Brier when views resolved (skill badge n≥8).",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** A85 — resolve a view for Brier (admin). Body: id, outcome hit|miss, forecastP? */
router.post("/voices/resolve", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { resolveView } = await import("../lib/figure-views.js");
    const id = Number(req.body?.id);
    const outcome = String(req.body?.outcome ?? "");
    if (!Number.isFinite(id) || (outcome !== "hit" && outcome !== "miss")) {
      res.status(400).json({ error: "id + outcome hit|miss required" });
      return;
    }
    await resolveView({
      id,
      outcome: outcome as "hit" | "miss",
      forecastP: req.body?.forecastP != null ? Number(req.body.forecastP) : null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

/** A85 — manual view ingest (admin). Body: figureId, asOf, claim, asset?, direction?, horizon?, confidence?, sourceUrl? */
router.post("/voices", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { insertView } = await import("../lib/figure-views.js");
    const b = req.body ?? {};
    if (!b.figureId || !b.asOf || !b.claim) {
      res.status(400).json({ error: "figureId, asOf, claim required" });
      return;
    }
    const id = await insertView({
      figureId: String(b.figureId),
      asOf: String(b.asOf).slice(0, 10),
      claim: String(b.claim),
      asset: b.asset != null ? String(b.asset) : null,
      direction: b.direction != null ? String(b.direction) : null,
      horizon: b.horizon != null ? String(b.horizon) : null,
      confidence: b.confidence != null ? Number(b.confidence) : null,
      sourceUrl: b.sourceUrl != null ? String(b.sourceUrl) : null,
    });
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

/** A85 — pull Fed speeches RSS into figure_views (admin / scheduler). */
router.post("/voices/ingest", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ingestFedSpeeches } = await import("../lib/figure-views-ingest.js");
    const dryRun = Boolean(req.body?.dryRun);
    const result = await ingestFedSpeeches({ dryRun, limit: Number(req.body?.limit) || 40 });
    res.json({ ...result, note: "Fed speeches RSS only; Substack/YT later." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** A85 — auto-resolve open views vs prices_historical at horizon. */
router.post("/voices/auto-resolve", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { autoResolveOpenViews } = await import("../lib/figure-views-auto-resolve.js");
    const dryRun = Boolean(req.body?.dryRun);
    const result = await autoResolveOpenViews({
      dryRun,
      limit: Number(req.body?.limit) || 80,
    });
    res.json({ ...result, note: "Needs direction+horizon+mappable asset; TLT proxies rates." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /macro/risk-free-rate — returns SOFR (or fedFundsRate fallback) from macro cache for scoring
router.get("/risk-free-rate", (_req: Request, res: Response) => {
  const data = loadMacroCache();
  if (!data) {
    res.json({ riskFreeRate: null });
    return;
  }
  const rate = data.series.sofr?.value ?? data.series.fedFundsRate?.value ?? null;
  // FRED returns rates as percentage points (e.g. 5.33 for 5.33%) — convert to decimal for scoring
  res.json({ riskFreeRate: rate !== null ? rate / 100 : null });
});

/**
 * A98 P1 — SSGA NAV hist fund flows (Δshares × NAV).
 * GET /macro/etf-flows?etfs=XLK,XLF&days=30
 */
router.get("/etf-flows", async (req: Request, res: Response) => {
  try {
    const { pool } = await import("@workspace/db");
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
    const raw = String(req.query.etfs ?? "XLB,XLE,XLF,XLI,XLK,XLP,XLU,XLV,XLY,XLRE,XLC");
    const etfs = raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2,5}$/.test(s)).slice(0, 40);
    if (!etfs.length) {
      res.status(400).json({ error: "etfs required" });
      return;
    }
    const r = await pool.query(
      `SELECT etf, date::text, nav, shares, flow_usd, aum, source
       FROM watchlist_sync.etf_flows
       WHERE etf = ANY($1::text[])
         AND date >= (CURRENT_DATE - $2::int)
       ORDER BY etf, date`,
      [etfs, days],
    );
    const byEtf: Record<string, typeof r.rows> = {};
    for (const row of r.rows) {
      (byEtf[row.etf] ??= []).push(row);
    }
    const summary = etfs.map((etf) => {
      const rows = byEtf[etf] ?? [];
      const flowSum = rows.reduce((s: number, x: { flow_usd: number }) => s + Number(x.flow_usd), 0);
      const last = rows[rows.length - 1];
      const aum = last ? Number(last.aum) : null;
      return {
        etf,
        days: rows.length,
        flowUsd: flowSum,
        flowPctAum: aum && aum > 0 ? (flowSum / aum) * 100 : null,
        lastDate: last?.date ?? null,
      };
    });
    res.json({
      days,
      summary,
      series: byEtf,
      note: "SSGA navhist: flow_usd ≈ Δshares × NAV. Display / research — not a Model List input (A98).",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * A98 P3 — per-ticker ETF bid ≈ Σ (ETF flow_usd over window × latest weight).
 * GET /macro/etf-bid?tickers=NVDA,AAPL&days=20
 * Weights from latest watchlist_sync.etf_holdings snapshot per ETF (monthly OK).
 */
router.get("/etf-bid", async (req: Request, res: Response) => {
  try {
    const { pool } = await import("@workspace/db");
    const days = Math.min(120, Math.max(1, Number(req.query.days) || 20));
    const raw = String(req.query.tickers ?? "");
    const tickers = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z.]{1,8}$/.test(s))
      .slice(0, 80);
    if (!tickers.length) {
      res.status(400).json({ error: "tickers required" });
      return;
    }
    const r = await pool.query(
      `WITH latest_h AS (
         SELECT DISTINCT ON (etf, ticker)
                etf, ticker, as_of, weight_pct
         FROM watchlist_sync.etf_holdings
         WHERE ticker = ANY($1::text[])
         ORDER BY etf, ticker, as_of DESC
       ),
       flows AS (
         SELECT etf, SUM(flow_usd)::float8 AS flow_usd
         FROM watchlist_sync.etf_flows
         WHERE date >= (CURRENT_DATE - $2::int)
         GROUP BY etf
       )
       SELECT h.ticker,
              SUM(f.flow_usd * (h.weight_pct / 100.0))::float8 AS bid_usd,
              COUNT(*)::int AS etf_n,
              MAX(h.as_of)::text AS holdings_as_of
       FROM latest_h h
       JOIN flows f ON f.etf = h.etf
       GROUP BY h.ticker
       ORDER BY bid_usd DESC NULLS LAST`,
      [tickers, days],
    );
    res.json({
      days,
      tickers,
      rows: r.rows.map((row) => ({
        ticker: row.ticker as string,
        bidUsd: row.bid_usd != null ? Number(row.bid_usd) : null,
        etfN: Number(row.etf_n),
        holdingsAsOf: row.holdings_as_of as string | null,
      })),
      note: "ETF bid ≈ Σ flow_usd × weight (latest SSGA holdings). Display only — not Model List (A98 P3).",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * A95 — LSEG EPS + PT revision breadth by sector (display only until S0xx).
 * GET /macro/revision-breadth?days=60
 * EPS breadth = (# eps_drift_30d_pct > +1%) − (# < −1%).
 * PT breadth = same on 30d % change in pt_mean (needs ≥30d history per name).
 */
router.get("/revision-breadth", async (req: Request, res: Response) => {
  try {
    const { pool } = await import("@workspace/db");
    const days = Math.min(400, Math.max(7, Number(req.query.days) || 60));
    type BreadthPt = {
      date: string; n: number; up: number; down: number; breadth: number; medianDrift: number | null;
    };
    const pack = (rows: Array<Record<string, unknown>>): Record<string, BreadthPt[]> => {
      const out: Record<string, BreadthPt[]> = {};
      for (const row of rows) {
        const sector = String(row.sector);
        (out[sector] ??= []).push({
          date: String(row.date),
          n: Number(row.n),
          up: Number(row.up),
          down: Number(row.down),
          breadth: Number(row.up) - Number(row.down),
          medianDrift: row.mediandrift != null ? Number(row.mediandrift) : null,
        });
      }
      return out;
    };

    const r = await pool.query(
      `WITH base AS (
         SELECT d.as_of::text AS date,
                COALESCE(NULLIF(TRIM(reg.sector), ''), 'Unknown') AS sector,
                d.eps_drift_30d_pct::float8 AS drift
         FROM lseg_research.signals_daily d
         LEFT JOIN ticker_registry reg ON reg.ticker = d.ticker
         WHERE d.as_of >= (CURRENT_DATE - $1::int)
           AND d.eps_drift_30d_pct IS NOT NULL
       )
       SELECT date, sector,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE drift > 1)::int AS up,
              COUNT(*) FILTER (WHERE drift < -1)::int AS down,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY drift)::float8 AS medianDrift
       FROM base
       GROUP BY date, sector
       ORDER BY date, sector`,
      [days],
    );
    const bySector = pack(r.rows as Array<Record<string, unknown>>);

    const rpt = await pool.query(
      `WITH pts AS (
         SELECT d.as_of,
                d.ticker,
                d.pt_mean::float8 AS pt,
                COALESCE(NULLIF(TRIM(reg.sector), ''), 'Unknown') AS sector
         FROM lseg_research.signals_daily d
         LEFT JOIN ticker_registry reg ON reg.ticker = d.ticker
         WHERE d.as_of >= (CURRENT_DATE - ($1::int + 45))
           AND d.pt_mean IS NOT NULL AND d.pt_mean > 0
       ),
       lagged AS (
         SELECT a.as_of::text AS date,
                a.sector,
                CASE WHEN b.pt > 0 THEN (a.pt / b.pt - 1.0) * 100.0 ELSE NULL END AS drift
         FROM pts a
         LEFT JOIN LATERAL (
           SELECT p.pt FROM pts p
           WHERE p.ticker = a.ticker AND p.as_of <= a.as_of - 30
           ORDER BY p.as_of DESC
           LIMIT 1
         ) b ON true
         WHERE a.as_of >= (CURRENT_DATE - $1::int)
       )
       SELECT date, sector,
              COUNT(*) FILTER (WHERE drift IS NOT NULL)::int AS n,
              COUNT(*) FILTER (WHERE drift > 1)::int AS up,
              COUNT(*) FILTER (WHERE drift < -1)::int AS down,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY drift)
                FILTER (WHERE drift IS NOT NULL)::float8 AS medianDrift
       FROM lagged
       GROUP BY date, sector
       HAVING COUNT(*) FILTER (WHERE drift IS NOT NULL) > 0
       ORDER BY date, sector`,
      [days],
    );
    const bySectorPt = pack(rpt.rows as Array<Record<string, unknown>>);
    const ev = await pool.query(
      `SELECT a.event_date::text AS date,
              a.ticker,
              a.firm,
              lower(a.action) AS action,
              a.from_grade,
              a.to_grade,
              COALESCE(NULLIF(TRIM(reg.sector), ''), 'Unknown') AS sector
       FROM analyst_events a
       LEFT JOIN ticker_registry reg ON reg.ticker = a.ticker
       WHERE a.event_date >= (CURRENT_DATE - $1::int)
         AND lower(a.action) IN ('upgrade', 'downgrade')
       ORDER BY a.event_date DESC
       LIMIT 400`,
      [days],
    );
    const events = ev.rows.map((row) => ({
      date: row.date as string,
      ticker: row.ticker as string,
      firm: row.firm as string | null,
      action: row.action as "upgrade" | "downgrade",
      fromGrade: row.from_grade as string | null,
      toGrade: row.to_grade as string | null,
      sector: row.sector as string,
    }));

    res.json({
      days,
      bySector,
      bySectorPt,
      events,
      note: "LSEG EPS + PT 30d drift breadth + rating up/down dots (maintain/reiterate/initiate excluded). Display only (A95).",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
