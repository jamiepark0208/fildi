import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

export interface FairValueVote { name: string; value: number; kept: boolean }

type ExternalEst = {
  source: string;
  label: string;
  method: string;
  value: number;
  price: number | null;
  asOf: string | null;
  gapVsItsPrice: number | null;
  detail: { levered_dcf?: number } | null;
};

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

  const { data: external } = useQuery({
    queryKey: ["fair-value-external", ticker],
    queryFn: async (): Promise<ExternalEst[]> => {
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker!)}/external`, { credentials: "include" });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.estimates) ? j.estimates : [];
    },
    enabled: open && !!ticker,
    staleTime: 10 * 60_000,
  });

  const outside = external ?? [];
  const outsideMin = outside.length >= 2 ? Math.min(...outside.map((e) => e.value)) : null;
  const outsideMax = outside.length >= 2 ? Math.max(...outside.map((e) => e.value)) : null;

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
          <div className="text-zinc-400 text-[11px]">
            {low != null && high != null ? `Range ${formatCurrency(low)} – ${formatCurrency(high)} · ` : ""}
            {conf} confidence
          </div>
        </div>
        <div className="px-3 py-2 space-y-1">
          {sorted.map((v) => (
            <div key={v.name} className={cn("flex justify-between", v.kept ? "text-zinc-200" : "text-zinc-500 line-through")}>
              <span>{METHOD_LABELS[v.name] ?? v.name}</span>
              <span className="font-mono">{formatCurrency(v.value)}</span>
            </div>
          ))}
          {sorted.some((v) => !v.kept) && (
            <div className="text-[10px] text-zinc-500 pt-0.5">Struck-through: highest/lowest votes trimmed from the blend.</div>
          )}
        </div>
        {outside.length > 0 && (
          <div className="px-3 py-2 border-t border-zinc-700/60 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Outside estimates</div>
            {outside.map((e) => {
              const vsPrice = price != null && price > 0 ? (e.value / price - 1) * 100 : null;
              const tip = [
                e.method,
                e.asOf ? `as of ${e.asOf}` : null,
                e.source === "fmp_dcf" && e.detail?.levered_dcf != null
                  ? `levered DCF ${formatCurrency(e.detail.levered_dcf)}`
                  : null,
              ].filter(Boolean).join(" · ");
              return (
                <div key={e.source} className="flex justify-between text-zinc-200" title={tip}>
                  <span>{e.label}</span>
                  <span className="font-mono">
                    {formatCurrency(e.value)}
                    {vsPrice != null && (
                      <span className={cn("ml-1", vsPrice >= 0 ? "text-emerald-400/80" : "text-rose-400/80")}>
                        {vsPrice >= 0 ? "+" : ""}{vsPrice.toFixed(0)}%
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {outsideMin != null && outsideMax != null && outsideMax > outsideMin && (
              <div className="text-[10px] text-zinc-500 pt-0.5">
                Outside models disagree widely too ({formatCurrency(outsideMin)} – {formatCurrency(outsideMax)}).
              </div>
            )}
          </div>
        )}
        <div className="px-3 py-2 border-t border-zinc-700/60 text-[10px] text-zinc-400 space-y-1">
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
          {asOf && <div className="text-zinc-500">As of {asOf}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
