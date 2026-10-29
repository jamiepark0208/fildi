import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

export interface FairValueVote { name: string; value: number; kept: boolean }

const METHOD_LABELS: Record<string, string> = {
  peerForwardPe: "Peer forward P/E",
  warrantedPe: "Growth-adjusted P/E",
  grahamForward: "Graham (revised)",
  ohlsonJuettner: "Earnings-growth model",
  dcfFcfe: "Cash-flow DCF",
  peerEvEbitda: "Peer EV/EBITDA",
  excessReturns: "Book value + excess ROE",
  peerPffo: "Peer P/FFO",
  analystTarget: "Analyst target (de-biased)",
  starmine: "StarMine intrinsic",
};

const CONFIDENCE_STYLE: Record<string, string> = {
  high: "border-emerald-400/70 bg-zinc-900 text-white",
  medium: "border-sky-400/70 bg-zinc-900 text-white",
  low: "border-zinc-400/50 bg-zinc-900 text-white",
};

/** Blended fair value tag with a popover showing every method's vote (Breakdown header). */
export function FairValueBadge({
  ticker,
  fairValue, low, high, confidence, impliedGrowth, votes, asOf, price, change3m, cyclical, valueTrap,
}: {
  /** Needed for A284 outside estimates fetch (on open only). */
  ticker?: string;
  fairValue: number;
  low?: number | null;
  high?: number | null;
  confidence?: string | null;
  impliedGrowth?: number | null;
  votes?: FairValueVote[];
  asOf?: string | null;
  price?: number | null;
  change3m?: number | null;
  cyclical?: boolean;
  valueTrap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const conf = confidence ?? "low";
  const gap = price != null && price > 0 ? (fairValue / price - 1) * 100 : null;
  const label = `Fair Value ${formatCurrency(fairValue)}${valueTrap ? " · value-trap risk" : conf === "low" ? " · low conf." : ""}`;
  const badgeClass = cn(
    "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border transition-colors cursor-pointer hover:brightness-125",
    CONFIDENCE_STYLE[conf] ?? CONFIDENCE_STYLE.low,
  );
  const sorted = [...(votes ?? [])].sort((a, b) => a.value - b.value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={badgeClass}>{label}</button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="start">
        <div className="px-3 py-2 border-b border-zinc-700/60 bg-zinc-800/90 space-y-0.5">
          <div className="flex items-baseline justify-between">
            <span className="text-zinc-100 font-semibold">{formatCurrency(fairValue)}</span>
            {gap != null && (
              <span className={cn("font-mono", gap >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {gap >= 0 ? "+" : ""}{gap.toFixed(0)}% vs price
              </span>
            )}
          </div>
          <div className="text-amber-100 text-[11px]">
            {low != null && high != null ? `Range ${formatCurrency(low)} – ${formatCurrency(high)} · ` : ""}
            {conf} confidence
          </div>
        </div>
        <div className="px-3 py-2 space-y-1">
          {sorted.map((v) => (
            <div key={v.name} className={cn("flex justify-between", v.kept ? "text-zinc-200" : "text-amber-100/80 line-through")}>
              <span>{METHOD_LABELS[v.name] ?? v.name}</span>
              <span className="font-mono">{formatCurrency(v.value)}</span>
            </div>
          ))}
          {sorted.some((v) => !v.kept) && (
            <div className="text-[10px] text-amber-100/80 pt-0.5">Struck-through: highest/lowest votes trimmed from the blend.</div>
          )}
        </div>
        {ticker && (
          <div className="px-3 py-1.5 border-t border-zinc-700/60 text-[10px] text-amber-100/80">
            Outside estimates (StarMine, FMP, street, floor) are in the <span className="text-zinc-200">Outside values</span> box below the header.
          </div>
        )}
        <div className="px-3 py-2 border-t border-zinc-700/60 text-[10px] text-amber-100 space-y-1">
          {change3m != null && (
            <div className="text-zinc-300">
              Fair value {change3m >= 0 ? "up" : "down"} {Math.abs(change3m * 100).toFixed(0)}% over ~3 months (context only —
              this measure is validated monthly once enough history exists).
            </div>
          )}
          {valueTrap && (
            <div className="text-amber-300">
              Value-trap risk: looks cheap, but its 12-month trend is in the bottom half. In 2020–26, cheap stocks with
              weak trends kept underperforming peers (lab t 3.4).
            </div>
          )}
          {cyclical && (
            <div>Cyclical business: earnings may be near a peak or trough, so confidence is capped at medium.</div>
          )}
          {impliedGrowth != null && (
            <div>Today&apos;s price implies ~{(impliedGrowth * 100).toFixed(0)}%/yr free-cash-flow growth (fading over 10 years).</div>
          )}
          <div>A valuation reference, not a timing signal — gaps did not reliably close within 12 months in our 2020–26 backtest.</div>
          {asOf && <div className="text-amber-100/80">As of {asOf}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
