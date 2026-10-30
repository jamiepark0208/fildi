import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { assembleContext, type ContextBundle } from "../lib/explain-context.js";
import { bookGroupPromptLine, engineAwarenessFromContract, newsPromptLine } from "../lib/model-list-awareness.js";
import { generateExplanation, type ExplainSurface } from "../lib/ai-explain.js";
import { validate } from "../middleware/validate.js";
import { markAiCached } from "../middleware/rateLimiter.js";
import { explainScoreSchema } from "../lib/validators/explain.js";
import { readLatestFairValue, type LatestFairValue } from "../lib/fair-value-snapshots.js";

const router  = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface FundamentalData {
  totalScore:     number;
  rank:           number;
  universeSize?:  number;
  familyScores:   { value: number; growth: number; quality: number; safety: number };
  topMetrics:     string[];
  weakMetrics:    string[];
  reason:         string;
  suspectMetrics?: string[];
  dataQuality?:   string;
  sector?:        string;
  industry?:      string;
  peerGroup?:     string;
  peerGroupSize?: number;
  metricValues?:  Record<string, number | null>;
  /** Server-attached (never from the client): latest blended fair value snapshot. */
  fairValueSnapshot?: LatestFairValue | null;
  // Real cross-sectional peer numbers, keyed by metric label — lets the model cite an
  // actual peer median instead of inventing a plausible-sounding benchmark. sectorMedian is
  // the ticker's actual peer-group median (undefined if no/too-small peer group); marketMedian
  // is the whole-universe fallback — always present.
  metricDetails?: Record<string, {
    value: string; percentile: number;
    sectorMedian?: string; sectorN?: number;
    marketMedian: string; n: number;
  }>;
}

interface TechnicalData {
  // Lens the score was computed under: "put" = oversold/sell-puts (default),
  // "call" = overbought/sell-calls. Changes prompt framing and cache hash.
  side?:           "put" | "call";
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
const PROMPT_VERSION = "v6"; // v6: side-aware technical prompt (put/call lens)

function fundamentalHash(d: FundamentalData): string {
  const fs = d.familyScores;
  // Strength/weakness names are what the 3 bullets are about — when they change, the
  // explanation is stale even if the rounded pillar scores didn't move. Raw percentiles
  // stay out of the key so daily drift doesn't force a fresh Haiku call.
  const story = `${d.topMetrics.join(",")}|${d.weakMetrics.join(",")}`;
  // Fair value enters the prompt, so a ~10% move in fair/price (or a value-trap flip) refreshes the explanation.
  const fv = d.fairValueSnapshot;
  const fvKey = fv?.fairValue && fv.price ? `_fv${Math.round(Math.log(fv.fairValue / fv.price) * 10)}${fv.valueTrap ? "t" : ""}` : "";
  return `${PROMPT_VERSION}_${d.totalScore.toFixed(1)}_${fs.value.toFixed(0)}_${fs.growth.toFixed(0)}_${fs.quality.toFixed(0)}_${fs.safety.toFixed(0)}_${story}${fvKey}`;
}

function technicalHash(d: TechnicalData): string {
  return `${PROMPT_VERSION}_${d.side ?? "put"}_${d.totalScore.toFixed(1)}_${d.signal}_${d.regime}`;
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
  const peerGroupCtx = d.peerGroup ? `Peer group: ${d.peerGroup} (${d.peerGroupSize ?? "?"} tickers)` : "";
  const universeSize = d.universeSize ?? 256;

  // Prefer the real cross-sectional numbers (metricDetails) over raw metricValues — this is
  // what the model must cite, so it can't invent a "vs X% peers" figure that doesn't exist.
  // sectorMedian (the actual peer-group comparison) is what should be cited when present;
  // marketMedian is only the fallback for metrics/tickers without a usable peer group.
  const metricLines = d.metricDetails
    ? Object.entries(d.metricDetails)
        .map(([label, m]) => m.sectorMedian
          ? `  ${label}: ${m.value} — ${m.percentile}th percentile (sector median ${m.sectorMedian} of ${m.sectorN} peers; market median ${m.marketMedian} of ${m.n})`
          : `  ${label}: ${m.value} — ${m.percentile}th percentile of ${m.n} peers (market median ${m.marketMedian})`)
        .join("\n")
    : d.metricValues
      ? Object.entries(d.metricValues)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `  ${k}: ${(v as number).toFixed(2)}`)
          .join("\n")
      : "";

    const fv = d.fairValueSnapshot;
  const fvLine = fv?.fairValue && fv.price
    ? `Blended fair value: $${fv.fairValue.toFixed(2)} vs $${fv.price.toFixed(2)} (${((fv.fairValue / fv.price - 1) * 100).toFixed(0)}%), range $${fv.low?.toFixed(2) ?? "?"}–$${fv.high?.toFixed(2) ?? "?"}, ${fv.confidence ?? "low"} confidence${fv.cyclical ? ", cyclical" : ""}${fv.valueTrap ? ". VALUE-TRAP RISK: looks cheap but the 12-month trend is in the bottom half" : ""}.`
    : "";

return `You explain stock fundamentals to a smart non-expert — like a knowledgeable friend, not a textbook. Be vivid and specific. Skip anything unremarkable; only explain what stands out.

Ticker: ${ticker}
${sectorCtx}
${peerGroupCtx}
Score: ${d.totalScore.toFixed(1)}/100 — rank #${d.rank} of ${universeSize} in the universe
Pillar scores — Value: ${d.familyScores.value.toFixed(0)}/100 | Growth: ${d.familyScores.growth.toFixed(0)}/100 | Quality: ${d.familyScores.quality.toFixed(0)}/100 | Safety: ${d.familyScores.safety.toFixed(0)}/100
Top strengths: ${d.topMetrics.join(", ") || "none"}
Top weaknesses: ${d.weakMetrics.join(", ") || "none"}
${metricLines ? `\nMetrics (value — percentile, sector median preferred over market median when both given):\n${metricLines}` : ""}
${suspectNote}${qualityNote ? "\n" + qualityNote : ""}
${fvLine}

Write exactly 3 bullet points (starting with -). Rules:
- Each bullet: max 12 words + one parenthetical with the key number
- Format: "[what it means for a put seller] (value vs sector median if given, else market median — use ONLY the numbers given above, never invent one)"
- Example: "Exceptional cash generation, reduces default risk (FCF margin 28% vs 12% sector median)"
- Only the 3 most significant drivers — skip anything near average
- Fair value (if given) is a valuation reference, never a buy/sell signal: mention it only if the gap is > 25%; if VALUE-TRAP RISK is flagged, one bullet must say so

No intro. No outro. No investment advice.`;
}

function buildTechnicalPrompt(ticker: string, d: TechnicalData): string {
  const isCall = d.side === "call";

  const oversoldLabel = d.rsi14Pct < 20 ? "deeply oversold vs own history"
    : d.rsi14Pct < 40 ? "oversold vs own history"
    : d.rsi14Pct > 80 ? "overbought vs own history"
    : "neutral vs own history";

  const earningsNote = d.earningsDaysOut != null
    ? `Earnings in ${d.earningsDaysOut} days.`
    : "No near-term earnings.";

  const cs = d.componentScores;

  // Lens-specific naming — the same component slots score opposite directions per side
  const lensLine = isCall
    ? `This score ranks the stock as a CALL-SELLING candidate (sell calls into strength: overbought + momentum fading + elevated IV = good).`
    : `This score ranks the stock as a PUT-SELLING candidate (oversold + stabilizing + elevated IV = good).`;
  const componentLine = isCall
    ? `Component scores (0–1): overbought depth ${cs.oversoldDepth.toFixed(2)} | exhaustion signal ${cs.reversalSignal.toFixed(2)} | vol state ${cs.volatilityState.toFixed(2)} | trend extension ${cs.trendContext.toFixed(2)}`
    : `Component scores (0–1): oversold depth ${cs.oversoldDepth.toFixed(2)} | reversal signal ${cs.reversalSignal.toFixed(2)} | vol state ${cs.volatilityState.toFixed(2)} | trend ${cs.trendContext.toFixed(2)}`;
  const formatLine = isCall
    ? `- Format: "[what this means for selling a covered call] (value, context)"
- Example: "Overbought vs own history, momentum stalling — good overwrite (RSI 76, top 10%)"
- Lead with any key risk (earnings, still-accelerating uptrend that could blow through the strike)`
    : `- Format: "[what this means for selling a put] (value, context)"
- Example: "Oversold vs own history, good entry timing (RSI 28, bottom 15%)"
- Lead with any key risk (earnings, falling knife, overbought IV)`;

  return `You explain a stock's technical setup to a smart non-expert — like a knowledgeable friend, not a textbook. Be vivid. Skip unremarkable readings; only explain what stands out.

Ticker: ${ticker}
${lensLine}
Signal: ${d.signal} | Macro regime: ${d.regime}
Score: ${d.totalScore.toFixed(1)}/100 — rank #${d.rank} in universe
RSI: ${d.rsi14.toFixed(1)} — at the ${d.rsi14Pct.toFixed(0)}th percentile of its own 1-year history (${oversoldLabel})
IV rank: ${d.ivRank.toFixed(0)}/100 | IV vs realized: ${d.ivVsRealizedVol.toFixed(2)}x
MACD: ${d.macdDirection} | Falling knife: ${d.fallingKnife ? "YES — price momentum sharply negative" : "no"}
${earningsNote}
${componentLine}

Write exactly 2 bullets (starting with -). Rules:
- Each bullet: max 12 words + one parenthetical with the key number
${formatLine}

No intro. No outro. No investment advice.`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Put and call lenses get separate surfaceTypes so both explanations stay cached —
// explain_cache keeps one row per (ticker, surfaceType), so a shared type made every
// put↔call toggle overwrite the other and pay for a fresh Haiku call.
const fundamentalSurface: ExplainSurface<FundamentalData> = {
  surfaceType:   "fundamental",
  promptVersion: PROMPT_VERSION,
  buildPrompt:   (b, d) => buildFundamentalPrompt(b.ticker, d),
  hashInputs:    (_b, d) => fundamentalHash(d),
};
const technicalPutSurface: ExplainSurface<TechnicalData> = {
  surfaceType:   "technical",
  promptVersion: PROMPT_VERSION,
  buildPrompt:   (b, d) => buildTechnicalPrompt(b.ticker, d),
  hashInputs:    (_b, d) => technicalHash(d),
};
const technicalCallSurface: ExplainSurface<TechnicalData> = {
  ...technicalPutSurface,
  surfaceType: "technical-call",
};

// POST /api/explain/score — generate AI explanation for a ticker's score.
// Checks explain_cache first; only calls Haiku on a cache miss.
router.post("/explain/score", validate(explainScoreSchema), async (req, res) => {
  const { scoreType, fundamentalData, technicalData } = req.body as ExplainRequest;
  const ticker = (req.body as ExplainRequest).ticker.toUpperCase();

  const userId = req.session.userId!;
  const log = req.log.child({ ticker, scoreType, userId });
  const bundle: ContextBundle = { ticker, stockEvent: null, marketEvent: null };

  try {
    let result;
    if (scoreType === "fundamental") {
      if (!fundamentalData) return res.status(400).json({ error: "fundamentalData required" });
      const fairValueSnapshot = await readLatestFairValue(ticker);
      result = await generateExplanation(ticker, fundamentalSurface, bundle, { ...fundamentalData, fairValueSnapshot }, log, { userId });
    } else {
      if (!technicalData) return res.status(400).json({ error: "technicalData required" });
      const surface = technicalData.side === "call" ? technicalCallSurface : technicalPutSurface;
      result = await generateExplanation(ticker, surface, bundle, technicalData, log, { userId });
    }
    markAiCached(res, result.cached);
    return res.json({ explanation: result.explanation, cached: result.cached });
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
  return `v1_${dayBucket}_${notesKey(bundle)}_${e.rsi.toFixed(1)}_${e.mfi.toFixed(1)}_${e.signal}_${bundle.stockEvent?.priceZScore ?? "na"}_${bundle.marketEvent?.volRegime ?? "na"}_${bundle.marketEvent?.keyThemes?.marketState ?? "na"}_${bundle.marketEvent?.sector?.quadrant ?? "na"}`;
}

/** Notes change → the cached explanation must regenerate. */
function notesKey(b: ContextBundle): string {
  const n = b.notes ?? [];
  return n.length ? `n${n.length}_${n[0].length}_${n[0].slice(0, 10)}` : "n0";
}

function notesBlock(b: ContextBundle): string {
  return b.notes?.length
    ? `Desk notes on this ticker (dated, newest first — past context, not a forecast; cite the date if you use one):\n${b.notes.map(n => `- ${n}`).join("\n")}`
    : "";
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
  // Key Themes: tested state + playbook drive the advice; themes only explain (macro timing failed, S087/S027)
  const kt = me?.keyThemes;
  const themesLine = kt
    ? `Market state (tested, S101): ${kt.marketState ?? "unknown"}.\nPlaybook today:\n${kt.playbook.map((p) => `- ${p}`).join("\n")}\nMacro themes (context only, not a timing signal):\n${kt.themes.map((t) => `- ${t}`).join("\n")}`
    : "";

  return `You explain a cash-secured-put candidate to an options seller who wants recent, specific context — not a repeat of numbers they can already see on screen. Be concrete about WHY this ticker looks interesting right now, not just that a threshold was crossed.

Ticker: ${bundle.ticker}
Signal: ${e.signal} (Tier ${e.tier}, ${TIER_WIN_RATE[e.tier]} historical win rate) | RSI ${e.rsi.toFixed(1)} vs threshold | MFI ${e.mfi.toFixed(1)}
${e.ivCurrent != null ? `IV: ${e.ivCurrent.toFixed(0)}%` : ""}${e.vsSpy20d != null ? ` | vs SPY 20d: ${e.vsSpy20d > 0 ? "+" : ""}${e.vsSpy20d.toFixed(1)}%` : ""}
${zscoreLine}
${sectorLine}
${volLine}
${themesLine}
${notesBlock(bundle)}
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

  const userId = req.session.userId!;
  const log = req.log.child({ ticker, surfaceType: "options", userId });

  try {
    const bundle = await assembleContext(ticker, { include: ["stockEvent", "marketEvent"] });
    const result = await generateExplanation(
      ticker.toUpperCase(),
      optionsSurface,
      bundle,
      { rsi, mfi, signal, tier, ivCurrent: ivCurrent ?? null, vsSpy20d: vsSpy20d ?? null },
      log,
      { userId },
    );
    markAiCached(res, result.cached);
    return res.json({ explanation: result.explanation, cached: result.cached });
  } catch (err) {
    log.error({ err, step: "failed" }, "explain/options error");
    return res.status(500).json({ error: String(err) });
  }
});

// ── Live regime banner surface ──────────────────────────────────────────────
// One-line plain-English read on the intraday regime banner — narrates the
// same checkpoint factors (sweep-reclaim, VWAP separation, breakout state)
// already computed by intraday-regime.ts, on demand rather than pushed.

interface RegimeCheckpointExtra {
  minAfterOpen: number;
  label: string;
  direction: "bullish" | "bearish" | "mixed" | null;
  confidence: number | null;
  factors: string[];
}

interface LiveRegimeExtra {
  checkpoints: RegimeCheckpointExtra[];
}

const MARKET_TICKER = "MARKET";

function liveRegimeHash(_bundle: ContextBundle, e: LiveRegimeExtra): string {
  const latest = e.checkpoints[e.checkpoints.length - 1];
  const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  return `v1_${dayBucket}_${latest?.minAfterOpen ?? "na"}_${latest?.direction ?? "na"}_${latest?.confidence ?? "na"}`;
}

function buildLiveRegimePrompt(_bundle: ContextBundle, e: LiveRegimeExtra): string {
  const lines = e.checkpoints
    .filter(c => c.direction != null)
    .map(c => `${c.label}: ${c.direction}${c.confidence != null ? ` (${c.confidence}%)` : ""} — ${(c.factors ?? []).join("; ") || "no factors recorded"}`)
    .join("\n");

  return `You explain today's intraday market regime checkpoints to an options trader watching the Live tab. Checkpoints so far today:

${lines || "No resolved checkpoints yet."}

Write exactly 1 sentence, under 30 words, calling out the most decision-relevant pattern (e.g. a sweep-reclaim setting up a reversal, a flip in direction, or confidence building/fading). No intro, no hedging, no repeating raw numbers already shown on screen.`;
}

const liveRegimeSurface: ExplainSurface<LiveRegimeExtra> = {
  surfaceType:  "live-regime",
  promptVersion: "v1",
  buildPrompt:  buildLiveRegimePrompt,
  hashInputs:   liveRegimeHash,
};

router.post("/explain/live-regime", async (req, res) => {
  const { checkpoints } = req.body as { checkpoints?: RegimeCheckpointExtra[] };

  if (!checkpoints || !Array.isArray(checkpoints) || checkpoints.length === 0) {
    return res.status(400).json({ error: "checkpoints array is required" });
  }

  const userId = req.session.userId!;
  const log = req.log.child({ ticker: MARKET_TICKER, surfaceType: "live-regime", userId });

  try {
    const bundle: ContextBundle = { ticker: MARKET_TICKER, stockEvent: null, marketEvent: null };
    const result = await generateExplanation(
      MARKET_TICKER, liveRegimeSurface, bundle, { checkpoints }, log, { userId },
    );
    markAiCached(res, result.cached);
    return res.json({ explanation: result.explanation, cached: result.cached });
  } catch (err) {
    log.error({ err, step: "failed" }, "explain/live-regime error");
    return res.status(500).json({ error: String(err) });
  }
});

// ── Model List pick surface ─────────────────────────────────────────────────
// Narrates one published Model List item (scripts/watchlist_sync/publish_model_list.py). Every number comes from the stored item
// (deterministic code computed it); the model only explains. The item is read server-side from the latest run, never from the client.
// Same owner rule as GET /watchlist/model: the list is built from user 1's accounts.

const MODEL_LIST_USER_ID = 1;

interface ModelPickExtra {
  runId: number;
  folderName: string;
  item: Record<string, any>;
}

function modelPickHash(b: ContextBundle, e: ModelPickExtra): string {
  const c = e.item.contract ?? {};
  return `v4_${e.runId}_${e.item.folder_key}_${c.type ?? ""}_${c.account ?? ""}_${notesKey(b)}`;
}

function fmtPct(x: unknown): string {
  return typeof x === "number" ? `${Math.round(x * 100)}%` : "n/a";
}

function buildModelPickPrompt(b: ContextBundle, e: ModelPickExtra): string {
  const it = e.item, c = it.contract ?? null, w = c?.win ?? null, p = it.pillars ?? {};
  const facts: string[] = [
    `List: ${e.folderName} (status ${it.status}; verdict ${it.verdict || "none"})`,
    `Pillars (0-100): OWN ${p.own ?? "n/a"}, STREET ${p.street ?? "n/a"}, PREMIUM ${p.premium ?? "n/a"}${p.premium_30d != null ? ` (30-day IV version ${p.premium_30d})` : ""}; price vs 200-day ${p.ma200 != null ? `${(p.ma200 * 100).toFixed(0)}%` : "n/a"}`,
  ];
  if (c) {
    facts.push(`Trade: sell ${c.type} ${c.strike} expiring ${c.expiry} in ${c.account ?? "?"}; realistic fill $${c.premium ?? "?"}${c.model_premium != null ? ` (model said $${c.model_premium})` : ""}`);
    if (w) {
      facts.push(`History of ALL stocks' options at this delta and expiry, not this stock's own (2020-26, delta ${w.delta}, ${w.dte} days): made money ${fmtPct(w.rate)} of the time (worst year ${fmtPct(w.lo)}, best ${fmtPct(w.hi)}); per contract good year $${w.ev_good}, average $${w.ev}, bad year $${w.ev_bad}. Note: across all stocks the average sold option roughly broke even; the edge is in which names are picked.`);
      if (Array.isArray(w.alts)) facts.push(`What-if same expiry: ${w.alts.map((a: any) => `delta ${a.delta}: strike ~${a.strike}, premium ~$${a.premium}, wins ${fmtPct(a.rate)}, bad year $${a.ev_bad}`).join("; ")} (estimates, no skew)`);
    }
    if (c.vol) {
      const r = c.vol.contract_iv_rv as number;
      const label = r >= 1.1 ? "RICH (options priced clearly above recent moves: the validated edge is present)"
        : r < 0.95 ? "CHEAP (priced below recent moves: the validated edge runs the other way)"
        : "FAIR (about equal to recent moves: no pricing edge either way)";
      facts.push(`Pricing: this contract's IV is ${r}x the stock's 20-day realized vol = ${label}.`);
    }
    if (c.earnings) facts.push(c.earnings.inside
      ? `Earnings ${c.earnings.date} fall INSIDE this trade (before expiry): an earnings gap can hit it.`
      : `Earnings ${c.earnings.date} fall ${c.earnings.days_after_expiry} days AFTER expiry: no earnings report inside this trade (this says nothing else about assignment risk).`);
    if (c.record) facts.push(`Owner's own record on this ticker/side since ${c.record.since}: ${c.record.wins} of ${c.record.n} profitable, total $${c.record.pnl}`);
  }
  for (const a of (it.adjustments ?? []) as Array<Record<string, unknown>>) {
    const net = typeof a.from === "number" && typeof a.to === "number" ? (a.to as number) - (a.from as number) : null;
    const dir = net == null ? "" : ` (${net >= 0 ? "UP" : "DOWN"} ${Math.abs(net).toFixed(1)})`;
    facts.push(`Adjustment: ${a.what} ${a.from} -> ${a.to}${dir} because ${a.why}`);
  }
  for (const y of ((it.why ?? []) as unknown[]).slice(0, 12)) facts.push(`Model note: ${String(y)}`);
  if ((it.flags ?? []).length) facts.push(`Risk flags: ${(it.flags as string[]).join("; ")}`);
  const awareness = engineAwarenessFromContract(c as Record<string, unknown> | null);
  const bgLine = bookGroupPromptLine(String(it.ticker), awareness.book_group);
  if (bgLine) facts.push(bgLine);
  const newsLine = newsPromptLine(awareness.news);
  if (newsLine) facts.push(newsLine);
  for (const n of b.notes ?? []) facts.push(`Desk note (dated history, not a forecast): ${n}`);

  return `You explain one recommendation from the Fildi Model List to its owner, an experienced options seller who decides every trade themselves. Use ONLY the facts below. Never invent numbers, prices or events; if something isn't in the facts, don't mention it.
Rules: use the pricing label exactly as given (never call FAIR or CHEAP an edge). Give each adjustment's reason as written; don't add causes.
Don't infer risk levels the facts don't state. Mention funding choices (closing a put, selling a flagged holding) only if a model note mentions them.

FACTS (${it.ticker}):
${facts.map(f => `- ${f}`).join("\n")}

Write 4 short labelled parts, under 170 words total:
**Why it's listed:** the trade, the list it is in, and the pricing label (RICH / FAIR / CHEAP), in 1-2 sentences. If it was moved to Needs Review, say why first.
**What history says:** win rate and the good/average/bad dollar range in plain terms; mention the what-if only if a different delta looks clearly better or worse.
**Adjustments:** what the model changed and why (skip if none).
**Watch / your call:** the 1-2 things that would change the decision (earnings, trend, limits, funding options such as closing a put or selling a flagged holding). Present funding options as choices, never instructions.
No intro, no disclaimers.`;
}

const modelPickSurface: ExplainSurface<ModelPickExtra> = {
  surfaceType: "model-pick",
  promptVersion: "v4",
  buildPrompt: buildModelPickPrompt,
  hashInputs: modelPickHash,
};

router.post("/explain/model-pick", async (req, res) => {
  const { ticker, folderKey, type, account } = req.body as { ticker?: string; folderKey?: string; type?: string; account?: string };
  if (!ticker || !folderKey) return res.status(400).json({ error: "ticker and folderKey are required" });
  const userId = req.session.userId!;
  if (userId !== MODEL_LIST_USER_ID) return res.status(403).json({ error: "the Model List belongs to its owner" });
  const log = req.log.child({ ticker, surfaceType: "model-pick", userId });
  try {
    const r = await db.execute(sql`
      SELECT i.*, f.name AS folder_name, i.run_id FROM watchlist_sync.model_items i
      JOIN watchlist_sync.model_folders f ON f.folder_key = i.folder_key
      WHERE i.run_id = (SELECT max(id) FROM watchlist_sync.model_runs)
        AND i.folder_key = ${folderKey} AND i.ticker = ${ticker.toUpperCase()}
        AND COALESCE(i.contract->>'type', '') = ${type ?? ""} AND COALESCE(i.contract->>'account', '') = ${account ?? ""}
      LIMIT 1`);
    const rows = (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, any>>;
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "item not in the latest Model List run" });
    const bundle = await assembleContext(ticker, { include: [] });
    const result = await generateExplanation(
      ticker.toUpperCase(), modelPickSurface, bundle,
      { runId: Number(item.run_id), folderName: String(item.folder_name), item }, log, { userId, maxTokens: 450 },
    );
    markAiCached(res, result.cached);
    return res.json({ explanation: result.explanation, cached: result.cached });
  } catch (err) {
    log.error({ err, step: "failed" }, "explain/model-pick error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
