import { cn } from "@/lib/utils";

export function ScoreBadge({ score, max = 5 }: { score: number; max?: number }) {
  const color =
    score >= 4 ? "text-green-400" : score >= 3 ? "text-yellow-400" : score >= 2 ? "text-orange-400" : "text-red-400";
  return (
    <span className={cn("font-bold font-mono tabular-nums text-sm", color)}>
      {score}/{max}
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
  score: number;
  rows: MetricRowData[];
}

export function BreakdownMetricsTable({ groups }: { groups: MetricGroup[] }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {groups.map(group => (
        <div key={group.title} className="bg-card border border-border/50 rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold tracking-tight text-foreground truncate">
              {group.title}
            </span>
            <ScoreBadge score={group.score} />
          </div>
          <div className="space-y-1">
            {group.rows.map((row, i) => (
              <div key={i} className="flex justify-between items-center gap-1.5">
                <span className="text-[10px] text-foreground truncate">{row.label}</span>
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
