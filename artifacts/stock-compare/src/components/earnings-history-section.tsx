import { useMemo, type ReactNode } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";

export interface EarningsQuarter {
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

const ESTIMATE_COLOR = "#d4af37";
const BEAT_COLOR = "#34d399";
const MISS_COLOR = "#f87171";
const EXACT_COLOR = "#e2e8f0";

function quarterOf(dateStr: string): { q: number; year: number } {
  const d = new Date(dateStr);
  return { q: Math.floor(d.getUTCMonth() / 3) + 1, year: d.getUTCFullYear() };
}

/** Axis: show Q1 / Q3 (and all ticks when few points). Format "Q1 26". */
function axisTickLabel(dateStr: string, showAll: boolean): string {
  const { q, year } = quarterOf(dateStr);
  if (!showAll && q !== 1 && q !== 3) return "";
  return `Q${q} ${String(year).slice(2)}`;
}

function outcomeColor(actual: number | null, estimate: number | null): string {
  if (actual == null || estimate == null) return EXACT_COLOR;
  if (actual > estimate) return BEAT_COLOR;
  if (actual < estimate) return MISS_COLOR;
  return EXACT_COLOR;
}

function ActualDot(props: {
  cx?: number;
  cy?: number;
  payload?: { actual: number | null; estimate: number | null };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.actual == null) return null;
  const fill = outcomeColor(payload.actual, payload.estimate ?? null);
  return <circle cx={cx} cy={cy} r={5} fill={fill} stroke={fill} />;
}

/** Beat line for BreakdownPanel header action (inline with “Earnings”). */
export function earningsBeatAction(history: EarningsQuarter[] | undefined): ReactNode {
  const stats = beatStats(history ?? []);
  if (!stats || stats.total === 0) return null;
  return (
    <span className="text-[11px] font-semibold text-white shrink-0 tabular-nums">
      Beat <span className="text-[#34d399]">{stats.beats}</span>/{stats.total}
    </span>
  );
}

function beatStats(history: EarningsQuarter[]): { beats: number; total: number } | null {
  const sorted = [...history].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reported = sorted
    .map((q) => ({ est: num(q.epsEstimate), act: num(q.epsActual) }))
    .filter((q) => q.act != null && q.est != null)
    .slice(-4);
  if (!reported.length) return null;
  const beats = reported.filter((q) => q.act! > q.est!).length;
  return { beats, total: reported.length };
}

export function EarningsHistorySection({
  history,
  compact = false,
}: {
  history: EarningsQuarter[];
  compact?: boolean;
}) {
  const sorted = useMemo(
    () => [...(history ?? [])].sort((a, b) => a.reportDate.localeCompare(b.reportDate)),
    [history],
  );

  const { chartData, implication } = useMemo(() => {
    if (sorted.length === 0) return { chartData: [] as Array<Record<string, unknown>>, implication: "" };
    const now = Date.now();
    const num = (v: unknown): number | null => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const plottable = sorted
      .map((q) => ({
        ...q,
        epsEstimate: num(q.epsEstimate),
        epsActual: num(q.epsActual),
        surprisePct: num(q.surprisePct),
      }))
      .filter((q) => q.epsEstimate != null || q.epsActual != null);

    // 1Y only: last 4 reported + near-term upcoming estimates.
    const upcoming = plottable.filter((q) => {
      const day = String(q.reportDate).slice(0, 10);
      const t = new Date(`${day}T12:00:00`).getTime();
      return Number.isFinite(t) && q.epsActual == null && t >= now - 90 * 86_400_000;
    });
    const reported = plottable.filter((q) => q.epsActual != null);
    const keepN = 4;
    const keptReported = reported.slice(-keepN);
    const use =
      keptReported.length > 0 || upcoming.length > 0
        ? [...keptReported, ...upcoming.filter((u) => !keptReported.some((r) => r.reportDate === u.reportDate))]
            .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
        : plottable.slice(-keepN);

    const showAll = use.length <= 6;
    const data = use.map((q) => ({
      label: `Q${quarterOf(q.reportDate).q} ${String(quarterOf(q.reportDate).year).slice(2)}`,
      axisLabel: axisTickLabel(q.reportDate, showAll),
      reportDate: q.reportDate,
      estimate: q.epsEstimate,
      actual: q.epsActual,
      beat: q.epsActual != null && q.epsEstimate != null && q.epsActual > q.epsEstimate,
      miss: q.epsActual != null && q.epsEstimate != null && q.epsActual < q.epsEstimate,
      surprisePct: q.surprisePct,
    }));

    const beats = data.filter((q) => q.beat).length;
    const total = data.filter((q) => q.actual != null && q.estimate != null).length;
    const nextEst = data.find((q) => q.actual == null && q.estimate != null);
    let impl = "";
    if (total === 0 && nextEst) {
      impl = `Next Street EPS ~$${Number(nextEst.estimate).toFixed(2)} — no recent prints yet.`;
    } else if (total > 0 && beats === total) {
      impl = `Beat Street all ${total} quarters — estimates still the bar to clear.`;
    } else if (total > 0 && beats === 0) {
      impl = `Missed Street all ${total} quarters — watch for estimate cuts.`;
    } else if (total > 0) {
      impl = `Beat ${beats}/${total} recent quarters vs estimate.`;
      if (nextEst?.estimate != null) {
        impl += ` Next est ~$${Number(nextEst.estimate).toFixed(2)}.`;
      }
    }

    return { chartData: data, implication: impl };
  }, [sorted]);

  if (!history || history.length === 0) {
    return (
      <div className="text-xs text-amber-100 py-3 text-center">
        No historical earnings data available for this ticker yet.
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="text-xs text-amber-100 py-3 text-center px-1">
        Earnings dates on file, but no EPS estimate/actual yet (vendor gap). Will fill on next earnings pull.
      </div>
    );
  }

  const yDomain = (() => {
    const vals = chartData
      .flatMap((q) => [q.estimate as number | null, q.actual as number | null])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) return ["auto", "auto"] as [string, string];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = Math.max(hi - lo, 0.05);
    const pad = span * 0.2;
    return [lo - pad, hi + pad] as [number, number];
  })();

  return (
    <div className="flex flex-col gap-1.5 w-full min-w-0">
      <div className={cn("w-full min-w-0", compact ? "h-[170px]" : "h-[210px]")}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 2 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
            <XAxis
              dataKey="label"
              interval={0}
              tick={{ fontSize: 10, fill: "#f5f5f5", fontWeight: 500 }}
              tickFormatter={(_label: string, index: number) => String(chartData[index]?.axisLabel ?? "")}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#e2e8f0" }}
              tickFormatter={(v: number) => `$${Number(v).toFixed(2)}`}
              domain={yDomain}
              width={44}
            />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11, color: "#fff" }}
              formatter={(v: unknown, name: string) => {
                const n = typeof v === "number" ? v : Number(v);
                return [Number.isFinite(n) ? `$${n.toFixed(2)}` : "—", name];
              }}
              labelFormatter={(_: string, payload: Array<{ payload?: { reportDate?: string } }>) => {
                const p = payload?.[0]?.payload;
                return p?.reportDate ? formatMdYy(String(p.reportDate).slice(0, 10)) : "";
              }}
            />
            {!compact && <Legend wrapperStyle={{ fontSize: 11 }} />}
            <Line
              type="monotone"
              dataKey="estimate"
              name="Est. EPS"
              stroke={ESTIMATE_COLOR}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeOpacity={0.55}
              dot={{ r: 4, fill: "transparent", stroke: ESTIMATE_COLOR, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: "transparent", stroke: ESTIMATE_COLOR, strokeWidth: 2 }}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual EPS"
              stroke="#64748b"
              strokeWidth={1}
              strokeOpacity={0.35}
              dot={<ActualDot />}
              activeDot={{ r: 6 }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {implication && (
        <p className="text-[11px] text-white leading-snug border-t border-[#d4af37]/15 pt-1.5">
          {implication}
        </p>
      )}
    </div>
  );
}
