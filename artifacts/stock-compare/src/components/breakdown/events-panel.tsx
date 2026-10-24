/**
 * Breakdown › Events — Polygon 8-K disclosure categories. Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";

type Row = { filed: string; category: string | null; primaryCategory: string | null };

function label(s: string | null): string {
  if (!s) return "—";
  return s.replace(/_/g, " ");
}

export function EventsPanel({ ticker }: { ticker: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["corporate-events", ticker],
    queryFn: async (): Promise<{ rows: Row[] }> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/events`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
  if (isLoading) return <p className="text-[10px] text-amber-100">Loading events…</p>;
  if (!data?.rows.length) return <p className="text-[10px] text-amber-100">No 8-K events stored.</p>;
  return (
    <div className={GRID_WRAP}>
      <table className="w-full border-collapse">
        <thead>
          <tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Filed</th>
            <th className={cn(GRID_TH, "text-left")}>Category</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={`${r.filed}-${r.category}-${i}`} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-amber-100")}>{formatMdYy(r.filed)}</td>
              <td className={cn(GRID_TD, "text-white")}>{label(r.category)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
