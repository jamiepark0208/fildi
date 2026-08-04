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
  if (v == null) return "text-amber-200/40";
  if (v >= 0.66) return "text-green-400";
  if (v >= 0.4) return "text-yellow-400";
  return "text-red-400";
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
      <span className="block text-[11px] font-mono text-sky-300/60 cursor-pointer hover:text-sky-300">
        <span className="text-[#d4af37]/80 uppercase tracking-wide">Regime accuracy </span>
        {HORIZONS.map((h, i) => {
          const cells = data.grid.filter(c => c.horizon === h);
          const n = cells.reduce((s, c) => s + c.n, 0);
          const correct = cells.reduce((s, c) => s + c.correct, 0);
          const pct = n > 0 ? correct / n : null;
          return (
            <span key={h}>
              {i > 0 && <span className="text-amber-200/40"> · </span>}
              <span className={cn("font-semibold", chipColor(pct))}>
                {h} {pct != null ? `${Math.round(pct * 100)}%` : "—"}
              </span>
              <span className="text-amber-200/40"> (n={n})</span>
            </span>
          );
        })}
      </span>
    </Link>
  );
}
