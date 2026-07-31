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
  if (v === "band") return <span className="text-amber-200/60 font-medium">Band</span>;
  return (
    <span className={cn("text-sm font-bold", v ? "text-green-400" : "text-sky-300/80")}>
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
  return "text-amber-200/50";
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
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 mb-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-black">
            <TableRow className="hover:bg-transparent border-b border-[#d4af37]/25">
              <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] sticky left-0 bg-black min-w-[140px]">
                Metric
              </TableHead>
              {showFamily && (
                <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-16">
                  Fam
                </TableHead>
              )}
              <TableHead className="px-2.5 py-1 text-right font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-20">
                Weight
              </TableHead>
              <TableHead className="px-2.5 py-1 text-center font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-12">
                Dir
              </TableHead>
              <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-24">
                Source
              </TableHead>
              <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-20">
                Refresh
              </TableHead>
              <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] w-28">
                Coverage
              </TableHead>
              <TableHead className="px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider text-[#d4af37] min-w-[160px]">
                Notes
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-zinc-800">
            {rows.map((r) => {
              const w = getWeightFromConfig(config, r.weightGroup, r.weightKey);
              const notes = r.notes + noteSuffix;
              const isWarning = notes.includes("proxy") || notes.includes("Excluded") || !!noteSuffix;
              return (
                <TableRow
                  key={r.key}
                  id={`metric-${r.key}`}
                  className="border-none bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors"
                >
                  <TableCell className="px-2.5 py-1 font-medium text-white sticky left-0 bg-inherit">
                    {r.label}
                  </TableCell>
                  {showFamily && (
                    <TableCell className="px-2.5 py-1 text-amber-200/60 capitalize">
                      {r.family?.slice(0, 3)}
                    </TableCell>
                  )}
                  <TableCell className="px-2.5 py-1 text-right font-mono tabular-nums text-sky-300/80">
                    {editable ? (
                      <input
                        type="number"
                        step={r.weightIsPercent || r.weightGroup === "fundamentalMetrics" ? 1 : 0.1}
                        className="w-16 h-6 text-xs text-right bg-zinc-900 border border-[#d4af37]/25 rounded px-1.5 text-white"
                        value={r.weightIsPercent || r.weightGroup === "fundamentalMetrics"
                          ? w
                          : Math.round(w * 1000) / 10}
                        onChange={e => handleWeight(r, e.target.value)}
                      />
                    ) : formatWeight(w, r)}
                  </TableCell>
                  <TableCell className="px-2.5 py-1 text-center">
                    <DirCell v={r.higherIsBetter} />
                  </TableCell>
                  <TableCell className="px-2.5 py-1 text-amber-200/60">{r.source}</TableCell>
                  <TableCell className="px-2.5 py-1 text-amber-200/60">{r.refresh}</TableCell>
                  <TableCell className={cn("px-2.5 py-1", coverageCellClass(coverageTone))}>
                    {coverageLabel}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "px-2.5 py-1 text-amber-200/50 max-w-[240px] truncate",
                      isWarning && "text-yellow-400",
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
