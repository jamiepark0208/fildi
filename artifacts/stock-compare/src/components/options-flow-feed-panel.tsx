/**
 * Feed › Options flow (A396) — latest published day: names whose option premium (prints ≥ $25k) ran ≥ 3× their own median,
 * plus put-heavy names and the index read. GET /api/options-flow/latest. Side unknown (no bid/ask); display only.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { usd } from "@/components/breakdown/congress-section";
import { FLOW_TIP, FlowChip, expTxt, xCls, xTxt, type FlowDay } from "@/components/breakdown/options-flow-section";

type Latest = { day: string | null; days: number; names?: number; unusual: FlowDay[]; biggest: FlowDay[]; putHeavy: FlowDay[]; index: FlowDay[] };

function FlowTable({ rows, label }: { rows: FlowDay[]; label: string }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">{label}</div>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Ticker</th>
              <th className={cn(GRID_TH, "text-right")}>Premium</th>
              <th className={cn(GRID_TH, "text-right")}>× norm</th>
              <th className={cn(GRID_TH, "text-right")}>Put %</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((r, i) => (
              <tr key={r.ticker} className={gridRow(i)}>
                <td className={GRID_TD}>
                  <DataTip tip={`${r.prints} prints · ${r.blocks} blocks · ${r.bursts} bursts · top ${r.top[0] ? `${r.top[0].strike}${r.top[0].side === "put" ? "P" : "C"} ${expTxt(r.top[0].expiry)} ${usd(r.top[0].premium)}` : "—"}`}>
                    <Link href={`/watchlist?ticker=${r.ticker}`} className="hover:text-[#d4af37]">{r.ticker}</Link>
                  </DataTip>
                </td>
                <td className={cn(GRID_TD, "text-right")}>{usd(r.totalPremium)}</td>
                <td className={cn(GRID_TD, "text-right", xCls(r.xNormal))}>{xTxt(r.xNormal)}</td>
                <td className={cn(GRID_TD, "text-right", (r.putShare ?? 0) >= 0.7 ? "text-red-400" : "")}>
                  {r.putShare != null ? `${Math.round(r.putShare * 100)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function OptionsFlowFeedPanel({ className }: { className?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["options-flow", "latest"],
    queryFn: async (): Promise<Latest> => {
      const r = await fetch("/api/options-flow/latest", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
  const spy = data?.index.find((x) => x.ticker === "SPY");
  return (
    <div className={cn("rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <DataTip tip={FLOW_TIP}>
          <span className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Options flow</span>
        </DataTip>
        <FlowChip />
      </div>
      {isLoading ? (
        <div className="text-xs text-amber-100">Loading…</div>
      ) : !data?.day ? (
        <div className="text-xs text-amber-100">No options flow stored yet.</div>
      ) : (
        <>
          <div className="text-[10px] text-white">
            {formatMdYy(data.day)}{spy ? ` · SPY ${usd(spy.totalPremium)}, puts ${Math.round((spy.putShare ?? 0) * 100)} %` : ""}
          </div>
          {data.unusual.length ? (
            <FlowTable rows={data.unusual} label="Unusual (≥ 3× own median)" />
          ) : (
            <div className="text-[10px] text-amber-100">
              {data.days < 6 ? `Baseline building (${data.days} d stored; needs 6).` : "No name ≥ 3× its median."}
            </div>
          )}
          <FlowTable rows={data.putHeavy} label="Put-heavy (≥ 70 % puts, ≥ $1M)" />
          <FlowTable rows={data.biggest} label="Biggest premium" />
        </>
      )}
    </div>
  );
}
