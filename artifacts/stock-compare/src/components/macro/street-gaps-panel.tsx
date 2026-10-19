/** A86 — largest Fildi FV vs street PT gaps (Macro › Policy). Review queue, not a signal. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

type Gap = {
  ticker: string;
  asOf: string;
  fairValue: number;
  streetPt: number;
  gapPct: number;
  price: number | null;
};

export function StreetGapsPanel() {
  const { data, isLoading } = useQuery<{ gaps: Gap[]; note?: string }>({
    queryKey: ["fv-street-gaps"],
    queryFn: () => fetch("/api/fair-value/street-gaps?limit=20").then((r) => {
      if (!r.ok) throw new Error(`street-gaps ${r.status}`);
      return r.json();
    }),
    staleTime: 15 * 60_000,
  });

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#d4af37]/20 bg-black">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Street gaps</h3>
        <span className="text-[9px] text-amber-200/40">A86 · review only</span>
      </div>
      {isLoading ? (
        <p className="text-[11px] text-amber-200/40 px-3 py-2">Loading…</p>
      ) : !data?.gaps?.length ? (
        <p className="text-[11px] text-amber-200/40 px-3 py-2 italic">No street_pt_daily yet — run backfill-street-pt.</p>
      ) : (
        <div className="max-h-[200px] overflow-y-auto divide-y divide-zinc-800/80">
          {data.gaps.map((g) => (
            <Link key={g.ticker} href={`/?ticker=${g.ticker}`}>
              <div className="px-3 py-1 flex items-center gap-2 hover:bg-amber-500/5 cursor-pointer text-[11px] font-mono">
                <span className="w-12 font-semibold text-white/90">{g.ticker}</span>
                <span className={cn(
                  "w-16 text-right tabular-nums",
                  g.gapPct >= 0 ? "text-green-400" : "text-red-400",
                )}>
                  {g.gapPct >= 0 ? "+" : ""}{g.gapPct.toFixed(0)}%
                </span>
                <span className="text-amber-200/45 truncate">
                  FV ${g.fairValue.toFixed(0)} · street ${g.streetPt.toFixed(0)}
                  {g.price != null ? ` · px $${g.price.toFixed(0)}` : ""}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {data?.note ? <p className="text-[9px] text-white/30 px-3 py-1 border-t border-[#d4af37]/15">{data.note}</p> : null}
    </div>
  );
}
