// Rest-of-day risk call for the Live tab (S126, Jamie 10-28).
//
// The Live tab used to call bullish/bearish into the close. Backtested on 479
// SPY/QQQ sessions (2024-11 → 2026-10) that composite was right 49.5 % of the
// time — worse than "always bullish" (53 %) — and no direction rule beat the base
// rate in both halves (S124/S055 agree). The TradingView regime detectors Jamie
// pointed at (StrixEDGE, LuciTech AMRI, KK, forexobroker, JOAT) don't call
// direction either: they classify the state — trend / range / volatile chop —
// from efficiency ratio, choppiness and volatility vs normal. What that state
// does predict is how much the tape still moves: volatility clusters.
//
// Score = z-scored inputs × weights fit on 2024-11 → 2025-11 (H1), graded on
// 2025-11 → 2026-10 (H2). Levels = H1 p20 / p60 / p80 of the score.
// H2 P(drop ≥ 0.5 × 20-day daily range before the close): calm 7 %, normal 11 %,
// elevated 20 %, stormy 26 %. Constants: scripts/watchlist_sync/out/opt/S126_model.json.
import { and, desc, eq, lt } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";
import type { Bar } from "./intraday-regime.js";

export type RiskLevel = "calm" | "normal" | "elevated" | "stormy";
export type TapeState = "trend" | "range" | "quiet" | "volatile";

export interface RiskInputs {
  /** Session range so far ÷ 20-day average daily range ÷ the usual ratio at this checkpoint. */
  rngRel: number;
  /** Prior 5-session return (fraction). */
  ret5d: number;
  /** Efficiency ratio of the session so far (|net move| ÷ path). */
  er: number;
  /** Choppiness index of the session so far (0–100). */
  chop: number;
  /** 20-day average true range, fraction of price. */
  atr20: number;
}

export interface RiskCall {
  level: RiskLevel;
  score: number;
  /** Historical P(further drop ≥ 0.5 × ATR20 before the close) at this level (S126, both halves). */
  pDropHalfAtr: number;
  /** 0.5 × ATR20 in percent of price — what "a half-day-range drop" means today. */
  halfAtrPct: number;
  state: TapeState;
  inputs: RiskInputs;
}

const MODEL = {
  mu: { rngRel: 1.14072, ret5d: 0.00394, er: 0.24785, chop: 49.45442 },
  sd: { rngRel: 0.70139, ret5d: 0.02628, er: 0.19908, chop: 9.3585 },
  intercept: 0.0534,
  w: { rngRel: 0.2547, ret5d: -0.1517, er: -0.0376, chop: 0.1018 },
  cuts: [-0.1709, 0.0531, 0.258],
  rngMedianByMin: { 30: 0.3303, 45: 0.4046, 60: 0.4385, 90: 0.4947, 120: 0.5278, 150: 0.5777, 180: 0.6065, 210: 0.6287, 270: 0.678, 330: 0.7323 } as Record<number, number>,
  pDropHalfAtr: { calm: 0.097, normal: 0.153, elevated: 0.201, stormy: 0.325 } as Record<RiskLevel, number>,
};
const LEVELS: RiskLevel[] = ["calm", "normal", "elevated", "stormy"];

export interface DailyContext { atr20: number; ret5d: number }

/** ATR20 and the 5-session return from daily closes strictly before `dateKey` (no look-ahead). */
export async function dailyContext(ticker: string, dateKey: string): Promise<DailyContext | null> {
  const rows = await db.select({ high: pricesHistorical.high, low: pricesHistorical.low, close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, ticker), lt(pricesHistorical.date, dateKey)))
    .orderBy(desc(pricesHistorical.date))
    .limit(21);
  const d = rows.map(r => ({ h: Number(r.high), l: Number(r.low), c: Number(r.close) })).reverse();
  if (d.length < 21) return null;
  let trSum = 0;
  for (let i = 1; i < d.length; i++) {
    const pc = d[i - 1].c;
    trSum += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - pc), Math.abs(d[i].l - pc)) / pc;
  }
  const n = d.length;
  return { atr20: trSum / (n - 1), ret5d: d[n - 1].c / d[n - 6].c - 1 };
}

/** Usual range-so-far ratio at any minute 30–385 (linear between the fitted checkpoints; S139 scores every bar). */
function typicalAt(minAfterOpen: number): number | undefined {
  const ks = Object.keys(MODEL.rngMedianByMin).map(Number).sort((a, b) => a - b);
  if (minAfterOpen < ks[0] || minAfterOpen > 390) return undefined;
  if (minAfterOpen >= ks[ks.length - 1]) return MODEL.rngMedianByMin[ks[ks.length - 1]];
  const i = ks.findIndex(k => k >= minAfterOpen);
  const hi = ks[i], lo = ks[Math.max(0, i - 1)];
  if (hi === lo) return MODEL.rngMedianByMin[hi];
  const w = (minAfterOpen - lo) / (hi - lo);
  return MODEL.rngMedianByMin[lo] * (1 - w) + MODEL.rngMedianByMin[hi] * w;
}

/** Bars must be the session's 5-min RTH bars that STARTED before the checkpoint. */
export function computeRiskCall(bars: Bar[], minAfterOpen: number, daily: DailyContext | null): RiskCall | null {
  const typical = typicalAt(minAfterOpen);
  if (!daily || !(daily.atr20 > 0) || typical == null || bars.length < 4) return null;
  const open = bars[0].open;
  const last = bars[bars.length - 1].close;
  const hh = Math.max(...bars.map(b => b.high));
  const ll = Math.min(...bars.map(b => b.low));

  let path = Math.abs(bars[0].close - open);
  let trSum = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    path += Math.abs(bars[i].close - pc);
    trSum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  const er = path > 0 ? Math.abs(last - open) / path : 0;
  const chop = hh > ll ? (100 * Math.log10(trSum / (hh - ll))) / Math.log10(bars.length) : 100;
  const rng = (hh - ll) / open / daily.atr20;
  const inputs: RiskInputs = { rngRel: rng / typical, ret5d: daily.ret5d, er, chop, atr20: daily.atr20 };

  const z = (k: keyof typeof MODEL.w) => (inputs[k] - MODEL.mu[k]) / MODEL.sd[k];
  const score = MODEL.intercept + (Object.keys(MODEL.w) as (keyof typeof MODEL.w)[]).reduce((s, k) => s + MODEL.w[k] * z(k), 0);
  const level = LEVELS[MODEL.cuts.filter(c => score >= c).length];

  // Descriptive only (what the tape did so far) — S126 §B: these labels alone don't forecast.
  const state: TapeState = inputs.rngRel >= 1.6 && er < 0.34 ? "volatile" : er >= 0.34 ? "trend" : inputs.rngRel <= 0.6 ? "quiet" : "range";

  return { level, score, pDropHalfAtr: MODEL.pDropHalfAtr[level], halfAtrPct: daily.atr20 * 50, state, inputs };
}

/** SPY + QQQ → one call: mean score (the model was fit on both pooled). */
export function combineRisk(a: RiskCall | null, b: RiskCall | null): RiskCall | null {
  if (!a || !b) return a ?? b;
  const score = (a.score + b.score) / 2;
  const level = LEVELS[MODEL.cuts.filter(c => score >= c).length];
  const base = a.score >= b.score ? a : b;
  return { ...base, score, level, pDropHalfAtr: MODEL.pDropHalfAtr[level], halfAtrPct: (a.halfAtrPct + b.halfAtrPct) / 2 };
}

/** Live-tab buffer (10-29: 4 flips stormy↔elevated in 25 min): a step up shows at once; a step down needs the previous
 *  completed bar at or below the new level too, else the last shown level holds. */
export function holdLevel(cur: RiskCall, prev: RiskCall | null, last: RiskLevel | null): RiskCall {
  if (!last) return cur;
  const r = (l: RiskLevel) => LEVELS.indexOf(l);
  if (r(cur.level) >= r(last) || (prev && r(prev.level) <= r(cur.level))) return cur;
  return { ...cur, level: last, pDropHalfAtr: MODEL.pDropHalfAtr[last] };
}

export const RISK_LABEL: Record<RiskLevel, string> = { calm: "Calm", normal: "Normal", elevated: "Elevated", stormy: "Stormy" };

export function riskFactorLine(r: RiskCall | null): string {
  if (!r) return "Rest-of-day risk: no daily history";
  return `Rest-of-day risk: ${RISK_LABEL[r.level]} — ${Math.round(r.pDropHalfAtr * 100)}% odds of a further ≥ ${r.halfAtrPct.toFixed(2)}% drop by the close`
    + ` (range ${r.inputs.rngRel.toFixed(1)}× usual, 5d ${(r.inputs.ret5d * 100).toFixed(1)}%, tape ${r.state}; S126)`;
}
