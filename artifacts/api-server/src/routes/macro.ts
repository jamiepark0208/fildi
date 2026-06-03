import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  fetchMacroData,
  fetchMacroCharts,
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
  MacroData,
  BankResearch,
} from "../lib/macro-data.js";

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

// ── Highlights ────────────────────────────────────────────────────────────────

router.get("/highlights", (_req: Request, res: Response) => {
  try {
    if (!existsSync(HIGHLIGHTS_FILE)) return res.json({ noData: true });
    const parsed = JSON.parse(readFileSync(HIGHLIGHTS_FILE, "utf-8")) as {
      content: string;
      generatedAt: string;
    };
    return res.json(parsed);
  } catch {
    return res.json({ noData: true });
  }
});

router.post("/highlights/generate", async (_req: Request, res: Response) => {
  try {
    let macroData: MacroData | null = loadMacroCache();
    if (!macroData) {
      macroData = await fetchMacroData();
      saveMacroCache(macroData);
    }
    const s = macroData.series;

    // Use YoY for price-index series, raw value for rates
    const fmtPct  = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : "N/A");
    const fmtRate = (v: number | null) => (v != null ? `${v.toFixed(2)}%` : "N/A");
    const fmtK    = (v: number | null) => (v != null ? `${v.toLocaleString()}K` : "N/A");

    const prompt = `You are a concise macro analyst writing for an options trader who sells weekly OTM puts.

Current macro snapshot (as of ${macroData.fetchedAt.slice(0, 10)}):

MARKET CONDITIONS:
- VIX: ${macroData.vix.value?.toFixed(2) ?? "N/A"} (${macroData.vix.level})
- SKEW: ${macroData.skew.value?.toFixed(1) ?? "N/A"}
- 10Y Yield: ${fmtRate(macroData.yield10y.value)}
- 2Y Yield: ${fmtRate(macroData.yield2y.value)}
- Yield Spread (10y-2y): ${macroData.yieldSpread?.toFixed(0) ?? "N/A"} bps
- US Federal Debt: ${macroData.usDebt ? "$" + (macroData.usDebt / 1_000_000).toFixed(1) + "T" : "N/A"}

INFLATION (YoY %):
- CPI: ${fmtPct(s.cpi.yoy)} YoY | MoM Δ: ${s.cpi.change?.toFixed(2) ?? "N/A"}
- Core CPI: ${fmtPct(s.coreCpi.yoy)} YoY
- Core PCE (Fed preferred): ${fmtPct(s.corePce.yoy)} YoY
- PPI: ${fmtPct(s.ppi.yoy)} YoY

LABOR:
- Unemployment Rate: ${fmtRate(s.unemployment.value)} (Δ ${s.unemployment.change?.toFixed(2) ?? "N/A"})
- Nonfarm Payrolls: ${fmtK(s.nonfarmPayrolls.value)} (MoM Δ ${fmtK(s.nonfarmPayrolls.change)})
- JOLTS Openings: ${fmtK(s.jolts.value)}

GROWTH / CONSUMER:
- Real GDP Growth: ${fmtRate(s.gdp.value)} (annualized)
- Retail Sales: $${s.retailSales.value ? (s.retailSales.value / 1000).toFixed(1) + "B" : "N/A"} (YoY ${fmtPct(s.retailSales.yoy)})
- Consumer Sentiment: ${s.consumerSentiment.value?.toFixed(1) ?? "N/A"}

POLICY:
- Fed Funds Rate: ${fmtRate(s.fedFundsRate.value)}

Write exactly 4 markdown bullet points (starting with -) covering:
1. Inflation trajectory and Fed policy implications
2. Labor market health
3. Growth / consumer outlook
4. Key risks and opportunities for a weekly OTM put seller

Be specific, cite the numbers, and keep each bullet to 1-2 sentences. No intro or outro — just the 4 bullets.`;

    const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });

    const content =
      message.content[0].type === "text" ? message.content[0].text : "";
    const result = { content, generatedAt: new Date().toISOString() };
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
      // If parse fails, return existing
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
