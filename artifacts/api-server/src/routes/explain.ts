import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { eq, and } from "drizzle-orm";
import { db, explainCache } from "@workspace/db";

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
// Changes when the score changes → cache miss → fresh Haiku call

function fundamentalHash(d: FundamentalData): string {
  const fs = d.familyScores;
  return `${d.totalScore.toFixed(1)}_${fs.value.toFixed(0)}_${fs.growth.toFixed(0)}_${fs.quality.toFixed(0)}_${fs.safety.toFixed(0)}`;
}

function technicalHash(d: TechnicalData): string {
  return `${d.totalScore.toFixed(1)}_${d.signal}_${d.regime}`;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildFundamentalPrompt(ticker: string, d: FundamentalData): string {
  const suspectNote = d.suspectMetrics?.length
    ? `Note: ${d.suspectMetrics.join(", ")} flagged as potentially unreliable data.`
    : "";
  const qualityNote = d.dataQuality && d.dataQuality !== "good"
    ? `Data quality: ${d.dataQuality}.`
    : "";

  const sectorCtx = d.sector ? `Sector: ${d.sector}${d.industry ? ` / ${d.industry}` : ""}` : "";

  const metricLines = d.metricValues
    ? Object.entries(d.metricValues)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `  ${k}: ${(v as number).toFixed(2)}`)
        .join("\n")
    : "";

  return `You are a senior equity analyst writing a concise but substantive explanation of a stock's fundamental score for an options trader. Be specific, cite actual numbers, and compare them to typical sector/industry benchmarks where relevant (e.g. "P/E of 12x vs. sector average ~18x").

Ticker: ${ticker}
${sectorCtx}
Overall score: ${d.totalScore.toFixed(1)}/100 (rank #${d.rank} out of the comparison group)
Family scores — Value: ${d.familyScores.value.toFixed(0)}/100 | Growth: ${d.familyScores.growth.toFixed(0)}/100 | Quality: ${d.familyScores.quality.toFixed(0)}/100 | Safety: ${d.familyScores.safety.toFixed(0)}/100
Strengths: ${d.topMetrics.join(", ") || "none identified"}
Weaknesses: ${d.weakMetrics.join(", ") || "none identified"}
${metricLines ? `\nActual metric values:\n${metricLines}` : ""}
${suspectNote}${qualityNote ? "\n" + qualityNote : ""}

Write 3–4 bullet points (starting with -) explaining WHY ${ticker} scores this way. Each bullet should:
- Name a specific metric with its actual value
- Compare it to what's typical for the sector/industry (e.g. "vs. tech sector median ~25x P/E")
- State whether this is a strength or concern and why it matters for an options seller

Be direct and informative. No intro or outro. No investment advice.`;
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
  return `You are a technical analyst explaining a stock's technical setup to a trader in 2-3 clear sentences. Focus on what the signals mean for near-term price action and entry timing for selling cash-secured puts. Do not give investment advice.

Ticker: ${ticker}
Signal: ${d.signal} | Regime: ${d.regime}
Overall score: ${d.totalScore.toFixed(1)}/100 (rank #${d.rank} out of 31)
RSI: ${d.rsi14.toFixed(1)} (at ${d.rsi14Pct.toFixed(0)}th percentile of own history — ${oversoldLabel})
IV rank: ${d.ivRank.toFixed(0)} | IV vs realized vol: ${d.ivVsRealizedVol.toFixed(2)}x
MACD: ${d.macdDirection} | Falling knife: ${d.fallingKnife ? "yes (caution)" : "no"}
${earningsNote}
Component breakdown: oversold ${(cs.oversoldDepth * 100).toFixed(0)}%, reversal ${(cs.reversalSignal * 100).toFixed(0)}%, volatility ${(cs.volatilityState * 100).toFixed(0)}%, trend ${(cs.trendContext * 100).toFixed(0)}%

Write a 2-3 sentence explanation of what this technical setup means for ${ticker} right now. Include what is driving the signal and any key risks or caveats.`;
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

    // Cache hit: same ticker+scoreType and score hasn't changed
    const cached = await db.select()
      .from(explainCache)
      .where(and(
        eq(explainCache.ticker, ticker),
        eq(explainCache.scoreType, scoreType),
        eq(explainCache.scoreHash, scoreHash),
      ))
      .limit(1);

    if (cached.length > 0) {
      return res.json({ explanation: cached[0].explanation, cached: true });
    }

    // Cache miss: call Haiku
    const msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages:   [{ role: "user", content: prompt }],
    });

    const explanation = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";

    // Persist — upsert so stale rows for the same ticker+scoreType are replaced
    await db.insert(explainCache)
      .values({ ticker, scoreType, scoreHash, explanation })
      .onConflictDoUpdate({
        target: [explainCache.ticker, explainCache.scoreType],
        set: { scoreHash, explanation, generatedAt: new Date() },
      });

    return res.json({ explanation });
  } catch {
    return res.json({ explanation: "Unable to generate explanation at this time." });
  }
});

export default router;
