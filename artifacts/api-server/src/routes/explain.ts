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
// Increment PROMPT_VERSION when prompt copy changes to bust the cache globally.
const PROMPT_VERSION = "v2";

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
- Pick the 3 MOST SIGNIFICANT factors that explain the score — not all metrics, only what truly drives it
- Each bullet: one short plain-English sentence that explains WHY this matters for put-selling risk, then the actual number in parentheses vs a typical benchmark (e.g. "(84% gross margin vs ~60% tech average)")
- If something is in the top or bottom 10% of what you'd expect for a stock like this, say so plainly ("unusually high", "rare for this sector", "most peers are around X")
- Focus on: is the business fundamentally strong enough that a put seller sleeps well? What's the one thing that could surprise them?

No intro sentence. No outro. No investment advice. Plain English throughout.`;
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
- Focus only on the 2 things that most explain why the signal is ${d.signal} right now — skip anything near neutral
- Each bullet: one plain-English sentence on what this means for a put seller ("is now a good time to sell a put?"), with the key number in parentheses and what makes it notable ("RSI at its lowest 15% historically means the stock is cheap vs itself")
- If there's a key risk (earnings soon, falling knife, overbought IV), lead with it

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
      max_tokens: 300,
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
