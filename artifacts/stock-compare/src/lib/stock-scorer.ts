// Layer 1 — Stock Score: orders rows (which stocks are best put candidates now).
// Consumes existing scorer outputs as inputs; does not re-derive RSI/quality.

import {
  WS_TECHNICAL, WS_FUNDAMENTAL, WS_RELATIVE_MOVE,
  WS_BEST_OPTION, WS_TAG, TAG_BONUS,
} from "./option-scorer-constants.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function c01(v: number): number { return Math.max(0, Math.min(1, v)); }

function pf(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

// ── Component: Relative Move ──────────────────────────────────────────────────
// Replaces return5d > 3% hard gate with a continuous [0,1] score.
// High score = stock is low in its range / oversold = favorable entry.
// Low score = stock just spiked into upper range = unfavorable.

export function computeRelativeMove(
  priceZScore: number | null,         // z-score of price vs own rolling history
  priceVsMa50Atr: number | null,      // (price - MA50) / ATR14 in own ATR units
  return5d: number | null,            // 5-day % return (stored as %, e.g. 5.2 = +5.2%)
  swingHigh20d: number | null,
  swingLow20d: number | null,
  spot: number | null,
): number {
  const parts: Array<{ score: number; weight: number }> = [];

  // z-score component: negative z = price low vs history = favorable
  const z = pf(priceZScore);
  if (z !== null) {
    // sigmoid-like: z = -2 → ~0.88; z = 0 → 0.5; z = +2 → ~0.12
    const s = c01(0.5 - z * 0.18);
    parts.push({ score: s, weight: 0.35 });
  }

  // MA50/ATR component: below MA50 = favorable (negative value is good)
  const ma50Atr = pf(priceVsMa50Atr);
  if (ma50Atr !== null) {
    // -3 ATRs below MA50 → 1.0; at MA50 → 0.5; +3 ATRs above → 0.0
    const s = c01(0.5 - ma50Atr * 0.15);
    parts.push({ score: s, weight: 0.30 });
  }

  // 5-day return component: large negative return = better entry opportunity
  // return5d stored as % (e.g. 5.2 = +5.2%)
  const r5 = pf(return5d);
  if (r5 !== null) {
    // +8% spike → 0.1; 0% → 0.5; -8% selloff → 0.9
    const s = c01(0.5 - r5 * 0.05);
    parts.push({ score: s, weight: 0.20 });
  }

  // Range position: low in 20d range = favorable
  const hi = pf(swingHigh20d);
  const lo = pf(swingLow20d);
  const sp = pf(spot);
  if (hi !== null && lo !== null && sp !== null && hi > lo) {
    const rangePos = (sp - lo) / (hi - lo);
    parts.push({ score: c01(1 - rangePos), weight: 0.15 });
  }

  if (parts.length === 0) return 0.5; // no data → neutral

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  return c01(parts.reduce((s, p) => s + p.weight * p.score, 0) / totalWeight);
}

// ── Component: Tag bonus ──────────────────────────────────────────────────────

export function tagBonus(colorTag: string | null | undefined): number {
  if (!colorTag) return 0.5;
  const lower = colorTag.toLowerCase();
  for (const [key, val] of Object.entries(TAG_BONUS)) {
    if (lower.includes(key)) return val;
  }
  return 0.5;
}

// ── Stock Score (Layer 1) ─────────────────────────────────────────────────────

export interface StockScoreInputs {
  techTotalScore: number | null;     // [0, 100] from computeTechnicalRankingsV2
  fundTotalScore: number | null;     // [0, 100] from computeRankingsV2
  relativeMoveScore: number;         // [0, 1] from computeRelativeMove
  bestOptionScore: number | null;    // [0, 100] from computeOptionScore; null = no viable strikes
  colorTag: string | null;
}

export interface StockScoreResult {
  stockScore: number;               // [0, 100]
  componentScores: Record<string, { score: number | null; weight: number }>;
  dataQuality: "good" | "partial" | "insufficient";
}

export function computeStockScore(
  inputs: StockScoreInputs,
  stockWeights?: Record<string, number>,
): StockScoreResult {
  const { techTotalScore, fundTotalScore, relativeMoveScore, bestOptionScore, colorTag } = inputs;
  const w = (key: string, def: number) => stockWeights?.[key] ?? def;

  const components: Array<{ key: string; weight: number; score: number | null }> = [
    {
      key: "technical",
      weight: w("technical", WS_TECHNICAL),
      score: pf(techTotalScore) !== null ? c01((pf(techTotalScore) as number) / 100) : null,
    },
    {
      key: "fundamental",
      weight: w("fundamental", WS_FUNDAMENTAL),
      score: pf(fundTotalScore) !== null ? c01((pf(fundTotalScore) as number) / 100) : null,
    },
    {
      key: "relativeMove",
      weight: w("relativeMove", WS_RELATIVE_MOVE),
      score: relativeMoveScore,
    },
    {
      key: "bestOption",
      weight: w("bestOption", WS_BEST_OPTION),
      score: bestOptionScore !== null ? c01(bestOptionScore / 100) : null,
    },
    {
      key: "tag",
      weight: w("tag", WS_TAG),
      score: tagBonus(colorTag),
    },
  ];

  const available    = components.filter(c => c.score !== null);
  const totalWeight  = available.reduce((s, c) => s + c.weight, 0);
  const maxWeight    = components.reduce((s, c) => s + c.weight, 0);
  const coverageRatio = totalWeight / maxWeight;

  const stockScore = totalWeight > 0
    ? (available.reduce((s, c) => s + c.weight * (c.score as number), 0) / totalWeight) * 100
    : 0;

  const componentScores: Record<string, { score: number | null; weight: number }> = {};
  for (const c of components) componentScores[c.key] = { score: c.score, weight: c.weight };

  const dataQuality: "good" | "partial" | "insufficient" =
    coverageRatio >= 0.80 ? "good" : coverageRatio >= 0.50 ? "partial" : "insufficient";

  return {
    stockScore: Math.round(stockScore * 10) / 10,
    componentScores,
    dataQuality,
  };
}

// ── Competitor score (tech + fund only, 50/50) ────────────────────────────────

const COMPETITOR_W_TECH = 0.5;
const COMPETITOR_W_FUND = 0.5;

/** Combined [0,100] score for peer ranking — no options, relative move, or tag. */
export function computeTechFundScore(
  techTotalScore: number | null,
  fundTotalScore: number | null,
): number | null {
  const tech = pf(techTotalScore);
  const fund = pf(fundTotalScore);
  const parts: Array<{ weight: number; score: number }> = [];
  if (tech !== null) parts.push({ weight: COMPETITOR_W_TECH, score: c01(tech / 100) });
  if (fund !== null) parts.push({ weight: COMPETITOR_W_FUND, score: c01(fund / 100) });
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const combined = parts.reduce((s, p) => s + p.weight * p.score, 0) / totalWeight;
  return Math.round(combined * 1000) / 10;
}
