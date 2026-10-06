import { cn } from "@/lib/utils";

/** Fund family scores are 0–100. Pass max={5} only for legacy displays. */
export function ScoreBadge({ score, max = 100 }: { score: number | null | undefined; max?: number }) {
  if (score == null || !Number.isFinite(score)) {
    return <span className="font-mono text-sm text-zinc-500">—</span>;
  }
  const pct = max === 100 ? score : (score / max) * 100;
  const color =
    pct >= 70 ? "text-green-400" : pct >= 50 ? "text-yellow-400" : pct >= 35 ? "text-orange-400" : "text-red-400";
  return (
    <span className={cn("font-bold font-mono tabular-nums text-sm", color)}>
      {max === 100 ? score.toFixed(0) : `${score}/${max}`}
    </span>
  );
}

export interface MetricRowData {
  label: string;
  value: string;
  good?: boolean;
}

export interface MetricGroup {
  title: string;
  score: number | null;
  rows: MetricRowData[];
  /** HTML id for Scorecard Guide deep-links */
  sectionId?: string;
}

export function BreakdownMetricsTable({ groups }: { groups: MetricGroup[] }) {
  return (
    <div className="grid grid-cols-4 gap-2" id="bd-score-evidence">
      {groups.map(group => (
        <div
          key={group.title}
          id={group.sectionId}
          className="bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold tracking-tight text-[#d4af37] truncate">
              {group.title}
            </span>
            <ScoreBadge score={group.score} max={100} />
          </div>
          <div className="space-y-1">
            {group.rows.map((row, i) => (
              <div key={i} className="flex justify-between items-center gap-1.5">
                <span className="text-[10px] text-amber-100/70 truncate">{row.label}</span>
                <span
                  className={cn(
                    "text-[10px] font-mono font-semibold shrink-0",
                    row.good === true ? "text-green-400" : row.good === false ? "text-red-400" : "text-foreground",
                  )}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
