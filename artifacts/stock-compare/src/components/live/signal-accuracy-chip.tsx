// Compact "68% · 34" win-rate chip for a hotlist signal bucket (side+GO/WATCH) —
// shown next to the Signal badge so the pick's historical hit rate is visible
// without leaving the Live tab.
import type { HotlistSignalStat } from "@/hooks/use-hotlist-signal-accuracy";

export function SignalAccuracyChip({ stat }: { stat: HotlistSignalStat | undefined }) {
  if (!stat || stat.n < 5) return null; // not enough graded history to be meaningful
  const pct = Math.round((stat.winRate ?? 0) * 100);
  const color = pct >= 60 ? "text-emerald-400" : pct >= 45 ? "text-amber-300" : "text-rose-400";
  return (
    <span
      className={`ml-1.5 text-[10px] font-mono font-semibold ${color}`}
      title={`${stat.wins}/${stat.n} graded picks won (5d fwd return) for ${stat.side} ${stat.signal}`}
    >
      {pct}%·{stat.n}
    </span>
  );
}
