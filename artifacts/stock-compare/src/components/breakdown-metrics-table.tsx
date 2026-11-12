import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  ESTIMATE_FIELDS,
  fieldSanityTip,
  freshnessBand,
  freshnessDotClass,
  formatProvenanceTip,
  joinTips,
  type MetricTipCtx,
  type ProvTipField,
} from "@/lib/provenance-display";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "./data-tip";

/** Fund family scores are 0–100. Pass max={5} only for legacy displays. */
export function ScoreBadge({
  score,
  max = 100,
  tip,
}: {
  score: number | null | undefined;
  max?: number;
  tip?: string;
}) {
  if (score == null || !Number.isFinite(score)) {
    return <span className="font-mono text-[11px] text-amber-100/80">—</span>;
  }
  const pct = max === 100 ? score : (score / max) * 100;
  const color =
    pct >= 70 ? "text-green-400" : pct >= 50 ? "text-yellow-400" : pct >= 35 ? "text-orange-400" : "text-red-400";
  return (
    <DataTip tip={tip}>
      <span className={cn("font-bold font-mono tabular-nums text-[11px]", color)}>
        {max === 100 ? score.toFixed(0) : `${score}/${max}`}
      </span>
    </DataTip>
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

function MetricReading({
  row,
  prov,
  metrics,
}: {
  row: MetricRowData;
  prov: ProvTipField | undefined;
  metrics?: MetricTipCtx | null;
}) {
  const provTip = formatProvenanceTip(prov);
  const sanity = row.fieldKey ? fieldSanityTip(row.fieldKey, metrics ?? {}) : undefined;
  const estimate = row.isEstimate ?? (row.fieldKey != null && ESTIMATE_FIELDS.has(row.fieldKey));
  const tip = joinTips(
    row.tip,
    provTip,
    sanity,
    estimate ? "Estimate / forward figure" : null,
  );
  const band = freshnessBand(prov?.fetchedAt);
  const showDot = row.fieldKey != null;

  return (
    <DataTip tip={tip}>
      <span
        className={cn(
          "inline-flex items-center justify-end gap-0.5 text-[11px] font-mono font-semibold tabular-nums whitespace-nowrap",
          row.good === true ? "text-emerald-400" : row.good === false ? "text-rose-400" : "text-white",
        )}
      >
        {showDot && (
          <span
            className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", freshnessDotClass(band))}
            aria-hidden
          />
        )}
        {estimate && (
          <span className="text-[8px] font-bold text-sky-300 border border-sky-400/50 rounded px-0.5 leading-none">
            E
          </span>
        )}
        {row.value}
      </span>
    </DataTip>
  );
}

const EMPTY: MetricRowData = { label: "", value: "" };

/** One 8-col GRID row: Value×2 · Growth×2 · Quality×2 · Safety×2 (metric | reading each). */
export function BreakdownMetricsTable({
  groups,
  byField,
  metrics,
  hideEmptyScore = false,
}: {
  groups: MetricGroup[];
  byField?: Map<string, ProvTipField>;
  metrics?: MetricTipCtx | null;
  /** Non-score uses (Portfolio › cash target): no "–" badge when a group has no score. */
  hideEmptyScore?: boolean;
}) {
  // Expect Value, Growth, Quality, Safety — pad/truncate to 4 slots for stable columns.
  const cols = [0, 1, 2, 3].map((i) => groups[i] ?? { title: "—", score: null, rows: [] as MetricRowData[] });
  const maxRows = Math.max(1, ...cols.map((g) => g.rows.length));

  return (
    <div className={GRID_WRAP} id="bd-score-evidence">
      <table className="w-full border-collapse table-fixed">
        <thead>
          <tr className={GRID_HEADER}>
            {cols.map((g, gi) => (
              <th
                key={g.sectionId ?? `${g.title}-${gi}`}
                id={g.sectionId}
                colSpan={2}
                className={cn(
                  GRID_TH,
                  "text-left py-0.5",
                  gi > 0 && "border-l border-[#d4af37]/20",
                )}
              >
                <span className="inline-flex items-baseline gap-1.5">
                  <span>{g.title}</span>
                  {hideEmptyScore && g.score == null ? null : <ScoreBadge
                    score={g.score}
                    max={100}
                    tip={`${g.title} family score · computed · peer-relative fund model`}
                  />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxRows }, (_, ri) => (
            <tr key={ri} className={gridRow(ri)}>
              {cols.map((g, gi) => {
                const row = g.rows[ri] ?? EMPTY;
                const blank = !row.label;
                const provTip = row.fieldKey ? formatProvenanceTip(byField?.get(row.fieldKey)) : undefined;
                const sanity = row.fieldKey ? fieldSanityTip(row.fieldKey, metrics ?? {}) : undefined;
                const labelTip = joinTips(row.tip, provTip, sanity);
                return (
                  <FragmentPair
                    key={`${gi}-${ri}`}
                    gi={gi}
                    blank={blank}
                    label={row.label}
                    labelTip={labelTip}
                    reading={
                      blank ? null : (
                        <MetricReading
                          row={row}
                          prov={row.fieldKey ? byField?.get(row.fieldKey) : undefined}
                          metrics={metrics}
                        />
                      )
                    }
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FragmentPair({
  gi,
  blank,
  label,
  labelTip,
  reading,
}: {
  gi: number;
  blank: boolean;
  label: string;
  labelTip?: string;
  reading: ReactNode;
}) {
  const edge = gi > 0 ? "border-l border-[#d4af37]/15" : "";
  return (
    <>
      <td className={cn(GRID_TD, "py-0.5 px-1 text-[10px] text-white min-w-0 overflow-hidden", edge, blank && "text-transparent")}>
        {blank ? "\u00a0" : (
          <DataTip tip={labelTip}>
            <span className="cursor-help whitespace-nowrap overflow-hidden text-ellipsis block max-w-full">
              {label}
            </span>
          </DataTip>
        )}
      </td>
      <td className={cn(GRID_TD, "py-0.5 px-1 text-right min-w-0 overflow-hidden")}>
        <div className="overflow-hidden text-ellipsis whitespace-nowrap max-w-full">{reading}</div>
      </td>
    </>
  );
}
