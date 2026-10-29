import { useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, AreaChart, ReferenceLine, Area, ComposedChart, Scatter,
} from "recharts";
import { Loader2, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChartPoint, IndicatorHistory, SepData, SepActuals, SepMetric, LiquiditySignal } from "./macro-page-types";
import { LIQUIDITY_LEVEL_STYLE, fmtChartDate } from "./macro-format";

// ── Rate History Chart ──────────────────────────────────────────────────────────

export type HistoryPeriod = "1m" | "3m" | "6m" | "1y";

export function filterByPeriod(data: ChartPoint[], period: HistoryPeriod): ChartPoint[] {
  const days = period === "1m" ? 30 : period === "3m" ? 90 : period === "6m" ? 180 : 365;
  const cutoff = new Date(Date.now() - days * 86400_000);
  const filtered = data.filter((d) => new Date(d.date) >= cutoff);
  return filtered.length > 2 ? filtered : data;
}

export function RateHistoryChart({
  title, data, color, loading,
  yFormatter = (v: number) => `${v.toFixed(2)}%`,
  tooltipFormatter = (v: number) => [`${v.toFixed(2)}%`],
  referenceLines,
  compact,
}: {
  title: string;
  data: ChartPoint[];
  color: string;
  loading: boolean;
  yFormatter?: (v: number) => string;
  tooltipFormatter?: (v: number) => [string];
  referenceLines?: { y: number; label: string; color: string }[];
  compact?: boolean;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>("3m");
  const filtered = filterByPeriod(data, period);
  const height = compact ? 120 : 160;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">{title}</h3>
        <div className="flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px]">
          {(["1m", "3m", "6m", "1y"] as HistoryPeriod[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={cn("px-1.5 py-0.5 font-semibold transition-colors", period === p ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
              {p === "1y" ? "1Y" : p === "6m" ? "6M" : p === "3m" ? "3M" : "1M"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div style={{ height }} className="flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-amber-200/40" />
        </div>
      ) : filtered.length > 0 ? (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={filtered} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "#cbd5e1" }}
              tickFormatter={fmtChartDate}
              interval={Math.max(0, Math.floor(filtered.length / 6))}
            />
            <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={yFormatter} />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: unknown) => tooltipFormatter(v as number)}
              labelFormatter={fmtChartDate}
            />
            {referenceLines?.map(rl => (
              <ReferenceLine key={rl.label} y={rl.y} stroke={rl.color} strokeDasharray="4 3" strokeOpacity={0.5}
                label={{ value: rl.label, fill: rl.color, fontSize: 9, position: "insideTopRight" }} />
            ))}
            <Area
              type="monotone" dataKey="value" stroke={color}
              fill={`url(#grad-${color.replace("#", "")})`}
              dot={false} strokeWidth={1.5}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height }} className="flex items-center justify-center text-xs text-amber-200/40">
          No data
        </div>
      )}
    </div>
  );
}

// ── Balance Sheet / QT card ───────────────────────────────────────────────────────

function deriveBalanceSheetStats(fedAssetsHistory: ChartPoint[]) {
  const sorted = [...fedAssetsHistory].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const latest = sorted[sorted.length - 1];
  const cutoffTime = new Date(latest.date).getTime() - 91 * 86_400_000;
  const past = [...sorted].reverse().find((p) => new Date(p.date).getTime() <= cutoffTime) ?? sorted[0];
  const deltaM = latest.value - past.value; // $M
  const pctChange = past.value !== 0 ? (deltaM / Math.abs(past.value)) * 100 : null;
  return {
    latestT: latest.value / 1e6,
    deltaT: deltaM / 1e6,
    pctChange,
    isShrinking: deltaM < 0,
  };
}

export function BalanceSheetCard({
  fedAssetsHistory,
  rrpSignal,
  loading,
  compact,
}: {
  fedAssetsHistory: ChartPoint[];
  rrpSignal: LiquiditySignal | undefined;
  loading: boolean;
  compact?: boolean;
}) {
  const stats = deriveBalanceSheetStats(fedAssetsHistory);
  const style = rrpSignal ? LIQUIDITY_LEVEL_STYLE[rrpSignal.level] : LIQUIDITY_LEVEL_STYLE.unknown;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1.5">
      <div className="flex items-center justify-between flex-wrap gap-1">
        <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5">
          <Landmark className="h-3.5 w-3.5 text-[#d4af37]" />
          Balance Sheet (QT/QE)
        </h2>
        {stats && !compact && (
          <span className="text-[10px] font-mono text-sky-300/60">
            ${stats.latestT.toFixed(2)}T · {stats.isShrinking ? "" : "+"}{stats.deltaT.toFixed(2)}T /3mo
            {stats.pctChange != null && ` (${stats.pctChange >= 0 ? "+" : ""}${stats.pctChange.toFixed(1)}%)`}
          </span>
        )}
      </div>
      <RateHistoryChart
        title="Fed Total Assets (WALCL)"
        data={fedAssetsHistory}
        color="#f59e0b"
        loading={loading}
        yFormatter={(v: number) => `$${(v / 1e6).toFixed(1)}T`}
        tooltipFormatter={(v: number) => [`$${(v / 1e6).toFixed(2)}T`]}
        compact
      />
      {stats && compact && (
        <p className="text-[10px] font-mono text-sky-300/60">
          ${stats.latestT.toFixed(2)}T · {stats.isShrinking ? "" : "+"}{stats.deltaT.toFixed(2)}T /3mo
        </p>
      )}
      {rrpSignal && (
        <div className="rounded border border-[#d4af37]/20 bg-black flex items-start gap-1.5 p-1.5">
          <span className={cn("w-1.5 h-1.5 rounded-full inline-block shrink-0 mt-1", style.dot)} />
          <div>
            <p className={cn("font-semibold text-[11px]", style.text)}>{rrpSignal.label}: {rrpSignal.readout}</p>
            {!compact && <p className="text-[11px] text-amber-200/50 leading-snug">{rrpSignal.implication}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function DualLineHistoryChart({
  title, data1, data2, color1, color2, label1, label2, loading,
  yFormatter = (v: number) => `${v.toFixed(2)}%`,
  tooltipFormatter = (v: number, name: string) => [`${v.toFixed(2)}%`, name],
  referenceLines,
}: {
  title: string;
  data1: ChartPoint[];
  data2: ChartPoint[];
  color1: string;
  color2: string;
  label1: string;
  label2: string;
  loading: boolean;
  yFormatter?: (v: number) => string;
  tooltipFormatter?: (v: number, name: string) => [string, string];
  referenceLines?: { y: number; label: string; color: string }[];
}) {
  const [period, setPeriod] = useState<HistoryPeriod>("3m");

  // Merge both series by date for Recharts
  const merged = (() => {
    const map = new Map<string, { date: string; v1?: number; v2?: number }>();
    for (const p of filterByPeriod(data1, period)) {
      map.set(p.date, { date: p.date, v1: p.value });
    }
    for (const p of filterByPeriod(data2, period)) {
      const entry = map.get(p.date) ?? { date: p.date };
      entry.v2 = p.value;
      map.set(p.date, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">{title}</h3>
        <div className="flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px]">
          {(["1m", "3m", "6m", "1y"] as HistoryPeriod[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={cn("px-1.5 py-0.5 font-semibold transition-colors", period === p ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
              {p === "1y" ? "1Y" : p === "6m" ? "6M" : p === "3m" ? "3M" : "1M"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-amber-200/40" />
        </div>
      ) : merged.length > 0 ? (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={merged} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#cbd5e1" }}
              tickFormatter={fmtChartDate}
              interval={Math.max(0, Math.floor(merged.length / 6))} />
            <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={yFormatter} />
            <Tooltip contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: unknown, name: unknown) => tooltipFormatter(v as number, name as string)}
              labelFormatter={fmtChartDate} />
            <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
            {referenceLines?.map(rl => (
              <ReferenceLine key={rl.label} y={rl.y} stroke={rl.color} strokeDasharray="4 3" strokeOpacity={0.5}
                label={{ value: rl.label, fill: rl.color, fontSize: 9, position: "insideTopRight" }} />
            ))}
            <Line type="monotone" dataKey="v1" name={label1} stroke={color1} dot={false} strokeWidth={1.5} connectNulls />
            <Line type="monotone" dataKey="v2" name={label2} stroke={color2} dot={false} strokeWidth={1.5} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[160px] flex items-center justify-center text-xs text-amber-100">
          No data
        </div>
      )}
    </div>
  );
}

// ── Indicator History Chart ──────────────────────────────────────────────────────

export function IndicatorHistoryChart({
  data,
  loading,
}: {
  data: IndicatorHistory | undefined;
  loading: boolean;
}) {
  const color = "#38bdf8";

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          {data ? `${data.label}${data.isYoY ? " (YoY %)" : ` (${data.unit})`}` : "Select a row above to view history"}
        </p>
        {data && (
          <span className="text-[10px] text-amber-200/40">~10yr</span>
        )}
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-amber-200/40" />
        </div>
      ) : !data || data.data.length === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-xs text-amber-200/40">
          {data ? "No history data available" : "Click any indicator row above"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data.data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="indGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "#cbd5e1" }}
              tickFormatter={fmtChartDate}
              interval={Math.max(0, Math.floor(data.data.length / 8))}
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#cbd5e1" }}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) =>
                data.isYoY ? `${v.toFixed(1)}%` : v.toFixed(data.unit === "%" ? 2 : 0)
              }
            />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: number) => [
                data.isYoY ? `${v.toFixed(2)}%` : `${v.toFixed(2)} ${data.unit}`,
                data.label,
              ]}
              labelFormatter={fmtChartDate}
            />
            <Area
              type="monotone" dataKey="value" stroke={color}
              fill="url(#indGrad)" dot={false} strokeWidth={1.5}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── SEP Dots Chart ───────────────────────────────────────────────────────────────

export function SepDotsChart({
  sepData,
  actuals,
  metric,
  compact,
}: {
  sepData: SepData;
  actuals: SepActuals | undefined;
  metric: SepMetric;
  compact?: boolean;
}) {
  const actualsData: ChartPoint[] =
    metric === "fedRate"    ? (actuals?.fedFunds ?? []) :
    metric === "gdp"        ? (actuals?.gdp ?? []) :
    metric === "corePce"    ? (actuals?.corePce ?? []) :
    /* unemployment */        (actuals?.unemployment ?? []);

  // Take last 5 years of monthly data for the chart
  const cutoff = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const historyPoints = actualsData
    .filter((p) => new Date(p.date) >= cutoff)
    .map((p) => ({ date: p.date, actual: p.value, projected: undefined as number | undefined }));

  // Append SEP projection points (place at Dec of each year)
  const projPoints = sepData.projections.map((p) => ({
    date: `${p.year}-12-31`,
    actual: undefined as number | undefined,
    projected: metric === "fedRate"      ? p.fedRate     :
                metric === "gdp"         ? p.gdp         :
                metric === "unemployment"? p.unemployment:
                                           p.corePce,
  }));

  const combined = [...historyPoints, ...projPoints].sort((a, b) => a.date.localeCompare(b.date));

  const metricUnit =
    metric === "fedRate"    ? "%" :
    metric === "gdp"        ? "%" :
    metric === "corePce"    ? "% YoY" :
                               "%";

  const height = compact ? 120 : 180;

  if (!actuals) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-amber-200/40" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {!compact && (
        <div className="flex items-center gap-3 text-[10px] text-amber-200/50">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-sky-400 inline-block" /> Actual</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
            SEP Projection
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={combined} margin={{ top: 4, right: 16, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "#cbd5e1" }}
            tickFormatter={fmtChartDate}
            interval={Math.max(0, Math.floor(combined.length / 8))}
          />
          <YAxis
            tick={{ fontSize: 9, fill: "#cbd5e1" }}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `${v.toFixed(1)}${metricUnit.includes("%") ? "%" : ""}`}
          />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
            formatter={(v: number, name: string) => [
              `${v.toFixed(2)}${metricUnit}`, name === "actual" ? "Actual" : "SEP Projection",
            ]}
            labelFormatter={fmtChartDate}
          />
          <Area
            type="monotone" dataKey="actual" stroke="#60a5fa"
            fill="none" dot={false} strokeWidth={1.5} name="actual" connectNulls
          />
          <Scatter dataKey="projected" fill="#fb923c" name="projected" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
