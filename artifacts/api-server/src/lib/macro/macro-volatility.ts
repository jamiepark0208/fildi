// Volatility implications. Extracted verbatim from macro-data.ts — no behavior change.
import type { ChartPoint, VixCurvePoint, VolatilitySignal, VolatilityImplications } from "../macro-data.js";
import { sortedByDate } from "./macro-utils.js";

const VOL_LEVEL_SCORE: Record<VolatilitySignal["level"], number> = {
  calm: 1, normal: 0, elevated: -1, stress: -2, unknown: 0,
};

export function computeVolatilityImplications(
  vixHistory: ChartPoint[],
  vixCurve: VixCurvePoint[],
  vvixHistory: ChartPoint[],
  putCallRatioHistory: ChartPoint[],
  hySpreadHistory: ChartPoint[],
  moveHistory: ChartPoint[],
): VolatilityImplications {
  const signals: VolatilitySignal[] = [];

  // 1. VIX level — the baseline fear gauge
  {
    const s = sortedByDate(vixHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: VolatilitySignal["level"] =
        latest < 15 ? "calm" : latest <= 20 ? "normal" : latest <= 30 ? "elevated" : "stress";
      signals.push({
        label: "VIX Level",
        level,
        readout: latest.toFixed(1),
        implication: level === "stress"
          ? "VIX is in fear territory — option premium is rich; this favors buying protection/hedges over selling premium."
          : level === "elevated"
          ? "VIX is elevated above its calm range — premium is getting richer, worth favoring defined-risk or reduced size on new option-selling entries."
          : level === "calm"
          ? "VIX is quiet — option premium is cheap, a better environment for buying optionality than for selling it."
          : "VIX is in its normal range — no strong edge either buying or selling premium off level alone.",
      });
    }
  }

  // 2. VIX term structure — 30D vs 3M tenor shape (contango vs backwardation)
  {
    const front = vixCurve.find(p => p.tenor === "30D")?.value ?? null;
    const back  = vixCurve.find(p => p.tenor === "93D")?.value ?? null;
    if (front != null && back != null) {
      const spread = front - back; // positive = backwardation
      const level: VolatilitySignal["level"] =
        spread > 3 ? "stress" : spread > 1 ? "elevated" : spread > -1 ? "normal" : "calm";
      signals.push({
        label: "VIX Term Structure",
        level,
        readout: `${spread >= 0 ? "+" : ""}${spread.toFixed(1)}pts (30D vs 3M)`,
        implication: level === "stress" || level === "elevated"
          ? "Curve is in backwardation — the market is pricing near-term risk above longer-run risk, a pattern seen near acute stress events and panic lows."
          : level === "calm"
          ? "Curve is in steep contango — the normal, complacent state that favors carry/premium-selling strategies."
          : "Curve is in mild contango — a normal, unremarkable term structure.",
      });
    }
  }

  // 3. VVIX — demand for tail-risk hedges (vol of vol)
  {
    const s = sortedByDate(vvixHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: VolatilitySignal["level"] =
        latest < 90 ? "calm" : latest <= 100 ? "normal" : latest <= 120 ? "elevated" : "stress";
      signals.push({
        label: "VVIX (Vol of VIX)",
        level,
        readout: latest.toFixed(0),
        implication: level === "stress"
          ? "VVIX is at panic levels — heavy demand for tail-risk hedges, which can itself amplify dealer gamma-hedging flows and moves."
          : level === "elevated"
          ? "VVIX is elevated — tail-hedging demand is building faster than the VIX level alone suggests."
          : "VVIX is in a normal range — no unusual demand for crash protection beyond what VIX already implies.",
      });
    }
  }

  // 4. Put/call ratio — contrarian sentiment extreme
  {
    const s = sortedByDate(putCallRatioHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: VolatilitySignal["level"] =
        latest > 1.3 ? "stress" : latest > 1.0 ? "elevated" : latest >= 0.7 ? "normal" : "calm";
      signals.push({
        label: "Put/Call Ratio",
        level,
        readout: latest.toFixed(2),
        implication: level === "stress"
          ? "Put buying is extreme — heavy hedging/fear, which is often a contrarian bullish signal at extremes."
          : level === "elevated"
          ? "Put/call is skewed toward puts — the market is leaning defensive."
          : level === "calm"
          ? "Put/call is low — call-heavy positioning can reflect complacency, itself a contrarian risk to watch."
          : "Put/call is in a normal range — no extreme positioning either way.",
      });
    }
  }

  // 5. Credit cross-check — does HY OAS confirm or diverge from the vol signal
  {
    const s = sortedByDate(hySpreadHistory);
    const latestPct = s.length ? s[s.length - 1].value : null;
    if (latestPct != null) {
      const latest = latestPct * 100; // bps
      const level: VolatilitySignal["level"] =
        latest > 500 ? "stress" : latest > 400 ? "elevated" : latest < 350 ? "calm" : "normal";
      signals.push({
        label: "Credit Cross-Check (HY OAS)",
        level,
        readout: `${latest.toFixed(0)}bps`,
        implication: level === "stress" || level === "elevated"
          ? "Credit spreads are wide/widening alongside vol — this confirms a genuine risk-off event rather than a technical air-pocket."
          : "Credit spreads are tight — if equity vol is elevated without credit confirmation, it's more likely a technical/liquidity move that tends to mean-revert faster.",
      });
    }
  }

  // 6. MOVE index — bond market (rates) vol, which often leads equity vol
  {
    const s = sortedByDate(moveHistory);
    const latest = s.length ? s[s.length - 1].value : null;
    if (latest != null) {
      const level: VolatilitySignal["level"] =
        latest < 90 ? "calm" : latest <= 110 ? "normal" : latest <= 140 ? "elevated" : "stress";
      signals.push({
        label: "MOVE Index (Bond Vol)",
        level,
        readout: latest.toFixed(0),
        implication: level === "stress" || level === "elevated"
          ? "Rates volatility is elevated — bond-market vol has historically led equity-vol spikes (e.g. 2022 rate shocks, 2023 SVB), worth watching even if VIX looks calm."
          : "Rates volatility is contained — no cross-asset warning from the bond market right now.",
      });
    }
  }

  const known = signals.filter(sg => sg.level !== "unknown");
  const avgScore = known.length
    ? known.reduce((sum, sg) => sum + VOL_LEVEL_SCORE[sg.level], 0) / known.length
    : 0;
  const overallLevel: VolatilityImplications["overall"]["level"] =
    avgScore >= 0.5 ? "calm" :
    avgScore >= -0.4 ? "normal" :
    avgScore >= -1.2 ? "elevated" :
    "stress";
  const overallSummary =
    overallLevel === "calm" ? "Vol is broadly quiet across equity and rates markets, with no confirming credit stress — a benign backdrop, though complacency itself is worth flagging at extremes." :
    overallLevel === "stress" ? "Multiple channels confirm a genuine risk-off vol regime — equity vol, term structure, tail hedging, and often credit are all flashing together. Historically warrants defensive positioning; hedges are relatively attractively priced." :
    overallLevel === "elevated" ? "Vol is elevated across several channels but not yet at extremes — a regime worth reducing size or favoring defined-risk structures in, not panicking over." :
    "Vol signals are mixed/normal — no single channel is dominating the picture right now.";

  return {
    asOf: new Date().toISOString(),
    signals,
    overall: { level: overallLevel, summary: overallSummary },
  };
}
