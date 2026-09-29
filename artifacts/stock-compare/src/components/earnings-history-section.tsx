import { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { cn } from "@/lib/utils";

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

function formatQuarterLabel(dateStr: string): string {
  const { q, year } = quarterOf(dateStr);
  return `Q${q} '${String(year).slice(2)}`;
}

/** Axis label only for Q2 / Q4; other quarters blank. */
function axisTickLabel(dateStr: string): string {
  const { q, year } = quarterOf(dateStr);
  if (q !== 2 && q !== 4) return "";
  return `Q${q} '${String(year).slice(2)}`;
}

function outcomeColor(actual: number | null, estimate: number | null): string {
  if (actual == null || estimate == null) return EXACT_COLOR;
  if (actual > estimate) return BEAT_COLOR;
  if (actual < estimate) return MISS_COLOR;
  return EXACT_COLOR;
}

/** Custom actual EPS dot: green beat / red miss / white exact. */
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

export type EarningsRange = "1Y" | "2Y";

export function EarningsHistorySection({
  history,
  compact = false,
}: {
  history: EarningsQuarter[];
  compact?: boolean;
}) {
  const [range, setRange] = useState<EarningsRange>("2Y");

  const sorted = useMemo(
    () => [...(history ?? [])].sort((a, b) => a.reportDate.localeCompare(b.reportDate)),
    [history],
  );

  const chartData = useMemo(() => {
    if (sorted.length === 0) return [];
    const now = new Date();
    const startYear = range === "1Y" ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const filtered = sorted.filter((q) => {
      const d = new Date(q.reportDate);
      const y = d.getUTCFullYear();
      if (y >= startYear) return true;
      if (q.epsActual == null && d.getTime() >= now.getTime() - 90 * 86_400_000) return true;
      return false;
    });
    return (filtered.length > 0 ? filtered : sorted.slice(-8)).map((q) => ({
      label: formatQuarterLabel(q.reportDate),
      axisLabel: axisTickLabel(q.reportDate),
      reportDate: q.reportDate,
      estimate: q.epsEstimate,
      actual: q.epsActual,
      beat: q.epsActual != null && q.epsEstimate != null && q.epsActual > q.epsEstimate,
      miss: q.epsActual != null && q.epsEstimate != null && q.epsActual < q.epsEstimate,
      surprisePct: q.surprisePct,
    }));
  }, [sorted, range]);

  if (!history || history.length === 0) {
    return (
      <div className="text-xs text-amber-200/50 py-3 text-center">
        No historical earnings data available for this ticker yet.
      </div>
    );
  }

  const beats = chartData.filter((q) => q.beat).length;
  const total = chartData.filter((q) => q.actual != null && q.estimate != null).length;

  const yDomain = (() => {
    const vals = chartData
      .flatMap((q) => [q.estimate, q.actual])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) return ["auto", "auto"] as const;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = Math.max(hi - lo, 0.05);
    const pad = span * 0.2;
    return [lo - pad, hi + pad] as [number, number];
  })();

  return (
    <div className="flex flex-col h-full min-h-0 gap-1.5">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="inline-flex rounded border border-[#d4af37]/25 overflow-hidden text-[10px] font-semibold">
          {(["1Y", "2Y"] as EarningsRange[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "px-2 py-0.5 transition-colors",
                range === r ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
              )}
              title={r === "1Y" ? "This fiscal year + next period" : "Past year + this year + next period"}
            >
              {r}
            </button>
          ))}
        </div>
        {total > 0 && (
          <span className="text-[10px] font-semibold text-amber-200/70">
            Beat <span className="text-[#34d399]">{beats}</span>/{total}
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={compact ? 250 : 240}>
        <ComposedChart data={chartData} margin={{ top: 12, right: 10, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
          <XAxis
            dataKey="label"
            interval={0}
            tick={{ fontSize: 9, fill: "#94a3b8" }}
            tickFormatter={(_label: string, index: number) => chartData[index]?.axisLabel ?? ""}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#cbd5e1" }}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            domain={yDomain}
            width={44}
          />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
            formatter={(v: unknown, name: string) => [v != null ? `$${(v as number).toFixed(2)}` : "—", name]}
            labelFormatter={(_: string, payload: any[]) => {
              const p = payload?.[0]?.payload;
              return p
                ? new Date(p.reportDate).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "";
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
  );
}
