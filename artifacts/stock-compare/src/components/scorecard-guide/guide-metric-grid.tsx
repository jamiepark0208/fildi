import { cn } from "@/lib/utils";
import type { GuideMetricRow } from "@/lib/scorecard-guide-metadata";
import {
  getWeightFromConfig,
  setWeightInConfig,
  type ScoringWeightsConfig,
  type WeightGroup,
} from "@/lib/scoring-weights";

function DirCell({ v }: { v: boolean | "band" }) {
  if (v === "band") return <span className="text-muted-foreground">Band</span>;
  return <span className={v ? "text-green-400" : "text-blue-400"}>{v ? "↑" : "↓"}</span>;
}

function formatWeight(val: number, row: GuideMetricRow): string {
  if (row.weightIsPercent) return `${val}%`;
  if (row.weightGroup === "fundamentalMetrics") return String(val);
  return `${Math.round(val * 100)}%`;
}

function parseWeightInput(raw: string, row: GuideMetricRow): number | null {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return null;
  if (row.weightIsPercent) return n;
  if (row.weightGroup === "fundamentalMetrics") return n;
  return n / 100;
}

type Props = {
  rows: GuideMetricRow[];
  coverageLabel: string;
  showFamily?: boolean;
  config: ScoringWeightsConfig;
  noteSuffix?: string;
  editable?: boolean;
  onConfigChange?: (config: ScoringWeightsConfig) => void;
};

export function GuideMetricGrid({
  rows,
  coverageLabel,
  showFamily,
  config,
  noteSuffix = "",
  editable,
  onConfigChange,
}: Props) {
  const handleWeight = (row: GuideMetricRow, raw: string) => {
    if (!onConfigChange) return;
    const val = parseWeightInput(raw, row);
    if (val == null) return;
    onConfigChange(setWeightInConfig(config, row.weightGroup as WeightGroup, row.weightKey, val));
  };

  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-secondary/40 text-muted-foreground">
            <th className="px-2 py-1.5 text-left font-medium">Metric</th>
            {showFamily && <th className="px-2 py-1.5 text-left font-medium w-12">Fam</th>}
            <th className="px-2 py-1.5 text-right font-medium w-14">Weight</th>
            <th className="px-2 py-1.5 text-center font-medium w-8">Dir</th>
            <th className="px-2 py-1.5 text-left font-medium w-16">Source</th>
            <th className="px-2 py-1.5 text-left font-medium w-12">Refresh</th>
            <th className="px-2 py-1.5 text-left font-medium w-16">Coverage</th>
            <th className="px-2 py-1.5 text-left font-medium min-w-[100px]">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const w = getWeightFromConfig(config, r.weightGroup, r.weightKey);
            const notes = r.notes + noteSuffix;
            return (
              <tr key={r.key} className="border-t border-border/50 hover:bg-secondary/10">
                <td className="px-2 py-1.5 font-medium">{r.label}</td>
                {showFamily && (
                  <td className="px-2 py-1.5 text-muted-foreground capitalize">{r.family?.slice(0, 3)}</td>
                )}
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {editable ? (
                    <input
                      type="number"
                      step={r.weightIsPercent || r.weightGroup === "fundamentalMetrics" ? 1 : 0.1}
                      className="w-12 text-right bg-secondary/30 border border-border rounded px-1 py-0.5 text-[11px]"
                      value={r.weightIsPercent || r.weightGroup === "fundamentalMetrics"
                        ? w
                        : Math.round(w * 1000) / 10}
                      onChange={e => handleWeight(r, e.target.value)}
                    />
                  ) : formatWeight(w, r)}
                </td>
                <td className="px-2 py-1.5 text-center"><DirCell v={r.higherIsBetter} /></td>
                <td className="px-2 py-1.5 text-muted-foreground">{r.source}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{r.refresh}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{coverageLabel}</td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-muted-foreground truncate max-w-[200px]",
                    (notes.includes("proxy") || notes.includes("Excluded") || noteSuffix) && "text-amber-500/90",
                  )}
                  title={notes}
                >
                  {notes}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** @deprecated alias */
export const GuideMetricTable = GuideMetricGrid;
