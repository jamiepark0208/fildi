import { cn } from "@/lib/utils";
import type { GuideMetricRow } from "@/lib/scorecard-guide-metadata";
import type { CoverageTone } from "@/hooks/use-guide-status";
import {
  getWeightFromConfig,
  setWeightInConfig,
  type ScoringWeightsConfig,
  type WeightGroup,
} from "@/lib/scoring-weights";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function DirCell({ v }: { v: boolean | "band" }) {
  if (v === "band") return <span className="text-foreground/80 font-medium">Band</span>;
  return (
    <span className={cn("text-base font-bold", v ? "text-green-400" : "text-blue-400")}>
      {v ? "↑" : "↓"}
    </span>
  );
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

function coverageCellClass(tone: CoverageTone): string {
  if (tone === "good") return "text-green-400 font-medium";
  if (tone === "partial") return "text-yellow-400 font-medium";
  return "text-foreground/80";
}

type Props = {
  rows: GuideMetricRow[];
  coverageLabel: string;
  coverageTone?: CoverageTone;
  showFamily?: boolean;
  config: ScoringWeightsConfig;
  noteSuffix?: string;
  editable?: boolean;
  onConfigChange?: (config: ScoringWeightsConfig) => void;
};

export function GuideMetricGrid({
  rows,
  coverageLabel,
  coverageTone = "unknown",
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
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm mb-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-secondary/60 backdrop-blur-sm">
            <TableRow className="hover:bg-transparent border-border/60">
              <TableHead className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 sticky left-0 bg-secondary/60 min-w-[140px]">
                Metric
              </TableHead>
              {showFamily && (
                <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 w-16">
                  Fam
                </TableHead>
              )}
              <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 text-right w-20">
                Weight
              </TableHead>
              <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 text-center w-12">
                Dir
              </TableHead>
              <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 w-24">
                Source
              </TableHead>
              <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 w-20">
                Refresh
              </TableHead>
              <TableHead className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 w-28">
                Coverage
              </TableHead>
              <TableHead className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-foreground/80 min-w-[160px]">
                Notes
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, idx) => {
              const w = getWeightFromConfig(config, r.weightGroup, r.weightKey);
              const notes = r.notes + noteSuffix;
              const isWarning = notes.includes("proxy") || notes.includes("Excluded") || !!noteSuffix;
              return (
                <TableRow
                  key={r.key}
                  className={cn(
                    "border-border/40 hover:bg-secondary/15",
                    idx % 2 === 1 && "bg-secondary/5",
                  )}
                >
                  <TableCell className="px-4 py-3 font-medium text-foreground sticky left-0 bg-card">
                    {r.label}
                  </TableCell>
                  {showFamily && (
                    <TableCell className="px-3 py-3 text-foreground/80 capitalize">
                      {r.family?.slice(0, 3)}
                    </TableCell>
                  )}
                  <TableCell className="px-3 py-3 text-right font-mono tabular-nums text-foreground">
                    {editable ? (
                      <input
                        type="number"
                        step={r.weightIsPercent || r.weightGroup === "fundamentalMetrics" ? 1 : 0.1}
                        className="w-16 h-8 text-sm text-right bg-secondary/40 border border-border rounded-md px-2 text-foreground"
                        value={r.weightIsPercent || r.weightGroup === "fundamentalMetrics"
                          ? w
                          : Math.round(w * 1000) / 10}
                        onChange={e => handleWeight(r, e.target.value)}
                      />
                    ) : formatWeight(w, r)}
                  </TableCell>
                  <TableCell className="px-3 py-3 text-center">
                    <DirCell v={r.higherIsBetter} />
                  </TableCell>
                  <TableCell className="px-3 py-3 text-foreground/90">{r.source}</TableCell>
                  <TableCell className="px-3 py-3 text-foreground/90">{r.refresh}</TableCell>
                  <TableCell className={cn("px-3 py-3", coverageCellClass(coverageTone))}>
                    {coverageLabel}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "px-4 py-3 text-foreground/75 max-w-[240px]",
                      isWarning && "text-amber-400",
                    )}
                    title={notes}
                  >
                    {notes}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** @deprecated alias */
export const GuideMetricTable = GuideMetricGrid;
