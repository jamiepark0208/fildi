/**
 * Live › index movers — Schwab $SPX / $COMPX / $DJI up and down. One line. Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type Side = { symbol: string; percent: number | null; volume: number | null };
type Idx = { id: string; label: string; up: Side[]; down: Side[] };
type View = { asOf: string | null; marketOpen: boolean | null; indexes: Idx[] };

function vol(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e6) return ` ${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return ` ${(n / 1e3).toFixed(0)}K`;
  return ` ${n}`;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function IndexMoversStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ["live-index-movers"],
    queryFn: async (): Promise<View> => {
      const r = await fetch("/api/live/index-movers", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  if (isLoading) return <p className="text-[11px] text-amber-100">Loading index movers…</p>;
  const any = data?.indexes.some((i) => i.up.length || i.down.length);
  if (!any && data?.marketOpen === false) {
    return <p className="text-[11px] text-amber-100">Index movers — market closed</p>;
  }
  if (!any) return <p className="text-[11px] text-amber-100">No index movers yet.</p>;
  return (
    <div className="flex flex-nowrap items-baseline gap-x-3 overflow-x-auto text-[11px] text-amber-100">
      <span className="shrink-0 uppercase tracking-widest text-[#d4af37]">Index</span>
      {data!.indexes.map((idx) => (
        <span key={idx.id} className="shrink-0 whitespace-nowrap">
          <span className="text-[#d4af37]">{idx.label}</span>
          {idx.up.slice(0, 2).map((r) => (
            <span key={`u-${r.symbol}`} className={cn("ml-1.5", (r.percent ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
              {r.symbol} {pct(r.percent)}{vol(r.volume)}
            </span>
          ))}
          {idx.down.slice(0, 1).map((r) => (
            <span key={`d-${r.symbol}`} className="ml-1.5 text-red-400">
              {r.symbol} {pct(r.percent)}{vol(r.volume)}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}
