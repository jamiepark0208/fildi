import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

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

// POST /api/explain/score — generate AI explanation for a ticker's score
router.post("/explain/score", async (req, res) => {
  const { ticker, scoreType, fundamentalData, technicalData } = req.body as ExplainRequest;

  if (!ticker || !scoreType) {
    return res.status(400).json({ error: "ticker and scoreType are required" });
  }

  let prompt: string;
  try {
    if (scoreType === "fundamental") {
      if (!fundamentalData) return res.status(400).json({ error: "fundamentalData required" });
      prompt = buildFundamentalPrompt(ticker, fundamentalData);
    } else {
      if (!technicalData) return res.status(400).json({ error: "technicalData required" });
      prompt = buildTechnicalPrompt(ticker, technicalData);
    }

    const msg = await anthropic.messages.create({
      model:    "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const explanation = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    return res.json({ explanation });
  } catch {
    return res.json({ explanation: "Unable to generate explanation at this time." });
  }
});

export default router;
