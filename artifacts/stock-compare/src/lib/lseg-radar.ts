/**
 * Street radar scoring (GET /api/research/lseg/radar).
 *  - Opportunities: names you DON'T hold, ranked for selling cash-secured puts.
 *  - Your positions: names you hold, with the risk flags from lseg-interpret.
 * Pure + unit-tested. Soft research ranking only; never written to fund_score.
 */
import {
  CREDIT_SEVERE,
  CREDIT_WEAK,
  interpretLseg,
  PRED_SURPRISE_SIGNAL,
  SHORT_HEAVY,
  type LsegEvent,
  type LsegOption,
  type LsegSignals,
  type Takeaway,
  type Tone,
} from "./lseg-interpret.ts";
import { formatMdYy } from "./format.ts";
import { dispersionNote, earningsHistoryNote, earningsPremium } from "./lseg-earnings.ts";

export type RadarTech = {
  iv: number | null;
  ivVsRealized: number | null;
  impliedMoveWeekly: number | null;
  rsi: number | null;
  z: number | null;
  regime: string | null;
  fallingKnife: boolean;
  rv?: number | null;
};

export type RadarRow = {
  ticker: string;
  tier: number;
  label: "held" | "traded" | "watchlist" | "lookalike" | "book" | "model" | "benchmark";
  reason: string;
  signals: LsegSignals | null;
  tech: RadarTech;
  nextEarnings: LsegEvent | null;
  myPosition: { shares: number | null; options: LsegOption[] };
  /** Signed % reactions to the last ≤9 earnings reports (newest first). */
  pastMovesPct?: number[];
};

export function premiumFor(r: RadarRow) {
  return earningsPremium({
    pastMovesPct: r.pastMovesPct ?? [],
    ivPct: r.tech.iv,
    rvPct: r.tech.rv ?? null,
    reportDate: r.nextEarnings?.date ?? null,
  });
}

export type Bullet = { tone: Tone; text: string };

export type Opportunity = {
  ticker: string;
  label: RadarRow["label"];
  why: string;
  score: number; // 0–100
  parts: { street: number; premium: number; timing: number; penalty: number };
  bullets: Bullet[];
};

export type PositionRisk = {
  ticker: string;
  tone: Tone;
  verdict: string;
  flags: Takeaway[];
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Typical put-sell window the radar assumes when judging earnings timing. */
export const PUT_WINDOW_DAYS = 35;
/** Above this, IV is usually pricing a binary event (trial data, FDA, going-concern) — not harvestable premium. */
export const IV_EXTREME = 120;
/** Street this weak = assignment risk for a put seller; premium alone shouldn't carry the rank. */
export const STREET_WEAK = 0.3;

export function isHeld(r: RadarRow): boolean {
  return (r.myPosition.shares ?? 0) > 0 || r.myPosition.options.length > 0 || r.tier === 1;
}

export function scoreOpportunity(r: RadarRow): Opportunity {
  const s = r.signals;
  const t = r.tech;
  const bullets: Bullet[] = [];

  // Street (0–1): StarMine revisions + overall rank. Keep Why-column copy terse.
  const ranks = [s?.armRank, s?.combinedAlphaRank].filter((x): x is number => x != null);
  const street = ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length / 100 : 0.5;
  if (!ranks.length) {
    bullets.push({ tone: "neutral", text: "No StarMine" });
  } else {
    const st: Tone = street >= 0.7 ? "good" : street <= 0.3 ? "bad" : "neutral";
    bullets.push({
      tone: st,
      text: `StarMine: ${s?.armRank ?? "—"}, overall ${s?.combinedAlphaRank ?? "—"}/100`,
    });
  }

  // Premium (0–1): is IV rich vs realized moves, and is there enough of it?
  const richness = t.ivVsRealized != null ? clamp01((t.ivVsRealized - 0.8) / 0.6) : 0.4;
  const extremeIv = t.iv != null && t.iv > IV_EXTREME;
  const level = t.iv != null ? clamp01((Math.min(t.iv, IV_EXTREME) - 30) / 60) : 0.3;
  // Extreme IV: richness vs realized is meaningless when the market is pricing a one-off jump.
  const premium = extremeIv ? 0.5 * level : 0.6 * richness + 0.4 * level;
  if (extremeIv) {
    bullets.push({ tone: "warn", text: `IV ${t.iv!.toFixed(0)}% extreme (binary)` });
  } else if (t.iv != null && t.ivVsRealized != null) {
    if (t.ivVsRealized >= 1.15)
      bullets.push({ tone: "good", text: `IV ${t.iv.toFixed(0)}% · ${t.ivVsRealized.toFixed(2)}× RV` });
    else if (t.ivVsRealized < 0.85)
      bullets.push({ tone: "warn", text: `IV ${t.iv.toFixed(0)}% · ${t.ivVsRealized.toFixed(2)}× RV thin` });
  }

  // Timing (0–1): put sellers want weakness, not strength.
  const timing = t.rsi != null ? clamp01((70 - t.rsi) / 35) : 0.5;
  if (t.rsi != null && t.rsi <= 35) bullets.push({ tone: "good", text: `RSI ${t.rsi.toFixed(0)}` });
  else if (t.rsi != null && t.rsi >= 70) bullets.push({ tone: "warn", text: `RSI ${t.rsi.toFixed(0)}` });

  // Penalties.
  let penalty = 0;
  if (extremeIv) penalty += 0.1;
  if (ranks.length && street <= STREET_WEAK) penalty += 0.1;
  const ps = s?.predSurprisePct ?? null;
  const er = r.nextEarnings;
  const erInWindow = er != null && er.daysUntil <= PUT_WINDOW_DAYS;
  const prem = premiumFor(r);
  const erMd = er?.date ? formatMdYy(er.date) : "";
  if (er && erInWindow) {
    if (ps != null && ps <= -PRED_SURPRISE_SIGNAL) {
      penalty += 0.25;
      bullets.push({ tone: "bad", text: `ER ${erMd} · MISS ${ps.toFixed(1)}%` });
    } else if (prem) {
      if (prem.verdict === "cheap") penalty += 0.1;
      if (prem.verdict === "rich") penalty -= 0.05;
      bullets.push({
        tone: prem.verdict === "rich" ? "good" : prem.verdict === "cheap" ? "bad" : "warn",
        text: `ER ${erMd} · IV ±${prem.impliedMovePct.toFixed(0)}% vs hist ±${prem.fairMovePct.toFixed(0)}% (${prem.verdict})`,
      });
    } else {
      bullets.push({ tone: "warn", text: `ER ${erMd} · ${er.daysUntil}d` });
    }
  } else if (ps != null && ps >= PRED_SURPRISE_SIGNAL) {
    bullets.push({ tone: "good", text: `PredSurp +${ps.toFixed(1)}%` });
  }
  if (t.fallingKnife) {
    penalty += 0.2;
    bullets.push({ tone: "bad", text: "Falling knife" });
  }
  const cr = s?.creditRank ?? null;
  if (cr != null && cr <= CREDIT_WEAK) {
    penalty += cr <= CREDIT_SEVERE ? 0.25 : 0.15;
    bullets.push({ tone: "bad", text: `Credit ${cr}/100` });
  }
  const sf = s?.shortPctFloat ?? s?.shortPct ?? null;
  if (sf != null && sf >= SHORT_HEAVY) {
    penalty += 0.05;
    bullets.push({ tone: "warn", text: `Short ${sf.toFixed(0)}% float` });
  }

  const raw = 0.4 * street + 0.35 * premium + 0.25 * timing - penalty;
  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2, neutral: 3 };
  bullets.sort((a, b) => order[a.tone] - order[b.tone]);
  // Prefer the strongest scoring bullet — coverage.reason is ops metadata
  // ("scored by the watchlist-sync fit model"), not why this name ranks.
  const top = bullets.find((b) => b.tone === "good" || b.tone === "bad" || b.tone === "warn");
  return {
    ticker: r.ticker,
    label: r.label,
    why: top?.text ?? bullets[0]?.text ?? "No Street/premium/timing signal yet",
    score: Math.round(clamp01(raw) * 100),
    parts: { street, premium, timing, penalty },
    bullets,
  };
}

export function rankOpportunities(rows: RadarRow[]): Opportunity[] {
  return rows
    .filter((r) => !isHeld(r) && r.tech.iv != null)
    .map(scoreOpportunity)
    .sort((a, b) => b.score - a.score);
}

export function positionRisks(rows: RadarRow[]): PositionRisk[] {
  const order: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2, good: 3 };
  return rows
    .filter(isHeld)
    .map((r) => {
      if (!r.signals) return { ticker: r.ticker, tone: "neutral" as Tone, verdict: "No LSEG snapshot yet.", flags: [] };
      const i = interpretLseg({
        signals: r.signals,
        nextEarnings: r.nextEarnings,
        myPosition: r.myPosition,
        premium: premiumFor(r),
        dispersion: dispersionNote(r.signals.epsMeanFq1, r.signals.epsStdFq1, r.signals.numEstFq1),
        historyNote: earningsHistoryNote(r.pastMovesPct ?? []),
      });
      return {
        ticker: r.ticker,
        tone: i.verdict.tone,
        verdict: i.verdict.text,
        flags: i.takeaways.filter((t) => t.tone === "bad" || t.tone === "warn"),
      };
    })
    .sort((a, b) => order[a.tone] - order[b.tone] || b.flags.length - a.flags.length);
}
