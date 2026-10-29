/**
 * Breakdown › Insiders — open-market Form 4 net buys, last 90 days (Polygon). Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";

type Row = {
  filed: string;
  insider: string | null;
  role: string | null;
  code: string;
  shares: number | null;
  value: number | null;
};

type View = { netValue: number; buys: number; sells: number; rows: Row[] };

function money(n: number): string {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** Compact summary for BreakdownPanel header (right of title). */
export function InsiderHeaderStats({ ticker }: { ticker: string }) {
  const { data } = useQuery({
    queryKey: ["insiders", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/insiders`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
  if (!data) return null;
  return (
    <span className={cn("text-[11px] font-mono tabular-nums shrink-0", data.netValue >= 0 ? "text-green-400" : "text-red-400")}>
      90d {money(data.netValue)}
      <span className="text-white"> · {data.buys}b/{data.sells}s</span>
    </span>
  );
}

export function InsiderPanel({ ticker }: { ticker: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["insiders", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/insiders`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
  if (isLoading) return <p className="text-[10px] text-amber-100">Loading insiders…</p>;
  if (!data || (data.rows.length === 0 && data.buys === 0 && data.sells === 0)) {
    return <p className="text-[10px] text-amber-100">No Form 4 buys or sales in 90 days.</p>;
  }
  return (
    <div className={GRID_WRAP}>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left py-0.5")}>Filed</th>
            <th className={cn(GRID_TH, "text-left py-0.5")}>Name</th>
            <th className={cn(GRID_TH, "text-left py-0.5")}>Side</th>
            <th className={cn(GRID_TH, "text-right py-0.5")}>Val</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.filter((r) => r.code === "buy" || r.code === "sell").map((r, i) => {
            const name = r.insider ?? "—";
            const tip = r.role ? `${name} · ${r.role}` : name;
            return (
              <tr key={`${r.filed}-${r.insider}-${i}`} className={gridRow(i)}>
                <td className={cn(GRID_TD, "text-white py-0.5 whitespace-nowrap")}>{formatMdYy(r.filed)}</td>
                <td className={cn(GRID_TD, "text-white py-0.5 max-w-[9rem] truncate")}>
                  <DataTip tip={tip}>
                    <span className="truncate">{name}</span>
                  </DataTip>
                </td>
                <td className={cn(GRID_TD, "py-0.5", r.code === "buy" ? "text-green-400" : "text-red-400")}>
                  {r.code}
                </td>
                <td className={cn(GRID_TD, "text-right text-white py-0.5")}>
                  {r.value == null ? "—" : money(r.value)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
