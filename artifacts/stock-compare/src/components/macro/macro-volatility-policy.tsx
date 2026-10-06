import { Activity, Landmark, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  VolatilityImplications, VolatilitySignal, FedFundsCurvePoint, SepData, MacroEvent,
} from "./macro-page-types";
import { VOLATILITY_LEVEL_STYLE, VOLATILITY_LEVEL_LABEL } from "./macro-format";
import { EventRow } from "./macro-events-cot";
import { derivePolicySignals } from "./macro-policy-signals.ts";

const DOT_TEXT: Record<VolatilitySignal["level"], string> = {
  calm: "text-green-400", normal: "text-sky-300/80", elevated: "text-yellow-400",
  stress: "text-red-400", unknown: "text-amber-200/40",
};

// ── Volatility implications read card ───────────────────────────────────────────

export function VolatilityImplicationsCard({
  data, loading,
}: {
  data: VolatilityImplications | undefined;
  loading?: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-20">
        <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
      </div>
    );
  }

  const overallStyle = VOLATILITY_LEVEL_STYLE[data.overall.level];

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <Activity className="h-3.5 w-3.5 text-[#d4af37]/80" />
          Volatility Regime Read
        </span>
        <span className={cn("px-1.5 py-0.5 rounded border text-[10px] font-semibold", overallStyle.badge)}>
          {VOLATILITY_LEVEL_LABEL[data.overall.level]}
        </span>
      </div>
      <p className={cn("text-xs font-mono", overallStyle.text)}>{data.overall.summary}</p>
      <span className="block text-[11px] font-mono text-sky-300/60">
        {data.signals.map((sg, i) => (
          <span key={sg.label} title={sg.implication}>
            {i > 0 && " · "}
            <span className={DOT_TEXT[sg.level]}>{sg.label}</span>
            {` ${sg.readout}`}
          </span>
        ))}
      </span>
    </div>
  );
}

// ── Policy / CSP-sizing read card ───────────────────────────────────────────────

export { derivePolicySignals, type PolicySignal } from "./macro-policy-signals.ts";

export function PolicyCspSummary({
  fedFundsCurve, sepData, events, volatilityImplications, todayStr, onViewRegime, loading,
}: {
  fedFundsCurve: FedFundsCurvePoint[];
  sepData: SepData | undefined;
  events: MacroEvent[] | undefined;
  volatilityImplications: VolatilityImplications | undefined;
  todayStr: string;
  onViewRegime: () => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-20">
        <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
      </div>
    );
  }

  const { signals, overall, nextEvent } = derivePolicySignals(fedFundsCurve, sepData, events, volatilityImplications);
  const overallStyle = VOLATILITY_LEVEL_STYLE[overall.level];

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <Landmark className="h-3.5 w-3.5 text-[#d4af37]/80" />
          Policy CSP Read
        </span>
        <span className={cn("px-1.5 py-0.5 rounded border text-[10px] font-semibold", overallStyle.badge)}>
          {VOLATILITY_LEVEL_LABEL[overall.level]}
        </span>
      </div>
      <p className={cn("text-xs font-mono", overallStyle.text)}>{overall.summary}</p>
      <span className="block text-[11px] font-mono text-sky-300/60">
        {signals.map((sg, i) => (
          <span key={sg.label} title={sg.implication}>
            {i > 0 && " · "}
            <span className={DOT_TEXT[sg.level]}>{sg.label}</span>
            {` ${sg.readout}`}
          </span>
        ))}
      </span>
      {nextEvent && <EventRow event={nextEvent} todayStr={todayStr} />}
      <div className="flex items-center justify-end">
        <button onClick={onViewRegime} className="text-[11px] text-[#d4af37]/80 hover:text-[#d4af37] hover:underline shrink-0 whitespace-nowrap">
          See regime implications &rarr;
        </button>
      </div>
    </div>
  );
}
