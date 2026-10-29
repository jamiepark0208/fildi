/** A315 — visible outside fair-value sources + Trading Central (Breakdown main view). */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatCurrency, formatMd } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FairValueVote } from "@/components/fair-value-badge";

type ExternalEst = {
  source: string;
  label: string;
  method: string;
  family: "street" | "cash-flow" | "floor";
  value: number;
  price: number | null;
  asOf: string | null;
  gapVsItsPrice: number | null;
  detail: { levered_dcf?: number } | null;
};

type StreetRange = {
  median: number | null;
  mean: number | null;
  low: number | null;
  high: number | null;
  analysts: number | null;
  asOf: string | null;
};

type OutlookLeg = {
  direction?: string;
  stateDescription?: string;
  sectorDirection?: string;
  indexDirection?: string;
};

type ExternalPayload = {
  estimates: ExternalEst[];
  streetRange: StreetRange | null;
  tradingCentral: {
    valuation: string | null;
    discountPct: number | null;
    support: number | null;
    resistance: number | null;
    stopLoss: number | null;
    outlook: { short?: OutlookLeg; mid?: OutlookLeg; long?: OutlookLeg } | null;
    morningstar: { bull: string | null; bear: string | null };
    asOf?: string | null;
  } | null;
};

type DcfLab = {
  valued?: boolean;
  p10?: number;
  p50?: number;
  p90?: number;
  reverse?: { growth_pct: number | null; implied_cagr5: number | null };
  asOf?: string;
};

const FV_METHOD_LABELS: Record<string, string> = {
  peerForwardPe: "Peer forward P/E",
  warrantedPe: "Growth-adjusted P/E",
  grahamForward: "Graham (revised)",
  ohlsonJuettner: "Earnings-growth model",
  dcfFcfe: "Cash-flow DCF",
  peerEvEbitda: "Peer EV/EBITDA",
  excessReturns: "Book value + excess ROE",
  peerPffo: "Peer P/FFO",
  analystTarget: "Analyst target (de-biased)",
};

const CASH_FLOW_ORDER = ["starmine", "fmp_dcf", "fildi_rim"];
const FLOOR_ORDER = ["fildi_epv", "graham_number"];

function vsPricePct(value: number, price: number | null | undefined): number | null {
  if (price == null || price <= 0) return null;
  return (value / price - 1) * 100;
}

function gapColor(pct: number | null): string {
  if (pct == null) return "text-amber-100/70";
  return pct >= 0 ? "text-emerald-400" : "text-rose-400";
}

function fmtGap(pct: number | null): string {
  if (pct == null) return "";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function directionArrow(dir: string | undefined): string {
  const d = (dir ?? "").toLowerCase();
  if (d.includes("bull")) return "↑";
  if (d.includes("bear")) return "↓";
  return "→";
}

function ValueRow({
  label,
  value,
  price,
  asOf,
  methodTip,
  extraTip,
  rowIndex,
}: {
  label: string;
  value: number;
  price: number | null | undefined;
  asOf: string | null;
  methodTip: string;
  extraTip?: string | null;
  rowIndex: number;
}) {
  const pct = vsPricePct(value, price);
  const tip = [methodTip, extraTip, asOf ? `as of ${formatMd(asOf)}` : null].filter(Boolean).join(" · ");
  return (
    <tr className={gridRow(rowIndex)}>
      <td className={cn(GRID_TD, "text-left max-w-[8rem] truncate")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default border-b border-dotted border-white/20">{label}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-[10px] bg-zinc-900 border-zinc-600 text-zinc-100">
            {tip}
          </TooltipContent>
        </Tooltip>
      </td>
      <td className={cn(GRID_TD, "text-right font-mono")}>{formatCurrency(value)}</td>
      <td className={cn(GRID_TD, "text-right font-mono", gapColor(pct))}>{fmtGap(pct)}</td>
      <td className={cn(GRID_TD, "text-right text-amber-100/60 text-[10px]")}>{asOf ? formatMd(asOf) : ""}</td>
    </tr>
  );
}

function StreetRangeBar({ low, median, high }: { low: number; median: number; high: number }) {
  const span = Math.max(high - low, 1e-9);
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - low) / span) * 100));
  return (
    <div className="mt-0.5 h-1.5 rounded bg-zinc-800 border border-zinc-700/50 relative">
      <div className="absolute inset-y-0 left-0 rounded bg-sky-500/30" style={{ width: "100%" }} />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-[#d4af37]"
        style={{ left: `${pct(median)}%` }}
        title={`Median ${formatCurrency(median)}`}
      />
    </div>
  );
}

export function OutsideValuesBox({
  ticker,
  price,
  votes,
}: {
  ticker: string;
  price?: number | null;
  votes?: FairValueVote[];
}) {
  const [msOpen, setMsOpen] = useState(false);

  const { data: external } = useQuery({
    queryKey: ["fair-value-external", ticker],
    queryFn: async (): Promise<ExternalPayload> => {
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker)}/external`, { credentials: "include" });
      if (!r.ok) return { estimates: [], streetRange: null, tradingCentral: null };
      const j = await r.json();
      return {
        estimates: Array.isArray(j.estimates) ? j.estimates : [],
        streetRange: j.streetRange ?? null,
        tradingCentral: j.tradingCentral ?? null,
      };
    },
    staleTime: 10 * 60_000,
  });

  const { data: dcfLab } = useQuery({
    queryKey: ["fv-dcf-lab", ticker],
    queryFn: async (): Promise<DcfLab | null> => {
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker)}/dcf`, { credentials: "include" });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.dcf as DcfLab | null) ?? null;
    },
    staleTime: 10 * 60_000,
  });

  const estimates = external?.estimates ?? [];
  const street = external?.streetRange ?? null;
  const tc = external?.tradingCentral ?? null;
  const sortedVotes = useMemo(() => [...(votes ?? [])].sort((a, b) => a.value - b.value), [votes]);

  const bySource = useMemo(() => {
    const m = new Map<string, ExternalEst>();
    for (const e of estimates) m.set(e.source, e);
    return m;
  }, [estimates]);

  const streetEst = bySource.get("argus_pt");
  const cashEstimates = CASH_FLOW_ORDER.map((s) => bySource.get(s)).filter(Boolean) as ExternalEst[];
  const floorEstimates = FLOOR_ORDER.map((s) => bySource.get(s)).filter(Boolean) as ExternalEst[];

  const streetMedian = street?.median ?? null;
  const cashMedian = useMemo(() => {
    const vals = cashEstimates.map((e) => e.value);
    if (dcfLab?.valued && dcfLab.p50 != null) vals.push(dcfLab.p50);
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }, [cashEstimates, dcfLab?.valued, dcfLab?.p50]);

  const disagree =
    streetMedian != null && streetMedian > 0 && cashMedian != null && cashMedian > 0
      && Math.max(streetMedian / cashMedian, cashMedian / streetMedian) > 2;

  const hasDcfBand = dcfLab?.valued && dcfLab.p10 != null && dcfLab.p90 != null;
  const hasMs = !!(tc?.morningstar?.bull || tc?.morningstar?.bear);
  const hasTc =
    tc &&
    (tc.valuation ||
      tc.support != null ||
      tc.resistance != null ||
      tc.stopLoss != null ||
      tc.outlook);
  const hasVotes = sortedVotes.length > 0;
  const hasStreet = !!(streetEst || (street?.median != null && street.low != null && street.high != null));
  const hasCash = cashEstimates.length > 0 || hasDcfBand;
  const hasFloor = floorEstimates.length > 0;

  if (!hasStreet && !hasCash && !hasFloor && !hasVotes && !hasTc) return null;

  let rowIdx = 0;

  const tcDiscount =
    tc?.valuation && tc.discountPct != null && !tc.valuation.toLowerCase().includes("near fair")
      ? `${tc.valuation} ${Math.abs(tc.discountPct).toFixed(0)}%`
      : tc?.valuation ?? null;

  return (
    <section
      className="mt-2 rounded border border-[#d4af37]/20 bg-zinc-950/70 px-2 py-1.5 space-y-1.5"
      data-testid="outside-values-box"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]/90">Outside values</h3>
        <span className="text-[9px] text-amber-100/50">by family · not blended</span>
      </div>

      {disagree && (
        <p className="text-[10px] text-amber-300/90">Street and cash-flow disagree &gt; 2×</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 min-w-0">
        {hasStreet && (
          <div className="min-w-0">
            <div className={cn(GRID_WRAP, "border border-[#d4af37]/10 rounded")}>
              <table className="w-full border-collapse">
                <thead>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")} colSpan={4}>Street</th>
                  </tr>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")}>Source</th>
                    <th className={cn(GRID_TH, "text-right")}>Value</th>
                    <th className={cn(GRID_TH, "text-right")}>vs price</th>
                    <th className={cn(GRID_TH, "text-right")}>As of</th>
                  </tr>
                </thead>
                <tbody>
                  {streetEst && (
                    <ValueRow
                      key={streetEst.source}
                      label={streetEst.label.replace(/ target.*/i, "") || "Argus"}
                      value={streetEst.value}
                      price={price ?? streetEst.price}
                      asOf={streetEst.asOf}
                      methodTip={streetEst.method}
                      rowIndex={rowIdx++}
                    />
                  )}
                  {street?.median != null && street.low != null && street.high != null && (
                    <tr className={gridRow(rowIdx++)}>
                      <td className={cn(GRID_TD, "text-left")} colSpan={4}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-default space-y-0.5">
                              <div className="flex justify-between gap-2 text-[11px]">
                                <span>LSEG median {formatCurrency(street.median)}</span>
                                <span className={cn("font-mono", gapColor(vsPricePct(street.median, price)))}>
                                  {fmtGap(vsPricePct(street.median, price))}
                                </span>
                              </div>
                              <div className="text-[9px] text-amber-100/55 flex justify-between">
                                <span>{formatCurrency(street.low)} – {formatCurrency(street.high)}</span>
                                {street.analysts != null && <span>{street.analysts} analysts</span>}
                              </div>
                              <StreetRangeBar low={street.low} median={street.median} high={street.high} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="text-[10px] bg-zinc-900 border-zinc-600 text-zinc-100">
                            LSEG I/B/E/S consensus range · {street.asOf ? formatMd(street.asOf) : ""}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {hasCash && (
          <div className="min-w-0">
            <div className={cn(GRID_WRAP, "border border-[#d4af37]/10 rounded")}>
              <table className="w-full border-collapse">
                <thead>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")} colSpan={4}>Cash-flow</th>
                  </tr>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")}>Source</th>
                    <th className={cn(GRID_TH, "text-right")}>Value</th>
                    <th className={cn(GRID_TH, "text-right")}>vs price</th>
                    <th className={cn(GRID_TH, "text-right")}>As of</th>
                  </tr>
                </thead>
                <tbody>
                  {cashEstimates.map((e) => {
                    const levered = e.source === "fmp_dcf" ? e.detail?.levered_dcf : null;
                    const extra =
                      levered != null ? `levered DCF ${formatCurrency(levered)}` : null;
                    const label =
                      e.source === "starmine"
                        ? "StarMine"
                        : e.source === "fmp_dcf"
                          ? "FMP DCF"
                          : e.label;
                    return (
                      <ValueRow
                        key={e.source}
                        label={label}
                        value={e.value}
                        price={price ?? e.price}
                        asOf={e.asOf}
                        methodTip={e.method}
                        extraTip={extra}
                        rowIndex={rowIdx++}
                      />
                    );
                  })}
                  {hasDcfBand && (
                    <tr className={gridRow(rowIdx++)}>
                      <td className={cn(GRID_TD, "text-left")} colSpan={4}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default border-b border-dotted border-white/20 text-[11px]">
                              Fildi lab DCF {formatCurrency(dcfLab!.p10!)} – {formatCurrency(dcfLab!.p90!)}
                              {dcfLab!.p50 != null && (
                                <span className="ml-1 font-mono text-amber-100/80">P50 {formatCurrency(dcfLab!.p50)}</span>
                              )}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="text-[10px] bg-zinc-900 border-zinc-600 text-zinc-100">
                            Lab model — not in fair-value blend · {dcfLab!.asOf ? formatMd(dcfLab!.asOf) : ""}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {hasFloor && (
          <div className="min-w-0">
            <div className={cn(GRID_WRAP, "border border-[#d4af37]/10 rounded")}>
              <table className="w-full border-collapse">
                <thead>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")} colSpan={4}>Floor</th>
                  </tr>
                  <tr className={GRID_HEADER}>
                    <th className={cn(GRID_TH, "text-left")}>Source</th>
                    <th className={cn(GRID_TH, "text-right")}>Value</th>
                    <th className={cn(GRID_TH, "text-right")}>vs price</th>
                    <th className={cn(GRID_TH, "text-right")}>As of</th>
                  </tr>
                </thead>
                <tbody>
                  {floorEstimates.map((e) => (
                    <ValueRow
                      key={e.source}
                      label={e.source === "fildi_epv" ? "Earnings power" : e.label}
                      value={e.value}
                      price={price ?? e.price}
                      asOf={e.asOf}
                      methodTip={e.method}
                      rowIndex={rowIdx++}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {hasVotes && (
        <div className={cn(GRID_WRAP, "border border-[#d4af37]/10 rounded")}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")} colSpan={2}>Fildi models (blend votes)</th>
              </tr>
            </thead>
            <tbody>
              {sortedVotes.map((v, i) => (
                <tr key={v.name} className={gridRow(i)}>
                  <td className={cn(GRID_TD, "text-left", !v.kept && "line-through text-amber-100/60")}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-default">{FV_METHOD_LABELS[v.name] ?? v.name}</span>
                      </TooltipTrigger>
                      <TooltipContent className="text-[10px] bg-zinc-900 border-zinc-600 text-zinc-100">
                        {v.kept ? "Included in blend" : "Trimmed from blend (high/low outlier)"}
                      </TooltipContent>
                    </Tooltip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono", !v.kept && "line-through text-amber-100/60")}>
                    {formatCurrency(v.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dcfLab?.reverse?.growth_pct != null && (
        <p className="text-[10px] text-amber-100/70">
          Reverse DCF implied growth ~{(dcfLab.reverse.growth_pct * 100).toFixed(0)}%/yr (lab)
        </p>
      )}

      {hasTc && (
        <div className="border-t border-[#d4af37]/15 pt-1.5 space-y-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px]">
            {tcDiscount && (
              <span className="font-semibold text-amber-100">{tcDiscount}</span>
            )}
            {tc!.support != null && (
              <span className="rounded border border-zinc-600/60 px-1 py-px font-mono text-sky-300/90">
                S {formatCurrency(tc!.support!)}
              </span>
            )}
            {tc!.resistance != null && (
              <span className="rounded border border-zinc-600/60 px-1 py-px font-mono text-rose-300/90">
                R {formatCurrency(tc!.resistance!)}
              </span>
            )}
            {tc!.stopLoss != null && (
              <span className="rounded border border-zinc-600/60 px-1 py-px font-mono text-amber-200/80">
                Stop {formatCurrency(tc!.stopLoss!)}
              </span>
            )}
            {(["short", "mid", "long"] as const).map((leg) => {
              const o = tc!.outlook?.[leg];
              if (!o) return null;
              return (
                <Tooltip key={leg}>
                  <TooltipTrigger asChild>
                    <span className="rounded border border-zinc-600/50 px-1 py-px cursor-default uppercase text-[9px] text-white/90">
                      {leg[0]} {directionArrow(o.direction)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-[10px] bg-zinc-900 border-zinc-600 text-zinc-100">
                    <div className="font-semibold capitalize">{leg}: {o.direction ?? "—"}</div>
                    {o.stateDescription && <div className="mt-0.5">{o.stateDescription}</div>}
                    {(o.sectorDirection || o.indexDirection) && (
                      <div className="mt-0.5 text-amber-100/70">
                        Sector {o.sectorDirection ?? "—"} · Index {o.indexDirection ?? "—"}
                      </div>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          {hasMs && (
            <div>
              <button
                type="button"
                className="text-[9px] text-[#d4af37]/90 underline-offset-2 hover:underline"
                onClick={() => setMsOpen((v) => !v)}
              >
                Bull / bear case {msOpen ? "▾" : "▸"}
              </button>
              {msOpen && (
                <div className="mt-1 space-y-1 text-[10px] text-amber-100/85 max-h-32 overflow-y-auto">
                  {tc!.morningstar.bull && <p><span className="text-emerald-400/90">Bull:</span> {tc!.morningstar.bull}</p>}
                  {tc!.morningstar.bear && <p><span className="text-rose-400/90">Bear:</span> {tc!.morningstar.bear}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
