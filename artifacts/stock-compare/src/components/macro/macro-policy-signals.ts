// Policy / CSP-sizing read: pure logic behind PolicyCspSummary (kept out of the .tsx so it is unit-testable).
import type {
  VolatilityImplications, VolatilitySignal, FedFundsCurvePoint, SepData, MacroEvent,
} from "./macro-page-types";
import { VOLATILITY_LEVEL_LABEL } from "./macro-format.ts";

export type PolicySignal = { label: string; level: VolatilitySignal["level"]; readout: string; implication: string };

const CSP_LEVEL_SCORE: Record<VolatilitySignal["level"], number> = {
  calm: 1, normal: 0, elevated: -1, stress: -2, unknown: 0,
};

export function derivePolicySignals(
  fedFundsCurve: FedFundsCurvePoint[],
  sepData: SepData | undefined,
  events: MacroEvent[] | undefined,
  volatilityImplications: VolatilityImplications | undefined,
): { signals: PolicySignal[]; overall: { level: VolatilitySignal["level"]; summary: string }; nextEvent: MacroEvent | null } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. Fed dots vs. market-implied rate path (falls back to WoW curve drift if SEP not loaded)
  const dotsSignal: PolicySignal = (() => {
    const curvePts = fedFundsCurve.filter((p) => p.impliedRate != null);
    const farthest = curvePts[curvePts.length - 1];
    if (sepData?.projections?.length && farthest) {
      const farYear = new Date(farthest.meetingDate + "T12:00:00").getFullYear();
      const proj = sepData.projections.find((p) => p.year === farYear) ?? sepData.projections[sepData.projections.length - 1];
      if (proj?.fedRate != null && farthest.impliedRate != null) {
        const diff = farthest.impliedRate - proj.fedRate;
        const level: VolatilitySignal["level"] =
          Math.abs(diff) < 0.125 ? "calm" : Math.abs(diff) < 0.375 ? "normal" : Math.abs(diff) < 0.75 ? "elevated" : "stress";
        return {
          label: "Fed Dots vs. Market",
          level,
          readout: `${proj.year} dots ${proj.fedRate.toFixed(2)}% · mkt ${farthest.impliedRate.toFixed(2)}%`,
          implication: diff < -0.05
            ? `Market is pricing looser policy than the Fed's own ${proj.year} dot — a hawkish surprise (fewer/later cuts) is the bigger tail risk for short premium.`
            : diff > 0.05
            ? `Market is pricing tighter/higher rates than the Fed's own ${proj.year} dot — a dovish surprise (faster cuts) is the bigger tail risk.`
            : "Market pricing is closely aligned with the Fed's own dot plot — low event risk from a dots/market gap alone.",
        };
      }
    }
    const front = curvePts[0];
    if (front?.impliedRate != null && front.weekAgo != null) {
      const diff = front.impliedRate - front.weekAgo;
      const level: VolatilitySignal["level"] =
        Math.abs(diff) < 0.03 ? "calm" : Math.abs(diff) < 0.08 ? "normal" : Math.abs(diff) < 0.15 ? "elevated" : "stress";
      return {
        label: "Rate Path (WoW)",
        level,
        readout: `${front.label} ${front.impliedRate.toFixed(2)}% (${diff >= 0 ? "+" : ""}${diff.toFixed(2)} wk)`,
        implication: diff < 0
          ? "Markets added rate-cut pricing this week — front-end yields easing."
          : diff > 0
          ? "Markets pared rate-cut pricing this week — front-end yields firming."
          : "Front-end rate pricing was flat week-over-week.",
      };
    }
    return { label: "Rate Path", level: "unknown", readout: "—", implication: "Fed funds curve data not yet available." };
  })();

  // 2. Next high-importance catalyst (FOMC / CPI / NFP or importance="high")
  const nextEvent = (events ?? [])
    .filter((e) => {
      const d = new Date(e.date + "T12:00:00");
      return d >= today && (e.importance === "high" || /FOMC|CPI|NFP/i.test(e.event));
    })
    .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

  const eventSignal: PolicySignal = (() => {
    if (!nextEvent) {
      return { label: "Next Catalyst", level: "unknown", readout: "—", implication: "No high-importance events on the calendar right now." };
    }
    // Midnight-to-midnight (a noon anchor made an event today read as "tomorrow").
    const days = Math.round((new Date(nextEvent.date + "T00:00:00").getTime() - today.getTime()) / 86_400_000);
    const level: VolatilitySignal["level"] = days <= 0 ? "stress" : days <= 2 ? "elevated" : days <= 7 ? "normal" : "calm";
    return {
      label: "Next Catalyst",
      level,
      readout: `${nextEvent.event} · ${days <= 0 ? "today" : days === 1 ? "tomorrow" : `${days}d`}`,
      implication: days <= 2
        ? "High-importance print imminent — vol/skew often builds into it; weigh timing new CSP entries around the release."
        : "On the radar but not immediate — routine sizing until closer to the date.",
    };
  })();

  // 3. Vol backdrop / CSP sizing — reuse the Volatility tab's already-computed verdict, no new classifier
  const volSignal: PolicySignal = volatilityImplications
    ? {
        label: "Vol / CSP Sizing",
        level: volatilityImplications.overall.level,
        readout: VOLATILITY_LEVEL_LABEL[volatilityImplications.overall.level],
        implication: volatilityImplications.overall.summary,
      }
    : { label: "Vol / CSP Sizing", level: "unknown", readout: "—", implication: "Volatility data not yet loaded." };

  const signals = [dotsSignal, eventSignal, volSignal];
  const known = signals.filter((s) => s.level !== "unknown");
  const avg = known.length ? known.reduce((sum, s) => sum + CSP_LEVEL_SCORE[s.level], 0) / known.length : 0;
  const overallLevel: VolatilitySignal["level"] =
    avg >= 0.5 ? "calm" : avg >= -0.4 ? "normal" : avg >= -1.2 ? "elevated" : "stress";
  const overallSummary =
    overallLevel === "calm" ? "Policy path, catalysts, and vol backdrop all look routine — no reason to size down from a policy-risk lens alone." :
    overallLevel === "stress" ? "Multiple policy signals are flashing at once — dots/market divergence, an imminent catalyst, or elevated vol. Worth sizing down or favoring defined-risk into it." :
    overallLevel === "elevated" ? "At least one policy signal is running hot — not alarm-bell territory, but a reasonable prompt to trim size or tighten strikes." :
    "Policy signals are mixed — no single channel dominates the picture right now.";

  return { signals, overall: { level: overallLevel, summary: overallSummary }, nextEvent };
}
