import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Activity, DollarSign, TrendingDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VixCurvePoint, FedFundsCurvePoint, YieldCurvePoint, CurvePeriod } from "./macro-page-types";

// ── Period buttons (shared curve control) ─────────────────────────────────────

export function CurvePeriodButtons({
  period,
  onChange,
}: {
  period: CurvePeriod;
  onChange: (p: CurvePeriod) => void;
}) {
  return (
    <div className="flex gap-1">
      {(["current", "1wk", "1mo", "3mo"] as CurvePeriod[]).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "px-2 py-1 transition-colors text-[11px] font-semibold rounded border border-[#d4af37]/20",
            p === period ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
          )}
        >
          {p === "current" ? "Live" : p}
        </button>
      ))}
    </div>
  );
}

// ── VIX Curve Chart ─────────────────────────────────────────────────────────────

export function VixCurveChart({
  vixCurve,
  loading,
  period,
  onPeriodChange,
}: {
  vixCurve: VixCurvePoint[];
  loading: boolean;
  period: CurvePeriod;
  onPeriodChange: (p: CurvePeriod) => void;
}) {
  const getPeriodValue = (pt: VixCurvePoint): number | null =>
    period === "1wk" ? pt.weekAgo : period === "1mo" ? pt.monthAgo : period === "3mo" ? pt.threeMonthAgo : null;

  const hasData = vixCurve.some((p) => p.value != null);

  const periodLabel =
    period === "1wk" ? "1 Wk Ago" : period === "1mo" ? "1 Mo Ago" : period === "3mo" ? "3 Mo Ago" : "";

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <Activity className="h-3.5 w-3.5 text-[#d4af37]/80" />
          VIX Curve
        </span>
        {period !== "current" && (
          <span className="text-[10px] font-mono text-amber-200/40">
            <span className="text-[#d4af37]">Current</span> · <span className="text-sky-300/60">{periodLabel}</span>
          </span>
        )}
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
        </div>
      ) : !hasData ? (
        <div className="h-[160px] flex items-center justify-center text-xs text-amber-200/40">
          VIX term structure unavailable
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={vixCurve} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="tenor" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
              <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip
                contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
                formatter={(v: number, name: string) => {
                  return [`${v.toFixed(2)}`, name];
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#facc15"
                dot={{ r: 4, fill: "#facc15" }}
                strokeWidth={2}
                name="Current"
                connectNulls
              />
              {period !== "current" && (
                <Line
                  type="monotone"
                  dataKey={period === "1wk" ? "weekAgo" : period === "1mo" ? "monthAgo" : "threeMonthAgo"}
                  stroke="#fb923c"
                  dot={{ r: 3, fill: "#fb923c" }}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  name={periodLabel}
                  connectNulls
                />
              )}
            </LineChart>
          </ResponsiveContainer>
          {period !== "current" && (
            <span className="block text-[11px] font-mono text-sky-300/60">
              {vixCurve.map((pt, i) => {
                const comp = getPeriodValue(pt);
                const spread = pt.value != null && comp != null ? pt.value - comp : null;
                return (
                  <span key={pt.tenor}>
                    {i > 0 && " · "}
                    <span className="text-amber-200/40">{pt.tenor}</span>
                    {" "}
                    <span className={spread == null ? "text-amber-200/40" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-amber-200/40"}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${spread.toFixed(2)}` : "—"}
                    </span>
                  </span>
                );
              })}
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ── Treasury Yield Curve Chart ─────────────────────────────────────────────────

export function YieldCurveChart({
  yieldCurve,
  period,
  onPeriodChange,
}: {
  yieldCurve: YieldCurvePoint[];
  period: CurvePeriod;
  onPeriodChange: (p: CurvePeriod) => void;
}) {
  const hasData = yieldCurve.some((p) => p.current != null);
  const periodLabel =
    period === "1wk" ? "1 Wk Ago" : period === "1mo" ? "1 Mo Ago" : period === "3mo" ? "3 Mo Ago" : "";

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <TrendingDown className="h-3.5 w-3.5 text-[#d4af37]/80" />
          Treasury Yield Curve
        </span>
        {period !== "current" && (
          <span className="text-[10px] font-mono text-amber-200/40">
            <span className="text-[#d4af37]">Current</span> · <span className="text-sky-300/60">{periodLabel}</span>
          </span>
        )}
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {!hasData ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={yieldCurve} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="maturity" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
              <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
              <Tooltip
                contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
                formatter={(v: number) => [`${v.toFixed(3)}%`]}
              />
              <Line
                type="monotone" dataKey="current" stroke="#60a5fa"
                dot={{ r: 3, fill: "#60a5fa" }} strokeWidth={2} name="Current" connectNulls
              />
              {period === "1wk" && (
                <Line type="monotone" dataKey="weekAgo" stroke="#fb923c" dot={{ r: 2, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="1 Wk Ago" connectNulls />
              )}
              {period === "1mo" && (
                <Line type="monotone" dataKey="monthAgo" stroke="#fb923c" dot={{ r: 2, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="1 Mo Ago" connectNulls />
              )}
              {period === "3mo" && (
                <Line type="monotone" dataKey="threeMonthAgo" stroke="#fb923c" dot={{ r: 2, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="3 Mo Ago" connectNulls />
              )}
            </LineChart>
          </ResponsiveContainer>
          {period !== "current" && (
            <span className="block text-[11px] font-mono text-sky-300/60">
              {yieldCurve.map((pt, i) => {
                const comp =
                  period === "1wk" ? pt.weekAgo : period === "1mo" ? pt.monthAgo : pt.threeMonthAgo;
                const spread = pt.current != null && comp != null ? pt.current - comp : null;
                return (
                  <span key={pt.maturity}>
                    {i > 0 && " · "}
                    <span className="text-amber-200/40">{pt.maturity}</span>
                    {" "}
                    <span className={spread == null ? "text-amber-200/40" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-amber-200/40"}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${(spread * 100).toFixed(0)}bp` : "—"}
                    </span>
                  </span>
                );
              })}
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ── Fed Funds Curve Chart ──────────────────────────────────────────────────────

export function FedFundsCurveChart({
  data,
  loading,
  period,
  onPeriodChange,
  compact,
}: {
  data: FedFundsCurvePoint[];
  loading: boolean;
  period: CurvePeriod;
  onPeriodChange: (p: CurvePeriod) => void;
  compact?: boolean;
}) {
  const hasData = data.some((p) => p.impliedRate != null);
  const isProxy = data.some((p) => p.isTbillProxy);
  const height = compact ? 120 : 160;

  return (
    <div className={cn("rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 space-y-1.5", compact ? "p-2" : "p-2")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          <DollarSign className="h-3.5 w-3.5 text-[#d4af37]/80" />
          Fed Funds Curve
          {isProxy && <span className="normal-case font-normal text-amber-200/40">(T-bill proxy)</span>}
        </span>
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {loading ? (
        <div style={{ height }} className="flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[#d4af37]/60" />
        </div>
      ) : !hasData ? (
        <div style={{ height }} className="flex items-center justify-center text-xs text-amber-200/40">
          Fed Funds futures data unavailable
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
              <YAxis
                tick={{ fontSize: 9, fill: "#cbd5e1" }}
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => `${v.toFixed(2)}%`}
              />
              <Tooltip
                contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
                formatter={(v: number) => [`${v.toFixed(3)}%`]}
              />
              <Line
                type="monotone" dataKey="impliedRate" stroke="#4ade80"
                dot={{ r: 4, fill: "#4ade80" }} strokeWidth={2} name="Current" connectNulls
              />
              {period === "1wk" && (
                <Line type="monotone" dataKey="weekAgo" stroke="#fb923c" dot={{ r: 3, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="1 Wk Ago" connectNulls />
              )}
              {period === "1mo" && (
                <Line type="monotone" dataKey="monthAgo" stroke="#fb923c" dot={{ r: 3, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="1 Mo Ago" connectNulls />
              )}
              {period === "3mo" && (
                <Line type="monotone" dataKey="threeMonthAgo" stroke="#fb923c" dot={{ r: 3, fill: "#fb923c" }} strokeWidth={1.5} strokeDasharray="4 3" name="3 Mo Ago" connectNulls />
              )}
            </LineChart>
          </ResponsiveContainer>
          {period !== "current" && !compact && (
            <span className="block text-[11px] font-mono text-sky-300/60">
              {data.map((pt, i) => {
                const comp =
                  period === "1wk" ? pt.weekAgo : period === "1mo" ? pt.monthAgo : pt.threeMonthAgo;
                const spread = pt.impliedRate != null && comp != null ? pt.impliedRate - comp : null;
                return (
                  <span key={pt.label}>
                    {i > 0 && " · "}
                    <span className="text-amber-200/40">{pt.label}</span>
                    {" "}
                    <span className={spread == null ? "text-amber-200/40" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-amber-200/40"}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${(spread * 100).toFixed(0)}bp` : "—"}
                    </span>
                  </span>
                );
              })}
            </span>
          )}
        </>
      )}
    </div>
  );
}
