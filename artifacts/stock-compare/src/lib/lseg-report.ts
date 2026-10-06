/**
 * Evidence-first LSEG report helpers (complements lseg-interpret.ts).
 * Avoids generic “lean long if oversold” filler — only cite numbers we have.
 */
import type { Interpretation, LsegSignals, Tone, TradeHints } from "./lseg-interpret.ts";
import type { EarningsPremium } from "./lseg-earnings.ts";

export type LsegEvidence = {
  claim: string;
  proof: string;
  tone: Tone;
};

export const LSEG_GLOSSARY: { term: string; def: string }[] = [
  {
    term: "StarMine ranks",
    def: "1–100 vs all North American stocks. ≥70 constructive / ≤30 weak. Different feed from Yahoo buy/hold/sell.",
  },
  {
    term: "ARM",
    def: "Analyst Revisions Model — revision quality with fresh/accurate analysts weighted more. Why it matters: high ARM often leads estimate drift.",
  },
  {
    term: "Predicted surprise",
    def: "SmartEstimate vs plain consensus for FQ1. |gap| ≥ 2% = StarMine beat/miss call. Forward-looking cousin of WRDS SUE.",
  },
  {
    term: "Combined Alpha",
    def: "Blended StarMine alpha. Soft UI only — not in fund_score until loop-B calibration. Use as overlay, not a buy button.",
  },
  {
    term: "vs Wall St. Consensus",
    def: "Breakdown Sentiment/Ratings = Yahoo/FMP opinion mix + 12M target. LSEG = StarMine + current IBES-like snapshot. Expect disagreements.",
  },
];

function fmt(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

export function buildLsegEvidence(
  s: LsegSignals,
  interp: Interpretation,
  premium: EarningsPremium | null,
): LsegEvidence[] {
  const out: LsegEvidence[] = [];

  out.push({
    claim: interp.verdict.text,
    proof: `Coverage=${interp.coverage}; votes from ARM, Combined α, pred-surprise, 30d EPS drift (see interpretLseg).`,
    tone: interp.verdict.tone,
  });

  if (s.epsMeanFy1 != null) {
    out.push({
      claim: `FY1 EPS consensus $${fmt(s.epsMeanFy1, 2)}${s.epsDrift30dPct != null ? ` · 30d drift ${s.epsDrift30dPct > 0 ? "+" : ""}${fmt(s.epsDrift30dPct)}%` : ""}`,
      proof: `${s.numEst ?? "—"} analysts · period ${s.fy1Period ?? "—"} · as of ${s.asOf}`,
      tone:
        s.epsDrift30dPct == null ? "neutral" : s.epsDrift30dPct >= 1 ? "good" : s.epsDrift30dPct <= -1 ? "bad" : "neutral",
    });
  }

  if (s.predSurprisePct != null) {
    const lean =
      s.predSurprisePct >= 2 ? "beat" : s.predSurprisePct <= -2 ? "miss" : "no strong call";
    out.push({
      claim: `Predicted surprise ${s.predSurprisePct > 0 ? "+" : ""}${fmt(s.predSurprisePct)}% → ${lean}`,
      proof: `FQ1 period end ${s.fq1PeriodEnd ?? "—"}. Threshold ±2%.`,
      tone: lean === "beat" ? "good" : lean === "miss" ? "bad" : "neutral",
    });
  }

  if (s.armRank != null || s.combinedAlphaRank != null) {
    out.push({
      claim: `StarMine ARM ${s.armRank ?? "—"}/100 · Combined α ${s.combinedAlphaRank ?? "—"}/100 · ValMo ${s.valmoRank ?? "—"}/100`,
      proof: "Ranks vs NA universe; 70+/≤30 bands match the gauges in the signal list.",
      tone:
        (s.armRank != null && s.armRank >= 70) || (s.combinedAlphaRank != null && s.combinedAlphaRank >= 70)
          ? "good"
          : (s.armRank != null && s.armRank <= 30) || (s.combinedAlphaRank != null && s.combinedAlphaRank <= 30)
            ? "bad"
            : "neutral",
    });
  }

  if (s.ptMean != null && s.ptUpsidePct != null) {
    out.push({
      claim: `Mean PT $${fmt(s.ptMean, 0)} (${s.ptUpsidePct > 0 ? "+" : ""}${fmt(s.ptUpsidePct, 0)}% vs spot)`,
      proof: s.ptUpsidePct > 150 ? "Very large upside often means stale targets — discount it." : "Street target stack, not a forecast we trade blindly.",
      tone: s.ptUpsidePct > 150 ? "warn" : "neutral",
    });
  }

  if (premium) {
    out.push({
      claim: `Earnings premium ${premium.verdict}: implied ~${fmt(premium.impliedMovePct)}% vs fair ~${fmt(premium.fairMovePct)}% (ratio ${fmt(premium.ratio, 2)})`,
      proof: premium.text,
      tone: premium.tone,
    });
  }

  const short = s.shortPctFloat ?? s.shortPct;
  if (short != null) {
    out.push({
      claim: `Short interest ${fmt(short)}% of float`,
      proof: short >= 20 ? "Crowded short — gap/squeeze risk dominates Street tone." : "Not extreme by our 20% heavy / 10% elevated bands.",
      tone: short >= 20 ? "warn" : short >= 10 ? "warn" : "neutral",
    });
  }

  return out;
}

/** Replace generic tradeHints directional fluff with evidence-tied put/call only. */
export function buildLsegTradeEvidence(
  s: LsegSignals,
  hints: TradeHints,
  premium: EarningsPremium | null,
  nextErDays: number | null,
): { side: "puts" | "calls"; stance: string; headline: string; bullets: string[] }[] {
  const ivNote =
    premium != null
      ? `Premium check: ${premium.verdict} into ${premium.expiry} (implied ${fmt(premium.impliedMovePct)}% vs fair ${fmt(premium.fairMovePct)}%).`
      : null;

  const putBullets = [hints.put.text];
  const callBullets = [hints.call.text];
  if (ivNote) {
    putBullets.push(ivNote);
    callBullets.push(ivNote);
  }
  if (s.armRank != null) {
    putBullets.push(`ARM ${s.armRank}/100 cited in Street tone.`);
    callBullets.push(`ARM ${s.armRank}/100 cited in Street tone.`);
  }
  if (nextErDays != null && nextErDays <= 21) {
    putBullets.push(`Next earnings in ${nextErDays}d — expiries after the print embed gap risk regardless of StarMine tone.`);
    callBullets.push(`Next earnings in ${nextErDays}d — same gap caveat for short calls.`);
  }
  // Explicitly do NOT add "lean long if oversold" — user rejected that class of advice.

  return [
    {
      side: "puts",
      stance: hints.put.tone,
      headline: hints.put.tone === "good" ? "Street not fighting put sells" : hints.put.tone === "bad" ? "Street fighting put sells" : "No clear put edge from LSEG",
      bullets: putBullets,
    },
    {
      side: "calls",
      stance: hints.call.tone,
      headline: hints.call.tone === "good" ? "Street softer for covered calls" : hints.call.tone === "warn" ? "Upside risk for short calls" : "No clear call edge from LSEG",
      bullets: callBullets,
    },
  ];
}

export function lsegRankChartData(s: LsegSignals) {
  return [
    { name: "ARM", value: s.armRank },
    { name: "Comb α", value: s.combinedAlphaRank },
    { name: "ValMo", value: s.valmoRank },
    { name: "Price Mo", value: s.priceMoRank ?? null },
    { name: "RelVal", value: s.relValRank ?? null },
    { name: "Credit", value: s.creditRank ?? null },
  ].filter((r) => r.value != null) as { name: string; value: number }[];
}
