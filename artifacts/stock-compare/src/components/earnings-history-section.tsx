import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

export interface EarningsQuarter {
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

const BEAT_COLOR = "#34d399";
const ESTIMATE_COLOR = "#d4af37";
// Bright solid dot for actual EPS — a single fixed color, not beat/miss-coded, since
// green/red on a bar read as "good/bad absolute result" when it actually meant
// "beat/missed estimate" (misleading on tickers like AAOI where EPS is negative
// every quarter but still beats a more-negative estimate).
const ACTUAL_COLOR = "#e2e8f0";

function formatQuarterLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(d.getUTCFullYear()).slice(2)}`;
}

export function EarningsHistorySection({ history }: { history: EarningsQuarter[] }) {
  if (!history || history.length === 0) {
    return (
      <div className="text-xs text-amber-200/50 py-6 text-center">
        No historical earnings data available for this ticker yet.
      </div>
    );
  }

  const chartData = [...history]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
    .map(q => ({
      label: formatQuarterLabel(q.reportDate),
      reportDate: q.reportDate,
      estimate: q.epsEstimate,
      actual: q.epsActual,
      beat: q.epsActual != null && q.epsEstimate != null && q.epsActual >= q.epsEstimate,
      surprisePct: q.surprisePct,
    }));

  const beats = chartData.filter(q => q.beat).length;
  const total = chartData.filter(q => q.actual != null && q.estimate != null).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          EPS — actual vs. estimate ({chartData.length} quarters)
        </span>
        {total > 0 && (
          <span className="text-[11px] font-semibold text-amber-200/70">
            Beat estimates <span className="text-[#34d399]">{beats}</span>/{total} quarters
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} barSize={22} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
          <YAxis tick={{ fontSize: 10, fill: "#cbd5e1" }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
            formatter={(v: unknown, name: string) => [v != null ? `$${(v as number).toFixed(2)}` : "—", name]}
            labelFormatter={(_: string, payload: any[]) => {
              const p = payload?.[0]?.payload;
              return p ? new Date(p.reportDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone" dataKey="estimate" name="Est. EPS"
            stroke="none"
            dot={{ r: 5, fill: "transparent", stroke: ESTIMATE_COLOR, strokeWidth: 2 }}
            activeDot={{ r: 6, fill: "transparent", stroke: ESTIMATE_COLOR, strokeWidth: 2 }}
            connectNulls
          />
          <Line
            type="monotone" dataKey="actual" name="Actual EPS"
            stroke="none"
            dot={{ r: 5, fill: ACTUAL_COLOR, stroke: ACTUAL_COLOR }}
            activeDot={{ r: 6, fill: ACTUAL_COLOR, stroke: ACTUAL_COLOR }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
