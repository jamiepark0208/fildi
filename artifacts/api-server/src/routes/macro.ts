import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  fetchMacroData,
  loadMacroCache,
  saveMacroCache,
  isCacheStale,
  FED_MEMBERS,
  ECONOMIC_EVENTS,
  MacroData,
} from "../lib/macro-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

const HIGHLIGHTS_FILE = join(ROOT, "macro-highlights.json");

const router = Router();

// GET /macro/data
router.get("/data", async (_req: Request, res: Response) => {
  let cached = loadMacroCache();

  if (cached && !isCacheStale(cached, 4)) {
    return res.json(cached);
  }

  try {
    const fresh = await fetchMacroData();
    saveMacroCache(fresh);
    return res.json(fresh);
  } catch (err) {
    console.error("[macro] fetchMacroData failed:", err);
    if (cached) {
      return res.json(cached);
    }
    return res.status(500).json({ error: "Failed to fetch macro data and no cache available" });
  }
});

// POST /macro/refresh
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

// GET /macro/highlights
router.get("/highlights", (_req: Request, res: Response) => {
  try {
    if (!existsSync(HIGHLIGHTS_FILE)) {
      return res.json({ noData: true });
    }
    const raw = readFileSync(HIGHLIGHTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { content: string; generatedAt: string };
    return res.json(parsed);
  } catch {
    return res.json({ noData: true });
  }
});

// POST /macro/highlights/generate
router.post("/highlights/generate", async (_req: Request, res: Response) => {
  try {
    let macroData: MacroData | null = loadMacroCache();
    if (!macroData) {
      macroData = await fetchMacroData();
      saveMacroCache(macroData);
    }

    const s = macroData.series;

    const formatSeries = (label: string, series: typeof s.cpi) => {
      const val = series.value !== null ? series.value.toFixed(2) : "N/A";
      const chg = series.change !== null ? `(${series.change >= 0 ? "+" : ""}${series.change.toFixed(2)})` : "";
      return `${label}: ${val}${series.unit ? " " + series.unit : ""} ${chg}`.trim();
    };

    const prompt = `You are a concise macro analyst writing for an options trader who sells weekly OTM puts.

Current macro snapshot (as of ${macroData.fetchedAt.slice(0, 10)}):

MARKET CONDITIONS:
- VIX: ${macroData.vix.value?.toFixed(2) ?? "N/A"} (level: ${macroData.vix.level})
- 10Y Yield: ${macroData.yield10y.value?.toFixed(3) ?? "N/A"}%
- 2Y Yield: ${macroData.yield2y.value?.toFixed(3) ?? "N/A"}%
- Yield Spread (10y-2y): ${macroData.yieldSpread?.toFixed(0) ?? "N/A"} bps

ECONOMIC DATA:
- ${formatSeries("CPI", s.cpi)}
- ${formatSeries("Core CPI", s.coreCpi)}
- ${formatSeries("Core PCE", s.corePce)}
- ${formatSeries("PPI", s.ppi)}
- ${formatSeries("Unemployment", s.unemployment)}
- ${formatSeries("Nonfarm Payrolls", s.nonfarmPayrolls)}
- ${formatSeries("JOLTS Openings", s.jolts)}
- ${formatSeries("Real GDP Growth", s.gdp)}
- ${formatSeries("Retail Sales", s.retailSales)}
- ${formatSeries("Consumer Sentiment", s.consumerSentiment)}
- ${formatSeries("Fed Funds Rate", s.fedFundsRate)}

Write exactly 4 markdown bullet points (starting with -) covering:
1. Inflation trajectory and Fed policy implications
2. Labor market health
3. Growth outlook
4. Key risks and opportunities for an options seller (put seller) in this environment

Be specific, cite the numbers, and keep each bullet to 1-2 sentences. No intro or outro text — just the 4 bullets.`;

    const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });

    const content =
      message.content[0].type === "text" ? message.content[0].text : "";

    const result = {
      content,
      generatedAt: new Date().toISOString(),
    };

    writeFileSync(HIGHLIGHTS_FILE, JSON.stringify(result, null, 2), "utf-8");

    return res.json(result);
  } catch (err) {
    console.error("[macro] highlights/generate failed:", err);
    return res.status(500).json({ error: "Failed to generate macro highlights" });
  }
});

// GET /macro/fed-members
router.get("/fed-members", (_req: Request, res: Response) => {
  return res.json(FED_MEMBERS);
});

// GET /macro/events
router.get("/events", (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = ECONOMIC_EVENTS.filter((e) => e.date >= today);
  return res.json(upcoming);
});

export default router;
