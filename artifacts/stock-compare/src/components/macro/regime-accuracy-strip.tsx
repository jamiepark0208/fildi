// Condensed accountability strip for the Regime tab — three chips (1w/4w/12w)
// showing how often the model's business-cycle regime call has been correct
// against forward SPY, aggregated across all regimes per horizon. Full
// regime x horizon breakdown lives on the Track Record page (this links there).
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface RegimeCell {
  horizon: string;
  n: number;
  correct: number;
  correctPct: number | null;
}

interface RegimeResponse {
  grid: RegimeCell[];
}

const HORIZONS = ["1w", "4w", "12w"] as const;

function chipColor(v: number | null): string {
  if (v == null) return "bg-white/5 text-muted-foreground border-white/10";
  if (v >= 0.66) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (v >= 0.4) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-rose-500/15 text-rose-300 border-rose-500/30";
}

export function RegimeAccuracyStrip() {
  const { data } = useQuery({
    queryKey: ["track-record", "regime"],
    queryFn: async (): Promise<RegimeResponse> => {
      const res = await fetch("/api/track-record/regime");
      if (!res.ok) throw new Error("track-record regime fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (!data || data.grid.every(c => c.n === 0)) return null;

  return (
    <Link href="/track-record">
      <div className="flex items-center gap-2 cursor-pointer">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Regime call accuracy</span>
        {HORIZONS.map(h => {
          const cells = data.grid.filter(c => c.horizon === h);
          const n = cells.reduce((s, c) => s + c.n, 0);
          const correct = cells.reduce((s, c) => s + c.correct, 0);
          const pct = n > 0 ? correct / n : null;
          return (
            <span
              key={h}
              className={cn("text-[11px] font-medium rounded-full border px-2 py-0.5", chipColor(pct))}
            >
              {h} {pct != null ? `${Math.round(pct * 100)}%` : "—"} (n={n})
            </span>
          );
        })}
      </div>
    </Link>
  );
}
