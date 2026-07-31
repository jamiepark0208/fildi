import { Activity, DollarSign, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChartPoint, LiquidityImplications } from "./macro-page-types";
import { changeColor, LIQUIDITY_LEVEL_STYLE, LIQUIDITY_LEVEL_LABEL } from "./macro-format";

// ── Liquidity implications read card ────────────────────────────────────────────

export function LiquidityImplicationsCard({
  data, loading,
}: {
  data: LiquidityImplications | undefined;
  loading?: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-16">
        <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
      </div>
    );
  }

  const overallStyle = LIQUIDITY_LEVEL_STYLE[data.overall.level];

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <Activity className="h-3.5 w-3.5" />
          Liquidity Regime Read
        </span>
        <span className={cn("px-1.5 py-0.5 rounded border text-[10px] font-semibold", overallStyle.badge)}>
          {LIQUIDITY_LEVEL_LABEL[data.overall.level]}
        </span>
      </div>
      <p className={cn("text-xs font-medium", overallStyle.text)}>{data.overall.summary}</p>
      <span className="block text-[11px] font-mono text-sky-300/60">
        {data.signals.map((sg, i) => {
          const style = LIQUIDITY_LEVEL_STYLE[sg.level];
          return (
            <span key={sg.label}>
              {i > 0 && " · "}
              <span className={style.text}>{sg.label}</span>
              {` ${sg.readout}`}
            </span>
          );
        })}
      </span>
    </div>
  );
}

// ── Liquidity Plumbing Flow Diagram ─────────────────────────────────────────────
// Honest flow visual: WALCL/TGA/RRP -> Net Liquidity is real arithmetic
// (WALCL - TGA - RRP), so a connected strip is accurate here — unlike sector
// attribution, where no public data traces actual dollars.

function deltaFor(history: ChartPoint[], weeksBack: number): number | null {
  if (history.length === 0) return null;
  const latest = history[history.length - 1];
  const targetIdx = history.length - 1 - weeksBack;
  if (targetIdx < 0) return null;
  return latest.value - history[targetIdx].value;
}

function fmtDeltaB(v: number | null): string {
  return v != null ? `${v > 0 ? "+" : ""}${v.toFixed(0)}B` : "—";
}

export function LiquidityFlowDiagram({
  fedAssetsHistory, tgaHistory, rrpHistory, netLiquidityHistory, loading,
}: {
  fedAssetsHistory: ChartPoint[];
  tgaHistory: ChartPoint[];
  rrpHistory: ChartPoint[];
  netLiquidityHistory: ChartPoint[];
  loading?: boolean;
}) {
  const latestB = (history: ChartPoint[], divisor: number) =>
    history.length > 0 ? history[history.length - 1].value / divisor : null;

  if (loading) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-16">
        <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
      </div>
    );
  }

  const rows = [
    {
      label: "Fed Assets (WALCL)",
      valueB: latestB(fedAssetsHistory, 1000),
      deltaW: deltaFor(fedAssetsHistory, 1) != null ? deltaFor(fedAssetsHistory, 1)! / 1000 : null,
      deltaM: deltaFor(fedAssetsHistory, 4) != null ? deltaFor(fedAssetsHistory, 4)! / 1000 : null,
    },
    {
      label: "− Treasury Gen. Acct",
      valueB: latestB(tgaHistory, 1000),
      deltaW: deltaFor(tgaHistory, 1) != null ? deltaFor(tgaHistory, 1)! / 1000 : null,
      deltaM: deltaFor(tgaHistory, 4) != null ? deltaFor(tgaHistory, 4)! / 1000 : null,
    },
    {
      label: "− Overnight RRP",
      valueB: latestB(rrpHistory, 1),
      deltaW: deltaFor(rrpHistory, 7),
      deltaM: deltaFor(rrpHistory, 30),
    },
    {
      label: "= Net Liquidity",
      valueB: latestB(netLiquidityHistory, 1),
      deltaW: deltaFor(netLiquidityHistory, 1),
      deltaM: deltaFor(netLiquidityHistory, 4),
    },
  ];

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <table className="w-full text-sm">
        <thead className="bg-black text-[#d4af37]">
          <tr className="border-b border-[#d4af37]/25">
            <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">
              <span className="inline-flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                Fed Plumbing — Net Liquidity
              </span>
            </th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Value</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">1w Δ</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">1m Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.label} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
              <td className="px-3 py-1.5 text-amber-200/70">{r.label}</td>
              <td className="px-3 py-1.5 font-mono text-white text-right">
                {r.valueB != null ? `$${r.valueB.toFixed(0)}B` : "—"}
              </td>
              <td className={cn("px-3 py-1.5 font-mono text-right", changeColor(r.deltaW))}>{fmtDeltaB(r.deltaW)}</td>
              <td className={cn("px-3 py-1.5 font-mono text-right", changeColor(r.deltaM))}>{fmtDeltaB(r.deltaM)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
