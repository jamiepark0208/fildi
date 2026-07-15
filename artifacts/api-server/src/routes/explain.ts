import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { eq, and } from "drizzle-orm";
import { db, explainCache } from "@workspace/db";
import { assembleContext, type ContextBundle } from "../lib/explain-context.js";
import { generateExplanation, type ExplainSurface } from "../lib/ai-explain.js";

const router  = Router();
const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

// ── Types ─────────────────────────────────────────────────────────────────────

interface FundamentalData {
  totalScore:     number;
  rank:           number;
  familyScores:   { value: number; growth: number; quality: number; safety: number };
  topMetrics:     string[];
  weakMetrics:    string[];
  reason:         string;
  suspectMetrics?: string[];
  dataQuality?:   string;
  sector?:        string;
  industry?:      string;
  metricValues?:  Record<string, number | null>;
}

interface TechnicalData {
  totalScore:      number;
  rank:            number;
  signal:          string;
  regime:          string;
  componentScores: {
    oversoldDepth:   number;
    reversalSignal:  number;
    volatilityState: number;
    trendContext:    number;
    optionsFlow:     number;
    volumeConfirm:   number;
  };
  rsi14:            number;
  rsi14Pct:         number;
  ivRank:           number;
  ivVsRealizedVol:  number;
  macdDirection:    string;
  fallingKnife:     boolean;
  earningsDaysOut:  number | null;
  reason:           string;
}

interface ExplainRequest {
  ticker:           string;
  scoreType:        "fundamental" | "technical";
  fundamentalData?: FundamentalData;
  technicalData?:   TechnicalData;
}

// ── Score hash — deterministic fingerprint of key inputs ──────────────────────
// Increment PROMPT_VERSION when prompt copy changes to bust the cache globally.
const PROMPT_VERSION = "v3";

function fundamentalHash(d: FundamentalData): string {
  const fs = d.familyScores;
  return `${PROMPT_VERSION}_${d.totalScore.toFixed(1)}_${fs.value.toFixed(0)}_${fs.growth.toFixed(0)}_${fs.quality.toFixed(0)}_${fs.safety.toFixed(0)}`;
}

function technicalHash(d: TechnicalData): string {
  return `${PROMPT_VERSION}_${d.totalScore.toFixed(1)}_${d.signal}_${d.regime}`;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildFundamentalPrompt(ticker: string, d: FundamentalData): string {
  const suspectNote = d.suspectMetrics?.length
    ? `Caution: ${d.suspectMetrics.join(", ")} may be unreliable.`
    : "";
  const qualityNote = d.dataQuality && d.dataQuality !== "good"
    ? `Data coverage: ${d.dataQuality}.`
    : "";

  const sectorCtx = d.sector ? `Sector: ${d.sector}${d.industry ? ` / ${d.industry}` : ""}` : "";

  const metricLines = d.metricValues
    ? Object.entries(d.metricValues)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `  ${k}: ${(v as number).toFixed(2)}`)
        .join("\n")
    : "";

  return `You explain stock fundamentals to a smart non-expert — like a knowledgeable friend, not a textbook. Be vivid and specific. Skip anything unremarkable; only explain what stands out.

Ticker: ${ticker}
${sectorCtx}
Score: ${d.totalScore.toFixed(1)}/100 — rank #${d.rank} in the universe (top ${((d.rank / 256) * 100).toFixed(0)}% is worse, so this is genuinely exceptional or genuinely weak depending on rank)
Pillar scores — Value: ${d.familyScores.value.toFixed(0)}/100 | Growth: ${d.familyScores.growth.toFixed(0)}/100 | Quality: ${d.familyScores.quality.toFixed(0)}/100 | Safety: ${d.familyScores.safety.toFixed(0)}/100
Top strengths: ${d.topMetrics.join(", ") || "none"}
Top weaknesses: ${d.weakMetrics.join(", ") || "none"}
${metricLines ? `\nKey metrics:\n${metricLines}` : ""}
${suspectNote}${qualityNote ? "\n" + qualityNote : ""}

Write exactly 3 bullet points (starting with -). Rules:
- Each bullet: max 12 words + one parenthetical with the key number and peer context
- Format: "[what it means for a put seller] (value vs benchmark)"
- Example: "Exceptional cash generation, reduces default risk (FCF margin 28% vs 12% peers)"
- Only the 3 most significant drivers — skip anything near average

No intro. No outro. No investment advice.`;
}

function buildTechnicalPrompt(ticker: string, d: TechnicalData): string {
  const oversoldLabel = d.rsi14Pct < 20 ? "deeply oversold vs own history"
    : d.rsi14Pct < 40 ? "oversold vs own history"
    : d.rsi14Pct > 80 ? "overbought vs own history"
    : "neutral vs own history";

  const earningsNote = d.earningsDaysOut != null
    ? `Earnings in ${d.earningsDaysOut} days.`
    : "No near-term earnings.";

  const cs = d.componentScores;
  return `You explain a stock's technical setup to a smart non-expert — like a knowledgeable friend, not a textbook. Be vivid. Skip unremarkable readings; only explain what stands out.

Ticker: ${ticker}
Signal: ${d.signal} | Macro regime: ${d.regime}
Score: ${d.totalScore.toFixed(1)}/100 — rank #${d.rank} in universe
RSI: ${d.rsi14.toFixed(1)} — at the ${d.rsi14Pct.toFixed(0)}th percentile of its own 1-year history (${oversoldLabel})
IV rank: ${d.ivRank.toFixed(0)}/100 | IV vs realized: ${d.ivVsRealizedVol.toFixed(2)}x
MACD: ${d.macdDirection} | Falling knife: ${d.fallingKnife ? "YES — price momentum sharply negative" : "no"}
${earningsNote}
Component scores (0–1): oversold depth ${cs.oversoldDepth.toFixed(2)} | reversal signal ${cs.reversalSignal.toFixed(2)} | vol state ${cs.volatilityState.toFixed(2)} | trend ${cs.trendContext.toFixed(2)}

Write exactly 2 bullets (starting with -). Rules:
- Each bullet: max 12 words + one parenthetical with the key number
- Format: "[what this means for selling a put] (value, context)"
- Example: "Oversold vs own history, good entry timing (RSI 28, bottom 15%)"
- Lead with any key risk (earnings, falling knife, overbought IV)

No intro. No outro. No investment advice.`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

// POST /api/explain/score — generate AI explanation for a ticker's score.
// Checks explain_cache first; only calls Haiku on a cache miss.
router.post("/explain/score", async (req, res) => {
  const { ticker, scoreType, fundamentalData, technicalData } = req.body as ExplainRequest;

  if (!ticker || !scoreType) {
    return res.status(400).json({ error: "ticker and scoreType are required" });
  }

  let prompt: string;
  let scoreHash: string;

  const log = req.log.child({ ticker, scoreType });

  try {
    if (scoreType === "fundamental") {
      if (!fundamentalData) return res.status(400).json({ error: "fundamentalData required" });
      prompt = buildFundamentalPrompt(ticker, fundamentalData);
      scoreHash = fundamentalHash(fundamentalData);
    } else {
      if (!technicalData) return res.status(400).json({ error: "technicalData required" });
      prompt = buildTechnicalPrompt(ticker, technicalData);
      scoreHash = technicalHash(technicalData);
    }

    log.info({ scoreHash, step: "cache-lookup" }, "explain: checking DB cache");

    const cached = await db.select()
      .from(explainCache)
      .where(and(
        eq(explainCache.ticker, ticker),
        eq(explainCache.scoreType, scoreType),
        eq(explainCache.scoreHash, scoreHash),
      ))
      .limit(1);

    if (cached.length > 0) {
      log.info({ step: "cache-hit" }, "explain: serving from cache");
      return res.json({ explanation: cached[0].explanation, cached: true });
    }

    const hasApiKey = !!process.env["ANTHROPIC_API_KEY"];
    log.info({ step: "anthropic-call", hasApiKey, model: "claude-haiku-4-5-20251001" }, "explain: calling Haiku");

    const msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    });

    const explanation = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    log.info({ step: "anthropic-ok", chars: explanation.length }, "explain: got response");

    log.info({ step: "db-upsert" }, "explain: persisting to cache");
    await db.insert(explainCache)
      .values({ ticker, scoreType, scoreHash, explanation })
      .onConflictDoUpdate({
        target: [explainCache.ticker, explainCache.scoreType],
        set: { scoreHash, explanation, generatedAt: new Date() },
      });

    return res.json({ explanation });
  } catch (err) {
    log.error({ err, step: "failed" }, "explain/score error");
    return res.status(500).json({ error: String(err) });
  }
});

// ── Options scanner surface ────────────────────────────────────────────────────
// Replaces the scanner's hardcoded "RSI X above threshold Y" template with a real
// per-ticker explanation — same cache-by-hash + Haiku pattern as above, generalized
// via generateExplanation so future surfaces (breakdown, brief) don't reinline it.

interface OptionsExtra {
  rsi:        number;
  mfi:        number;
  signal:     "GO" | "WATCH" | "NO";
  tier:       1 | 2 | 3;
  ivCurrent:  number | null;
  vsSpy20d:   number | null;
}

const TIER_WIN_RATE: Record<1 | 2 | 3, string> = { 1: "≥92%", 2: "≥94%", 3: "≥97%" };

function optionsHash(bundle: ContextBundle, e: OptionsExtra): string {
  // Round to the UTC day so market/sector context regenerates at most once a day —
  // this is a daily-summary surface, not a live feed (see plan risk #2).
  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  return `v1_${dayBucket}_${e.rsi.toFixed(1)}_${e.mfi.toFixed(1)}_${e.signal}_${bundle.stockEvent?.priceZScore ?? "na"}_${bundle.marketEvent?.volRegime ?? "na"}_${bundle.marketEvent?.sector?.quadrant ?? "na"}`;
}

function buildOptionsPrompt(bundle: ContextBundle, e: OptionsExtra): string {
  const se = bundle.stockEvent;
  const me = bundle.marketEvent;

  const zscoreLine = se?.priceZScore != null
    ? `Recent price move: ${se.priceZScore.toFixed(1)} standard deviations from its own 20-day average (${Math.abs(se.priceZScore) >= 1.5 ? "an outlier move" : "within normal range"}).`
    : "Recent price move: not enough history to compute.";

  const newsLines = se?.recentNews?.length
    ? se.recentNews.map(n => `- ${n.title} (${n.source})`).join("\n")
    : "No recent notable news found.";

  const sectorLine = me?.sector
    ? `Sector (${me.sector.label}) is in a "${me.sector.quadrant}" RRG quadrant, ${me.sector.rs1m != null ? `${me.sector.rs1m > 0 ? "+" : ""}${me.sector.rs1m.toFixed(1)}pp vs SPY over 1 month` : "relative strength unavailable"}.`
    : "Sector context unavailable.";

  const volLine = me?.volRegime ? `Market volatility regime: ${me.volRegime.replace("_", " ").toLowerCase()}.` : "";

  return `You explain a cash-secured-put candidate to an options seller who wants recent, specific context — not a repeat of numbers they can already see on screen. Be concrete about WHY this ticker looks interesting right now, not just that a threshold was crossed.

Ticker: ${bundle.ticker}
Signal: ${e.signal} (Tier ${e.tier}, ${TIER_WIN_RATE[e.tier]} historical win rate) | RSI ${e.rsi.toFixed(1)} vs threshold | MFI ${e.mfi.toFixed(1)}
${e.ivCurrent != null ? `IV: ${e.ivCurrent.toFixed(0)}%` : ""}${e.vsSpy20d != null ? ` | vs SPY 20d: ${e.vsSpy20d > 0 ? "+" : ""}${e.vsSpy20d.toFixed(1)}%` : ""}
${zscoreLine}
${sectorLine}
${volLine}
Recent news:
${newsLines}

Write exactly 2 bullets (starting with -). Rules:
- Lead with the most decision-relevant fact: an outlier move, a sector rotation, or a specific news catalyst — whichever is most relevant, not always the same one
- Each bullet under 20 words
- No intro, no outro, no investment advice, no repeating the raw RSI/MFI numbers already shown above`;
}

const optionsSurface: ExplainSurface<OptionsExtra> = {
  surfaceType:  "options",
  promptVersion: "v1",
  buildPrompt:  buildOptionsPrompt,
  hashInputs:   optionsHash,
};

router.post("/explain/options", async (req, res) => {
  const { ticker, rsi, mfi, signal, tier, ivCurrent, vsSpy20d } = req.body as { ticker?: string } & Partial<OptionsExtra>;

  if (!ticker || rsi == null || mfi == null || !signal || !tier) {
    return res.status(400).json({ error: "ticker, rsi, mfi, signal, and tier are required" });
  }

  const log = req.log.child({ ticker, surfaceType: "options" });

  try {
    const bundle = await assembleContext(ticker, { include: ["stockEvent", "marketEvent"] });
    const result = await generateExplanation(
      ticker.toUpperCase(),
      optionsSurface,
      bundle,
      { rsi, mfi, signal, tier, ivCurrent: ivCurrent ?? null, vsSpy20d: vsSpy20d ?? null },
      log,
    );
    return res.json(result);
  } catch (err) {
    log.error({ err, step: "failed" }, "explain/options error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
