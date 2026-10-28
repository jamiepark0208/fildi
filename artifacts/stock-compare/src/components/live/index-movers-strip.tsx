/**
 * Live › index movers — Schwab $SPX / $COMPX / $DJI up and down.
 * Compact tags (matches Asia overnight chips) — display only.
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

  if (isLoading) {
    return (
      <div className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0">
        <span className="text-[11px] font-mono text-amber-100/50">Index…</span>
      </div>
    );
  }

  const any = data?.indexes.some((i) => i.up.length || i.down.length);
  if (!any && data?.marketOpen === false) {
    return (
      <div className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0">
        <span className="text-[11px] font-mono text-amber-100/50">Index closed</span>
      </div>
    );
  }
  if (!any) return null;

  return (
    <>
      {data!.indexes.map((idx) => {
        const up = idx.up[0];
        const down = idx.down[0];
        if (!up && !down) return null;
        return (
          <div
            key={idx.id}
            className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0"
            title={`${idx.label} index movers`}
          >
            <span className="text-[11px] font-mono font-semibold text-white">{idx.label}</span>
            {up && (
              <span className={cn("text-[11px] font-mono", (up.percent ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                {up.symbol} {pct(up.percent)}{vol(up.volume)}
              </span>
            )}
            {down && down.symbol !== up?.symbol && (
              <span className="text-[11px] font-mono text-red-400">
                {down.symbol} {pct(down.percent)}{vol(down.volume)}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
