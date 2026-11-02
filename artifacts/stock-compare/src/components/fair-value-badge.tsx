import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** A283 fv-2.0.0 payload (GET /api/fair-value/:ticker/v2) — families never blended; headline only when they agree within 2×. */
interface FairValueV2 {
  street: { median: number; low: number | null; high: number | null; analysts: number | null; source: string; asOf: string | null } | null;
  cashFlow: { low: number; high: number; mid: number; points: { source: string; label: string; value: number }[];
    lab: { p10: number; p50: number; p90: number } | null; unitsCheck: { label: string; value: number }[] } | null;
  reverse: { text: string } | null;
  headline: number | null;
  headlineWhy: string;
}

function useFairValueV2(ticker?: string, price?: number | null) {
  return useQuery({
    queryKey: ["fair-value-v2", ticker, price ?? null],
    enabled: !!ticker,
    queryFn: async (): Promise<FairValueV2 | null> => {
      const q = price != null && price > 0 ? `?price=${price}` : "";
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker!)}/v2${q}`, { credentials: "include" });
      return r.ok ? ((await r.json()) as FairValueV2) : null;
    },
    staleTime: 10 * 60_000,
  });
}

function v2Label(v: FairValueV2): string | null {
  if (v.headline != null) return `Fair Value ${formatCurrency(v.headline)}`;
  const parts: string[] = [];
  if (v.street) parts.push(`Street ${formatCurrency(v.street.median)}`);
  if (v.cashFlow) parts.push(v.cashFlow.low === v.cashFlow.high ? `Cash flow ${formatCurrency(v.cashFlow.low)}`
    : `Cash flow ${formatCurrency(v.cashFlow.low)}–${formatCurrency(v.cashFlow.high)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Fair value tag (Breakdown header): v2 chips first; the fv-1.2.0 multiples blend and its votes stay in the popover. */
export function FairValueBadge({
  ticker,
  fairValue, low, high, confidence, impliedGrowth, votes, asOf, price, change3m, cyclical, valueTrap,
}: {
  /** Needed for A284 outside estimates fetch (on open only). */
  ticker?: string;
  fairValue?: number | null;
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
  const { data: v2 } = useFairValueV2(ticker, price);
  const conf = confidence ?? "low";
  const gap = fairValue != null && price != null && price > 0 ? (fairValue / price - 1) * 100 : null;
  const v1Label = fairValue != null ? `Fair Value ${formatCurrency(fairValue)}${valueTrap ? " · value-trap risk" : conf === "low" ? " · low conf." : ""}` : null;
  const label = (v2 && v2Label(v2)) ?? v1Label;
  if (!label) return null;
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
        {v2 && (
          <div className="px-3 py-2 border-b border-zinc-700/60 space-y-1">
            <div className="text-zinc-100 font-semibold">{v2.headline != null ? formatCurrency(v2.headline) : "No single value"}</div>
            <div className="text-[10px] text-amber-100">{v2.headlineWhy}</div>
            {v2.street && (
              <div className="flex justify-between text-zinc-200">
                <span title={`${v2.street.source}${v2.street.analysts ? ` · ${v2.street.analysts} analysts` : ""}`}>Street (median target)</span>
                <span className="font-mono">
                  {formatCurrency(v2.street.median)}
                  {v2.street.low != null && v2.street.high != null ? ` (${formatCurrency(v2.street.low)}–${formatCurrency(v2.street.high)})` : ""}
                </span>
              </div>
            )}
            {v2.cashFlow && (
              <div className="flex justify-between text-zinc-200">
                <span title={v2.cashFlow.points.map((p) => `${p.label} ${formatCurrency(p.value)}`).join(" · ")}>Cash flow (range)</span>
                <span className="font-mono">{formatCurrency(v2.cashFlow.low)}–{formatCurrency(v2.cashFlow.high)}</span>
              </div>
            )}
            {v2.cashFlow?.lab && (
              <div className="flex justify-between text-zinc-300 text-[10px]">
                <span>Fildi DCF P10–P90</span>
                <span className="font-mono">{formatCurrency(v2.cashFlow.lab.p10)}–{formatCurrency(v2.cashFlow.lab.p90)}</span>
              </div>
            )}
            {v2.reverse && <div className="text-zinc-200">{v2.reverse.text}</div>}
            {!!v2.cashFlow?.unitsCheck.length && (
              <div className="text-[10px] text-amber-300">
                Set aside (units check): {v2.cashFlow.unitsCheck.map((p) => `${p.label} ${formatCurrency(p.value)}`).join(", ")}
              </div>
            )}
          </div>
        )}
        {fairValue != null && (
        <div className="px-3 py-2 border-b border-zinc-700/60 bg-zinc-800/90 space-y-0.5">
          {v2 && <div className="text-[10px] text-amber-100/80">Multiples blend (fv-1.2.0)</div>}
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
        )}
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
