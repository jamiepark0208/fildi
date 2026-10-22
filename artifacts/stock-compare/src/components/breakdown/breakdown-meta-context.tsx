/**
 * Breakdown-scoped provenance tips — one provenance fetch + score/tech/quote meta.
 * Consumers call tipForField / tipForDerived; no extra network.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  formatDerivedTip,
  formatProvenanceTip,
  joinTips,
  type ProvTipField,
} from "@/lib/provenance-display";
import type { ScoreEvidence, TradeOverlay } from "./stock-breakdown-parts";

type QuoteMeta = {
  source?: string | null;
  asOf?: string | null;
};

type BreakdownMeta = {
  byField: Map<string, ProvTipField>;
  score: ScoreEvidence | null | undefined;
  trade: TradeOverlay | null | undefined;
  quote: QuoteMeta | null | undefined;
  tipForField: (fieldKey: string | undefined | null, meaning?: string) => string | undefined;
  tipFundPillar: (pillar: "V" | "G" | "Q" | "S" | "Tot" | "Desk") => string | undefined;
  tipTrade: (key: "tech" | "ivRv" | "iv" | "er") => string | undefined;
  tipQuote: (label?: string) => string | undefined;
};

const Ctx = createContext<BreakdownMeta | null>(null);

export function BreakdownMetaProvider({
  byField,
  score,
  trade,
  quote,
  children,
}: {
  byField: Map<string, ProvTipField>;
  score?: ScoreEvidence | null;
  trade?: TradeOverlay | null;
  quote?: QuoteMeta | null;
  children: ReactNode;
}) {
  const value = useMemo<BreakdownMeta>(() => {
    const tipForField = (fieldKey: string | undefined | null, meaning?: string) => {
      if (!fieldKey) return meaning;
      const prov = formatProvenanceTip(byField.get(fieldKey));
      return joinTips(meaning, prov ?? `field ${fieldKey} · no provenance row`);
    };
    const tipFundPillar = (pillar: "V" | "G" | "Q" | "S" | "Tot" | "Desk") => {
      const label =
        pillar === "V" ? "Value pillar" :
        pillar === "G" ? "Growth pillar" :
        pillar === "Q" ? "Quality pillar" :
        pillar === "S" ? "Safety pillar" :
        pillar === "Desk" ? "Desk-adjusted fund score" :
        "Fund total score";
      return formatDerivedTip({
        label,
        kind: "computed",
        source: "peer-relative fund model",
        asOf: score?.scoredAt ?? score?.inputsAsOf,
        cadenceKey: "fund_score",
        extra: [
          score?.inputsAsOf ? `inputs ${score.inputsAsOf.slice(0, 10)}` : null,
          score?.coverage != null ? `coverage ${(score.coverage * 100).toFixed(0)}%` : null,
          pillar === "Desk" && score?.activeAdjPoints
            ? `desk adj ${score.activeAdjPoints >= 0 ? "+" : ""}${score.activeAdjPoints}`
            : null,
        ].filter(Boolean) as string[],
      });
    };
    const tipTrade = (key: "tech" | "ivRv" | "iv" | "er") => {
      if (key === "tech") {
        return formatDerivedTip({
          label: "Technical score",
          kind: "computed",
          source: "ticker_technicals → V2 scorer",
          asOf: trade?.techAsOf,
          cadenceKey: "tech_score",
        });
      }
      if (key === "ivRv") {
        return formatDerivedTip({
          label: "IV/RV",
          kind: "derived",
          source: "ATM put IV ÷ 20d realized vol",
          asOf: trade?.techAsOf,
          cadenceKey: "option_score",
        });
      }
      if (key === "iv") {
        return formatDerivedTip({
          label: "ATM put IV",
          kind: "sourced",
          source: "options chain → ticker_technicals",
          asOf: trade?.techAsOf,
          cadenceKey: "option_score",
        });
      }
      return formatDerivedTip({
        label: "Earnings days out",
        kind: "sourced",
        source: "earnings_calendar",
        asOf: trade?.techAsOf,
        cadenceKey: "earnings",
      });
    };
    const tipQuote = (label = "Price") =>
      formatDerivedTip({
        label,
        kind: "sourced",
        source: quote?.source ? `${quote.source} (live ≤60s cache)` : "live quote (Schwab→Yahoo)",
        asOf: quote?.asOf ?? null,
        // Live quote — not a daily CHECKS table; skip cadence (null key).
      });
    return { byField, score, trade, quote, tipForField, tipFundPillar, tipTrade, tipQuote };
  }, [byField, score, trade, quote]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBreakdownMeta(): BreakdownMeta | null {
  return useContext(Ctx);
}
