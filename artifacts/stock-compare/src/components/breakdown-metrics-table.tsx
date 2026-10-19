import { cn } from "@/lib/utils";
import {
  ESTIMATE_FIELDS,
  freshnessBand,
  freshnessDotClass,
  formatProvenanceTip,
  type ProvTipField,
} from "@/lib/provenance-display";

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
  /** Provenance tfCol (e.g. peRatio) — when set, tip + freshness come from byField. */
  fieldKey?: string;
  /** Force estimate badge; else inferred from ESTIMATE_FIELDS. */
  isEstimate?: boolean;
  /** Plain-English hover on the label (what the metric means). */
  tip?: string;
}

export interface MetricGroup {
  title: string;
  score: number | null;
  rows: MetricRowData[];
  /** HTML id for Scorecard Guide deep-links */
  sectionId?: string;
}

function MetricValue({
  row,
  prov,
}: {
  row: MetricRowData;
  prov: ProvTipField | undefined;
}) {
  const tip = formatProvenanceTip(prov);
  const estimate = row.isEstimate ?? (row.fieldKey != null && ESTIMATE_FIELDS.has(row.fieldKey));
  const band = freshnessBand(prov?.fetchedAt);
  const showDot = row.fieldKey != null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-mono font-semibold shrink-0",
        row.good === true ? "text-green-400" : row.good === false ? "text-red-400" : "text-foreground",
      )}
      title={tip}
    >
      {showDot && (
        <span
          className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", freshnessDotClass(band))}
          aria-hidden
        />
      )}
      {estimate && (
        <span
          className="text-[9px] font-bold text-sky-400/90 border border-sky-400/40 rounded px-0.5 leading-none"
          title="Estimate / forward figure"
        >
          E
        </span>
      )}
      {row.value}
    </span>
  );
}

export function BreakdownMetricsTable({
  groups,
  byField,
}: {
  groups: MetricGroup[];
  byField?: Map<string, ProvTipField>;
}) {
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
            {group.rows.map((row, i) => {
              const provTip = row.fieldKey ? formatProvenanceTip(byField?.get(row.fieldKey)) : undefined;
              const labelTip = [row.tip, provTip].filter(Boolean).join("\n");
              return (
                <div key={i} className="flex justify-between items-center gap-1.5 min-w-0">
                  <span
                    className="text-[10px] text-amber-100/70 shrink min-w-0 whitespace-nowrap overflow-hidden text-ellipsis"
                    title={labelTip || undefined}
                  >
                    {row.label}
                  </span>
                  <MetricValue row={row} prov={row.fieldKey ? byField?.get(row.fieldKey) : undefined} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
