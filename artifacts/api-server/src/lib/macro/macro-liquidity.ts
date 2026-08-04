// Liquidity implications. Extracted verbatim from macro-data.ts — no behavior change.
// Turns the raw plumbing series into a plain-language regime read, the way
// dealer/Fed liquidity notes do: net liquidity trend, whether the RRP buffer
// still cushions QT, reserve scarcity (SOFR-IORB), financial conditions (NFCI),
// and credit stress (HY OAS). Thresholds are directional heuristics, not
// precise research citations — the point is a repeatable qualitative read.
import type { ChartPoint, LiquiditySignal, LiquidityImplications } from "../macro-data.js";
import { sortedByDate, valueDaysAgo } from "./macro-utils.js";

const LEVEL_SCORE: Record<LiquiditySignal["level"], number> = {
  supportive: 1, neutral: 0, draining: -1, stress: -2, unknown: 0,
};

export function computeLiquidityImplications(
  netLiquidityHistory: ChartPoint[],
  rrpHistory: ChartPoint[],
  nfciHistory: ChartPoint[],
  hySpreadHistory: ChartPoint[],
  sofrIorbSpreadHistory: ChartPoint[],
): LiquidityImplications {
  const signals: LiquiditySignal[] = [];

  // 1. Net liquidity trend (~3mo rate of change)
  {
    const s = sortedByDate(netLiquidityHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    const past = valueDaysAgo(s, 91);
    if (latest != null && past != null && past !== 0) {
      const deltaB = latest - past;
      const pct = (deltaB / Math.abs(past)) * 100;
      const level: LiquiditySignal["level"] = pct > 2 ? "supportive" : pct < -2 ? "draining" : "neutral";
      signals.push({
        label: "Net Liquidity",
        level,
        readout: `${deltaB >= 0 ? "+" : ""}$${deltaB.toFixed(0)}B over 3mo (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`,
        implication: level === "supportive"
          ? "Fed assets minus TGA/RRP drains are net expanding — a tailwind for risk-asset valuations."
          : level === "draining"
          ? "Net liquidity is contracting — a headwind that has historically coincided with equity multiple compression."
          : "Net liquidity is roughly flat — no strong directional pull from the plumbing right now.",
      });
    }
  }

  // 2. RRP buffer — does it still cushion QT, or is it exhausted?
  {
    const s = sortedByDate(rrpHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    const past = valueDaysAgo(s, 91);
    if (latest != null) {
      const trendDown = past != null && latest < past;
      const level: LiquiditySignal["level"] =
        latest > 300 && trendDown ? "supportive" :
        latest < 75 ? "draining" :
        "neutral";
      signals.push({
        label: "RRP Buffer",
        level,
        readout: `$${latest.toFixed(0)}B outstanding`,
        implication: level === "supportive"
          ? "RRP is still draining into the system, offsetting QT — the cushion has more room to absorb balance-sheet runoff."
          : level === "draining"
          ? "RRP buffer is nearly exhausted — further QT will start hitting bank reserves directly instead of being cushioned."
          : "RRP buffer is at a moderate level — partial cushion left against further balance-sheet runoff.",
      });
    }
  }

  // 3. Reserve scarcity — SOFR vs IORB spread (bps)
  {
    const s = sortedByDate(sofrIorbSpreadHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: LiquiditySignal["level"] =
        latest <= 0 ? "supportive" :
        latest <= 5 ? "neutral" :
        latest <= 15 ? "draining" :
        "stress";
      signals.push({
        label: "Reserve Scarcity (SOFR-IORB)",
        level,
        readout: `${latest >= 0 ? "+" : ""}${latest.toFixed(1)}bps`,
        implication: level === "stress"
          ? "SOFR printing well above IORB — a classic reserve-scarcity signal seen before repo funding stress (e.g. Sep 2019)."
          : level === "draining"
          ? "SOFR is drifting above IORB — reserves are getting less abundant, worth watching for repo-market pressure."
          : "SOFR is trading at or below IORB — reserves remain ample and repo funding is orderly.",
      });
    }
  }

  // 4. Financial conditions — Chicago Fed NFCI level
  {
    const s = sortedByDate(nfciHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: LiquiditySignal["level"] =
        latest < -0.1 ? "supportive" :
        latest <= 0.1 ? "neutral" :
        latest <= 0.5 ? "draining" :
        "stress";
      signals.push({
        label: "Financial Conditions (NFCI)",
        level,
        readout: `${latest >= 0 ? "+" : ""}${latest.toFixed(2)}`,
        implication: level === "stress"
          ? "Financial conditions are tight relative to history — this level has historically preceded risk-asset drawdowns."
          : level === "draining"
          ? "Financial conditions are tightening above trend — a mild headwind for risk appetite."
          : level === "supportive"
          ? "Financial conditions are looser than average — supportive of risk-taking."
          : "Financial conditions are near their historical average — a neutral backdrop.",
      });
    }
  }

  // 5. Credit stress — HY OAS level (series is in percent, e.g. 3.03 = 3.03% = 303bps)
  {
    const s = sortedByDate(hySpreadHistory);
    const latestPct = s.length ? s[s.length - 1].value : null;
    const pastPct = valueDaysAgo(s, 91);
    if (latestPct != null) {
      const latest = latestPct * 100; // bps
      const past = pastPct != null ? pastPct * 100 : null;
      const rising50bp = past != null && (latest - past) > 50;
      const level: LiquiditySignal["level"] =
        latest > 500 || rising50bp ? "stress" :
        latest > 400 ? "draining" :
        latest < 350 ? "supportive" :
        "neutral";
      signals.push({
        label: "Credit Stress (HY OAS)",
        level,
        readout: `${latest.toFixed(0)}bps`,
        implication: level === "stress"
          ? "High-yield spreads are wide or widening sharply — credit markets are pricing in real liquidity/default stress."
          : level === "supportive"
          ? "High-yield spreads are tight — credit markets see ample liquidity and low near-term default risk."
          : "High-yield spreads are in a middling range — credit isn't signaling stress, but isn't complacent either.",
      });
    }
  }

  const known = signals.filter(sg => sg.level !== "unknown");
  const avgScore = known.length
    ? known.reduce((sum, sg) => sum + LEVEL_SCORE[sg.level], 0) / known.length
    : 0;
  const overallLevel: LiquidityImplications["overall"]["level"] =
    avgScore >= 0.5 ? "supportive" :
    avgScore >= -0.4 ? "neutral" :
    avgScore >= -1.2 ? "draining" :
    "stress";
  const overallSummary =
    overallLevel === "supportive" ? "Liquidity conditions are net supportive for risk assets — plumbing, reserves, and credit are all in benign territory." :
    overallLevel === "stress" ? "Liquidity conditions are showing real stress across multiple channels — a regime that has historically warranted defensive positioning." :
    overallLevel === "draining" ? "Liquidity conditions are net draining — several channels are tightening, a headwind worth monitoring closely." :
    "Liquidity conditions are mixed/neutral — no single channel is dominating the picture right now.";

  return {
    asOf: new Date().toISOString(),
    signals,
    overall: { level: overallLevel, summary: overallSummary },
  };
}
