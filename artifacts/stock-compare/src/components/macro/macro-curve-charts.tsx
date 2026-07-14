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
    <div className="flex rounded-md border border-border overflow-hidden text-[10px]">
      {(["current", "1wk", "1mo", "3mo"] as CurvePeriod[]).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "px-2 py-0.5 transition-colors",
            period === p ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
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
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-yellow-400" />
          VIX Curve
        </h3>
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {period !== "current" && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-400 inline-block" /> Current</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-orange-400 inline-block" style={{ borderBottom: "1px dashed #fb923c", background: "none" }} /> {periodLabel}</span>
        </div>
      )}
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <div className="h-[160px] flex flex-col items-center justify-center text-xs text-muted-foreground gap-1">
          <span>VIX term structure unavailable</span>
          <span className="text-[10px]">^VXST / ^VIX3M / ^VIX6M / ^VIX1Y data not found</span>
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
          {/* Spread changes per tenor */}
          {period !== "current" && (
            <div className="flex gap-1 flex-wrap">
              {vixCurve.map((pt) => {
                const comp = getPeriodValue(pt);
                const spread = pt.value != null && comp != null ? pt.value - comp : null;
                return (
                  <div key={pt.tenor} className="text-[10px] text-center px-1.5 py-0.5 rounded bg-secondary/50">
                    <div className="text-muted-foreground">{pt.tenor}</div>
                    <div className={cn("font-medium", spread == null ? "" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-muted-foreground")}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${spread.toFixed(2)}` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
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
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-blue-400" />
          Treasury Yield Curve
        </h3>
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {period !== "current" && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block" /> Current</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-orange-400 inline-block" /> {periodLabel}</span>
        </div>
      )}
      {!hasData ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
            <div className="flex gap-1 flex-wrap">
              {yieldCurve.map((pt) => {
                const comp =
                  period === "1wk" ? pt.weekAgo : period === "1mo" ? pt.monthAgo : pt.threeMonthAgo;
                const spread = pt.current != null && comp != null ? pt.current - comp : null;
                return (
                  <div key={pt.maturity} className="text-[10px] text-center px-1.5 py-0.5 rounded bg-secondary/50">
                    <div className="text-muted-foreground">{pt.maturity}</div>
                    <div className={cn("font-medium", spread == null ? "" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-muted-foreground")}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${(spread * 100).toFixed(0)}bp` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
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
    <div className={cn("border border-border rounded-lg space-y-1.5", compact ? "p-2.5" : "p-4 space-y-2")}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className={cn("font-semibold flex items-center gap-1.5", compact ? "text-xs" : "text-sm gap-2")}>
            <DollarSign className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "text-green-400")} />
            Fed Funds Curve
          </h3>
          {isProxy && !compact && (
            <p className="text-[9px] text-muted-foreground/60 italic">T-bill proxy (ZQ futures unavailable)</p>
          )}
        </div>
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {loading ? (
        <div style={{ height }} className="flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <div style={{ height }} className="flex flex-col items-center justify-center text-xs text-muted-foreground gap-1">
          <span>Fed Funds futures data unavailable</span>
          {!compact && <span className="text-[10px]">ZQ futures not found on this feed</span>}
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
            <div className="flex gap-1 flex-wrap">
              {data.map((pt) => {
                const comp =
                  period === "1wk" ? pt.weekAgo : period === "1mo" ? pt.monthAgo : pt.threeMonthAgo;
                const spread = pt.impliedRate != null && comp != null ? pt.impliedRate - comp : null;
                return (
                  <div key={pt.label} className="text-[10px] text-center px-1.5 py-0.5 rounded bg-secondary/50">
                    <div className="text-muted-foreground">{pt.label}</div>
                    <div className={cn("font-medium", spread == null ? "" : spread > 0 ? "text-red-400" : spread < 0 ? "text-green-400" : "text-muted-foreground")}>
                      {spread != null ? `${spread > 0 ? "+" : ""}${(spread * 100).toFixed(0)}bp` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
