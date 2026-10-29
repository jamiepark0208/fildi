/**
 * A213 — calibrated put odds from watchlist_sync.pick_odds / position_odds.
 * Value first; evidence tags on hover (calibrated / backtest / base rate).
 */
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type OddsEvidence = { value: number | null; evidence?: string };

export type PickOdds = {
  strike?: number;
  expiry?: string;
  spot?: number;
  iv?: number;
  p_otm?: OddsEvidence;
  p_profit?: OddsEvidence;
  p_touch?: OddsEvidence;
  range_68?: [number, number];
  range_95?: [number, number];
  if_assigned?: {
    n?: number;
    back_above_strike_63d?: number;
    net_positive_63d?: number;
    evidence?: string;
  };
  bounce_5d?: OddsEvidence;
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

function evidenceKind(ev?: string): "calibrated" | "backtest" | "base rate" | "model" {
  const s = (ev ?? "").toLowerCase();
  if (s.includes("base rate")) return "base rate";
  if (s.includes("backtest")) return "backtest";
  if (s.includes("calibrated")) return "calibrated";
  return "model";
}

function Chip({
  label, value, evidence, emphasize,
}: { label: string; value: number | null | undefined; evidence?: string; emphasize?: boolean }) {
  const kind = evidenceKind(evidence);
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex flex-col items-start rounded px-1.5 py-0.5 border border-[#d4af37]/20 bg-zinc-900/80",
            emphasize && "border-[#d4af37]/45",
          )}
        >
          <span className="text-[8px] uppercase tracking-wider text-amber-100/80">{label}</span>
          <span className={cn("font-mono tabular-nums leading-tight", emphasize ? "text-lg text-[#d4af37]" : "text-[12px] text-zinc-100")}>
            {pct(value)}
          </span>
          <span className="text-[8px] text-zinc-600">{kind}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
        <div className="font-semibold mb-0.5">{label}: {pct(value)}</div>
        <div className="text-amber-100">{evidence || kind}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Horizontal bar: 95% band outer, 68% inner, spot + strike markers. */
function ExpiryRangeBar({
  spot, strike, range68, range95,
}: {
  spot: number; strike: number;
  range68: [number, number]; range95: [number, number];
}) {
  const lo = Math.min(range95[0], range68[0], spot, strike);
  const hi = Math.max(range95[1], range68[1], spot, strike);
  if (!(hi > lo)) return null;
  const x = (p: number) => `${((p - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="space-y-0.5">
      <div className="text-[8px] uppercase tracking-wider text-amber-100/80">Price at expiry</div>
      <div className="relative h-3 rounded bg-zinc-800/80 overflow-hidden">
        <div
          className="absolute inset-y-0 bg-amber-500/15"
          style={{ left: x(range95[0]), width: `calc(${x(range95[1])} - ${x(range95[0])})` }}
          title="95% band"
        />
        <div
          className="absolute inset-y-0 bg-amber-400/30"
          style={{ left: x(range68[0]), width: `calc(${x(range68[1])} - ${x(range68[0])})` }}
          title="68% band"
        />
        <div className="absolute top-0 bottom-0 w-px bg-sky-300" style={{ left: x(spot) }} title={`spot ${spot.toFixed(2)}`} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-rose-400" style={{ left: x(strike) }} title={`strike ${strike}`} />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-amber-100/80 tabular-nums">
        <span>${range95[0].toFixed(1)}</span>
        <span className="text-sky-300/80">spot ${spot.toFixed(2)}</span>
        <span className="text-rose-300/80">K ${strike}</span>
        <span>${range95[1].toFixed(1)}</span>
      </div>
    </div>
  );
}

export function PickOddsPanel({ odds, className }: { odds: PickOdds | null | undefined; className?: string }) {
  if (!odds?.p_otm) return null;
  const spot = odds.spot;
  const strike = odds.strike;
  const asg = odds.if_assigned?.back_above_strike_63d;
  return (
    <div className={cn("rounded-md border border-[#d4af37]/20 bg-zinc-950/80 px-2 py-1.5 space-y-1.5", className)}>
      <div className="text-[9px] uppercase tracking-[0.12em] text-amber-100/80">Put odds</div>
      <div className="flex flex-wrap gap-1.5 items-end">
        <Chip label="Expire OTM" value={odds.p_otm.value} evidence={odds.p_otm.evidence} emphasize />
        <Chip label="P(profit)" value={odds.p_profit?.value} evidence={odds.p_profit?.evidence} />
        <Chip label="P(touch K)" value={odds.p_touch?.value} evidence={odds.p_touch?.evidence} />
      </div>
      {spot != null && strike != null && odds.range_68 && odds.range_95 && (
        <ExpiryRangeBar spot={spot} strike={strike} range68={odds.range_68} range95={odds.range_95} />
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-amber-100">
        {asg != null && (
          <Tooltip delayDuration={120}>
            <TooltipTrigger asChild>
              <span>
                If assigned: back above strike in 63d{" "}
                <span className="font-mono text-zinc-200">{pct(asg)}</span>
                <span className="text-zinc-600"> · backtest</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
              {odds.if_assigned?.evidence ?? "S064 holdout"}
            </TooltipContent>
          </Tooltip>
        )}
        {odds.bounce_5d?.value != null && (
          <Tooltip delayDuration={120}>
            <TooltipTrigger asChild>
              <span>
                5d up base rate{" "}
                <span className="font-mono text-zinc-200">{pct(odds.bounce_5d.value)}</span>
                <span className="text-zinc-600"> — no reversal signal (S025)</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
              {odds.bounce_5d.evidence}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
