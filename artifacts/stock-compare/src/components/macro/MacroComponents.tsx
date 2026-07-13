import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, AreaChart, ReferenceLine, Area, ScatterChart, Scatter,
  ComposedChart, ReferenceDot, BarChart, Bar, Cell, LabelList, ZAxis,
} from "recharts";
import {
  RefreshCw, Loader2, ChevronDown, ChevronUp, TrendingUp, TrendingDown,
  Sparkles, Calendar, AlertTriangle, Activity, DollarSign, Building2,
  Newspaper, ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  MacroData, FedMember, BankResearch, MacroEvent, ChartPoint,
  VixCurvePoint, FedFundsCurvePoint, YieldCurvePoint,
  COTRecord, COTSummary, CurvePeriod, SepMetric, IndicatorHistory, SepActuals,
  SepData, NewsArticle, SectorRotationPoint, LiquidityImplications, LiquiditySignal,
} from "./macro-page-types";

// ── Formatting ─────────────────────────────────────────────────────────────────


// ── Formatting ─────────────────────────────────────────────────────────────────

export const fmt = (v: number | null | undefined, dec = 2) =>
  v != null ? v.toFixed(dec) : "—";

export const fmtPct = (v: number | null, dec = 1) =>
  v != null ? `${v.toFixed(dec)}%` : "—";

export const fmtK = (v: number | null) =>
  v != null ? v.toLocaleString() + "K" : "—";

export const fmtB = (v: number | null) =>
  v != null ? `$${(v / 1000).toFixed(1)}B` : "—";

export const fmtDate = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const fmtTs = (s: string) =>
  new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const fmtMonthYear = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" });

export const changeColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

export const inflColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-red-400" : v < 0 ? "text-green-400" : "text-muted-foreground";

// ── VIX helpers ────────────────────────────────────────────────────────────────

export const VIX_LEVEL_LABELS: Record<MacroData["vix"]["level"], string> = {
  "very-low": "Very Low",
  low:        "Low",
  "low-mid":  "Low-Mid",
  mid:        "Mid",
  "mid-high": "Mid-High",
  high:       "High",
};

export function vixBadgeClass(level: MacroData["vix"]["level"]) {
  switch (level) {
    case "very-low":
    case "low":      return "bg-green-900/50 text-green-300 border-green-700";
    case "low-mid":
    case "mid":      return "bg-yellow-900/50 text-yellow-300 border-yellow-700";
    case "mid-high":
    case "high":     return "bg-red-900/50 text-red-300 border-red-700";
    default:         return "";
  }
}

// ── Stance helpers ─────────────────────────────────────────────────────────────

export function stanceBadgeClass(stance: FedMember["stance"] | BankResearch["stance"]) {
  if (stance === "hawkish" || stance === "bearish")
    return "bg-red-900/60 text-red-200";
  if (stance === "dovish" || stance === "bullish")
    return "bg-green-900/60 text-green-200";
  return "bg-yellow-900/60 text-yellow-200";
}

export function stanceLabel(stance: FedMember["stance"] | BankResearch["stance"]) {
  return stance.charAt(0).toUpperCase() + stance.slice(1);
}

// ── Indicator highlight helpers ────────────────────────────────────────────────

export function getIndicatorHighlight(
  label: string,
  dateStr: string | null,
  events: MacroEvent[],
  todayStr: string
): "recent" | "upcoming" | null {
  if (dateStr) {
    const d = new Date(dateStr + "T12:00:00").getTime();
    const t = new Date(todayStr + "T12:00:00").getTime();
    if (d <= t && t - d <= 7 * 24 * 60 * 60 * 1000) return "recent";
  }
  const nextWeekStr = new Date(new Date(todayStr + "T12:00:00").getTime() + 7 * 86400_000)
    .toISOString().slice(0, 10);
  const lbl = label.toLowerCase();
  const match = events.some((e) => {
    if (e.date < todayStr || e.date > nextWeekStr) return false;
    const ev = e.event.toLowerCase();
    return (
      (lbl.includes("cpi") && ev.includes("cpi") && !lbl.includes("core")) ||
      (lbl.includes("core cpi") && ev.includes("cpi")) ||
      (lbl.includes("pce") && (ev.includes("pce") || ev.includes("pcepilfe"))) ||
      (lbl.includes("ppi") && ev.includes("ppi")) ||
      (lbl.includes("unemployment") && ev.includes("unemployment")) ||
      (lbl.includes("payroll") && ev.includes("payroll")) ||
      (lbl.includes("jolts") && ev.includes("jolts")) ||
      (lbl.includes("gdp") && ev.includes("gdp")) ||
      (lbl.includes("retail") && ev.includes("retail")) ||
      (lbl.includes("sentiment") && ev.includes("sentiment"))
    );
  });
  return match ? "upcoming" : null;
}

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


// ── Sub-components ────────────────────────────────────────────────────────────

export function RegimeChips({ macroData }: { macroData: MacroData }) {
  const pct = macroData.series.corePce.yoy;
  const infl =
    pct == null
      ? { text: "Core PCE —", cls: "text-muted-foreground bg-secondary" }
      : pct > 2.5
      ? { text: `Core PCE ${fmt(pct, 1)}% ↑`, cls: "bg-red-900/50 text-red-300 border-red-700" }
      : pct < 2.0
      ? { text: `Core PCE ${fmt(pct, 1)}% ↓`, cls: "bg-green-900/50 text-green-300 border-green-700" }
      : { text: `Core PCE ${fmt(pct, 1)}% →`, cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" };

  const ch = macroData.series.unemployment.change;
  const labor =
    ch == null
      ? { text: "Labor —", cls: "text-muted-foreground bg-secondary" }
      : ch > 0.1
      ? { text: "UR Rising ↑", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" }
      : ch < -0.1
      ? { text: "UR Falling ↓", cls: "bg-green-900/50 text-green-300 border-green-700" }
      : { text: "Labor Stable", cls: "bg-green-900/50 text-green-300 border-green-700" };

  const spread = macroData.yieldSpread;
  const curve = spread == null
    ? { text: "Curve —", cls: "text-muted-foreground bg-secondary" }
    : spread < 0
    ? { text: `Inverted ${(spread).toFixed(0)}bps`, cls: "bg-red-900/50 text-red-300 border-red-700" }
    : { text: `Normal +${(spread).toFixed(0)}bps`, cls: "bg-green-900/50 text-green-300 border-green-700" };

  return (
    <div className="flex flex-wrap gap-2">
      {macroData.vix && (
        <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", vixBadgeClass(macroData.vix.level))}>
          VIX {fmt(macroData.vix.value, 1)} · {VIX_LEVEL_LABELS[macroData.vix.level]}
        </span>
      )}
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", infl.cls)}>{infl.text}</span>
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", labor.cls)}>{labor.text}</span>
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", curve.cls)}>{curve.text}</span>
      <span className="text-xs px-3 py-1 rounded-full border font-medium bg-yellow-900/50 text-yellow-300 border-yellow-700">
        Fed On Hold
      </span>
    </div>
  );
}

// ── Quick stats ─────────────────────────────────────────────────────────────────

export function StatCell({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="border border-border rounded-md p-3 flex-1 min-w-[90px]">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
      <p className="text-lg font-semibold leading-tight">{value}</p>
      {sub && <p className={cn("text-[11px] mt-0.5", subColor)}>{sub}</p>}
    </div>
  );
}

export function QuickStats({ macroData }: { macroData: MacroData }) {
  const debtT = macroData.usDebt != null
    ? `$${(macroData.usDebt / 1_000_000).toFixed(1)}T`
    : "—";

  return (
    <div className="flex flex-wrap gap-2">
      <StatCell
        label="VIX"
        value={fmt(macroData.vix.value, 1)}
        sub={macroData.vix.change != null ? `${macroData.vix.change > 0 ? "+" : ""}${fmt(macroData.vix.change, 2)}` : undefined}
        subColor={changeColor(macroData.vix.change ?? null)}
      />
      <StatCell
        label="SKEW"
        value={fmt(macroData.skew.value, 1)}
        sub={macroData.skew.change != null ? `${macroData.skew.change > 0 ? "+" : ""}${fmt(macroData.skew.change, 2)}` : undefined}
        subColor={changeColor(macroData.skew.change ?? null)}
      />
      <StatCell
        label="VXN (NDX)"
        value={fmt(macroData.vxn.value, 1)}
        sub={macroData.vxn.change != null ? `${macroData.vxn.change > 0 ? "+" : ""}${fmt(macroData.vxn.change, 2)}` : undefined}
        subColor={changeColor(macroData.vxn.change ?? null)}
      />
      <StatCell
        label="10Y Yield"
        value={`${fmt(macroData.yield10y.value, 3)}%`}
        sub={macroData.yield10y.change != null ? `${macroData.yield10y.change > 0 ? "+" : ""}${fmt(macroData.yield10y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield10y.change ?? null)}
      />
      <StatCell
        label="2Y Yield"
        value={`${fmt(macroData.yield2y.value, 3)}%`}
        sub={macroData.yield2y.change != null ? `${macroData.yield2y.change > 0 ? "+" : ""}${fmt(macroData.yield2y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield2y.change ?? null)}
      />
      <StatCell
        label="2s10s Spread"
        value={macroData.yieldSpread != null ? `${macroData.yieldSpread.toFixed(0)} bps` : "—"}
        sub={macroData.yieldSpread != null ? (macroData.yieldSpread < 0 ? "⚠ Inverted" : "Normal") : undefined}
        subColor={macroData.yieldSpread != null && macroData.yieldSpread < 0 ? "text-red-400" : "text-green-400"}
      />
      <StatCell label="Fed Funds" value={fmtPct(macroData.series.fedFundsRate.value)} />
      <StatCell label="US Debt" value={debtT} />
    </div>
  );
}

// ── Liquidity Plumbing Flow Diagram ─────────────────────────────────────────────
// Honest flow visual: WALCL/TGA/RRP -> Net Liquidity is real arithmetic
// (WALCL - TGA - RRP), so a connected strip is accurate here — unlike sector
// attribution, where no public data traces actual dollars.

function deltaFor(history: ChartPoint[], weeksBack: number): number | null {
  if (history.length === 0) return null;
  const latest = history[history.length - 1];
  const targetIdx = history.length - 1 - weeksBack;
  if (targetIdx < 0) return null;
  return latest.value - history[targetIdx].value;
}

function PlumbingNode({ label, valueB, deltaW, deltaM, sign }: {
  label: string; valueB: number | null; deltaW: number | null; deltaM: number | null; sign?: "-" | "=" ;
}) {
  return (
    <div className="flex items-center gap-2">
      {sign && <span className="text-lg text-muted-foreground font-semibold">{sign}</span>}
      <div className="border border-border rounded-md p-3 min-w-[130px]">
        <p className="text-xs text-slate-300 uppercase tracking-wide mb-1">{label}</p>
        <p className="text-lg font-semibold leading-tight">
          {valueB != null ? `$${valueB.toFixed(0)}B` : "—"}
        </p>
        <p className="text-xs mt-0.5 space-x-2">
          <span className={changeColor(deltaW)}>1w {deltaW != null ? `${deltaW > 0 ? "+" : ""}${deltaW.toFixed(0)}B` : "—"}</span>
          <span className={changeColor(deltaM)}>1m {deltaM != null ? `${deltaM > 0 ? "+" : ""}${deltaM.toFixed(0)}B` : "—"}</span>
        </p>
      </div>
    </div>
  );
}

const LIQUIDITY_LEVEL_STYLE: Record<LiquiditySignal["level"], { dot: string; text: string; badge: string }> = {
  supportive: { dot: "bg-green-400",  text: "text-green-400",  badge: "border-green-500/40 bg-green-500/10 text-green-400" },
  neutral:    { dot: "bg-slate-400",  text: "text-slate-300",  badge: "border-slate-500/40 bg-slate-500/10 text-slate-300" },
  draining:   { dot: "bg-orange-400", text: "text-orange-400", badge: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
  stress:     { dot: "bg-red-400",    text: "text-red-400",    badge: "border-red-500/40 bg-red-500/10 text-red-400" },
  unknown:    { dot: "bg-slate-500",  text: "text-muted-foreground", badge: "border-border text-muted-foreground" },
};

const LIQUIDITY_LEVEL_LABEL: Record<LiquiditySignal["level"], string> = {
  supportive: "Supportive",
  neutral: "Neutral",
  draining: "Draining",
  stress: "Stress",
  unknown: "Unknown",
};

export function LiquidityImplicationsCard({
  data, loading,
}: {
  data: LiquidityImplications | undefined;
  loading?: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const overallStyle = LIQUIDITY_LEVEL_STYLE[data.overall.level];

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Liquidity Regime Read</h2>
        </div>
        <Badge variant="outline" className={cn("text-xs", overallStyle.badge)}>
          {LIQUIDITY_LEVEL_LABEL[data.overall.level]}
        </Badge>
      </div>
      <p className={cn("text-sm font-medium mb-3", overallStyle.text)}>{data.overall.summary}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {data.signals.map(sg => {
          const style = LIQUIDITY_LEVEL_STYLE[sg.level];
          return (
            <div key={sg.label} className="rounded-md bg-muted/30 p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                  <span className={cn("w-1.5 h-1.5 rounded-full inline-block", style.dot)} />
                  {sg.label}
                </span>
                <span className={cn("text-xs font-mono font-semibold", style.text)}>{sg.readout}</span>
              </div>
              <p className="text-xs text-slate-400 leading-snug">{sg.implication}</p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-3">
        Directional heuristic, not a precise model or trading signal.
      </p>
    </div>
  );
}

export function LiquidityFlowDiagram({
  fedAssetsHistory, tgaHistory, rrpHistory, netLiquidityHistory, loading,
}: {
  fedAssetsHistory: ChartPoint[];
  tgaHistory: ChartPoint[];
  rrpHistory: ChartPoint[];
  netLiquidityHistory: ChartPoint[];
  loading?: boolean;
}) {
  const latestB = (history: ChartPoint[], divisor: number) =>
    history.length > 0 ? history[history.length - 1].value / divisor : null;

  if (loading) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Fed Plumbing — Net Liquidity</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <PlumbingNode
          label="Fed Assets (WALCL)"
          valueB={latestB(fedAssetsHistory, 1000)}
          deltaW={deltaFor(fedAssetsHistory, 1) != null ? deltaFor(fedAssetsHistory, 1)! / 1000 : null}
          deltaM={deltaFor(fedAssetsHistory, 4) != null ? deltaFor(fedAssetsHistory, 4)! / 1000 : null}
        />
        <PlumbingNode
          label="Treasury Gen. Acct"
          valueB={latestB(tgaHistory, 1000)}
          deltaW={deltaFor(tgaHistory, 1) != null ? deltaFor(tgaHistory, 1)! / 1000 : null}
          deltaM={deltaFor(tgaHistory, 4) != null ? deltaFor(tgaHistory, 4)! / 1000 : null}
          sign="-"
        />
        <PlumbingNode
          label="Overnight RRP"
          valueB={latestB(rrpHistory, 1)}
          deltaW={deltaFor(rrpHistory, 7)}
          deltaM={deltaFor(rrpHistory, 30)}
          sign="-"
        />
        <PlumbingNode
          label="Net Liquidity"
          valueB={latestB(netLiquidityHistory, 1)}
          deltaW={deltaFor(netLiquidityHistory, 1)}
          deltaM={deltaFor(netLiquidityHistory, 4)}
          sign="="
        />
      </div>
      <p className="text-xs text-slate-500">
        Net Liquidity = Fed Assets − TGA − RRP. Rising ≈ more dollars available to markets.
      </p>
    </div>
  );
}

// ── Sector Rotation Bubbles (relative strength vs SPY, proxy only) ─────────────

const QUADRANT_COLOR: Record<string, string> = {
  leading:   "#22c55e",
  weakening: "#f59e0b",
  lagging:   "#ef4444",
  improving: "#38bdf8",
};

const QUADRANT_LABEL: Record<string, string> = {
  leading:   "Leading",
  weakening: "Weakening",
  lagging:   "Lagging",
  improving: "Improving",
};

const QUADRANT_IMPLICATION: Record<string, string> = {
  leading:   "Outperforming & rallying — sector leadership",
  weakening: "Outperforming, losing steam — may be topping / overbought",
  lagging:   "Underperforming & selling off — may be oversold",
  improving: "Underperforming, turning up — may be bottoming",
};

// Corner placement matches the RRG convention: x = rs1m (right = outperforming),
// y = momentum (up = accelerating). Assumes symmetric axis domains around 0.
const QUADRANT_CORNER: Record<string, string> = {
  leading:   "top-2 right-2 text-right",
  weakening: "bottom-8 right-2 text-right",
  lagging:   "bottom-8 left-2 text-left",
  improving: "top-2 left-2 text-left",
};

function SectorMoversStrip({ data }: { data: SectorRotationPoint[] }) {
  const sorted = [...data]
    .filter((d) => d.rs1d != null)
    .sort((a, b) => b.rs1d! - a.rs1d!);
  if (sorted.length === 0) return null;
  const maxAbs = Math.max(1, ...sorted.map((d) => Math.abs(d.rs1d!)));

  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-slate-300 mb-1.5">Today's movers vs SPY</p>
      <div className="flex flex-wrap gap-1.5">
        {sorted.map((d) => {
          const up = d.rs1d! >= 0;
          const widthPct = Math.max(10, (Math.abs(d.rs1d!) / maxAbs) * 100);
          return (
            <div
              key={d.ticker}
              className="relative overflow-hidden rounded-md px-2.5 py-1.5 min-w-[92px] bg-muted/30"
              title={`${d.label}: ${up ? "+" : ""}${d.rs1d!.toFixed(1)}% vs SPY today`}
            >
              <div
                className="absolute inset-y-0 left-0 opacity-25"
                style={{ width: `${widthPct}%`, background: up ? "#22c55e" : "#ef4444" }}
              />
              <div className="relative flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{d.label}</span>
                <span className={cn("text-xs font-mono font-semibold", up ? "text-green-400" : "text-red-400")}>
                  {up ? "+" : ""}{d.rs1d!.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SectorRotationBubbles({
  data, loading,
}: {
  data: SectorRotationPoint[] | undefined;
  loading?: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-[320px]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const points = data
    .filter((d) => d.rs1m != null && d.momentum != null)
    .map((d) => ({ ...d, z: Math.abs(d.rs1m!) + 0.5 }));
  const leaders = data.filter((d) => d.quadrant === "leading").map((d) => d.label);

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Sector Rotation vs SPY</h2>
        </div>
        <div className="flex items-center gap-2.5 text-xs text-slate-300">
          {(["leading", "improving", "lagging", "weakening"] as const).map((q) => (
            <span key={q} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: QUADRANT_COLOR[q] }} />
              {QUADRANT_LABEL[q]}
            </span>
          ))}
        </div>
      </div>

      <SectorMoversStrip data={data} />

      <div className="relative">
        {(["leading", "weakening", "lagging", "improving"] as const).map((q) => (
          <div
            key={q}
            className={cn("absolute z-10 pointer-events-none text-[10px] font-semibold uppercase tracking-wide", QUADRANT_CORNER[q])}
            style={{ color: QUADRANT_COLOR[q], opacity: 0.6 }}
          >
            {QUADRANT_LABEL[q]}
          </div>
        ))}
        <ResponsiveContainer width="100%" height={340}>
          <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              type="number" dataKey="rs1m" name="1m RS vs SPY"
              tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}%`}
              label={{ value: "1m return vs SPY →", position: "insideBottom", offset: -4, fontSize: 11, fill: "#aaa" }}
            />
            <YAxis
              type="number" dataKey="momentum" name="Momentum"
              tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}`}
              label={{ value: "Accelerating ↑", angle: -90, position: "insideLeft", fontSize: 11, fill: "#aaa" }}
            />
            <ZAxis dataKey="z" range={[80, 500]} />
            <ReferenceLine x={0} stroke="#444" />
            <ReferenceLine y={0} stroke="#444" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as SectorRotationPoint;
                return (
                  <div className="bg-popover border border-border rounded-md px-2.5 py-2 text-xs max-w-[230px]">
                    <p className="font-semibold text-sm">{p.label}</p>
                    <p style={{ color: QUADRANT_COLOR[p.quadrant ?? ""] }} className="font-medium">
                      {QUADRANT_LABEL[p.quadrant ?? ""]} — {QUADRANT_IMPLICATION[p.quadrant ?? ""]}
                    </p>
                    <p className="mt-1.5">Today: {p.rs1d != null ? `${p.rs1d > 0 ? "+" : ""}${p.rs1d}%` : "—"} · 1m: {p.rs1m! > 0 ? "+" : ""}{p.rs1m}% · 3m: {p.rs3m! > 0 ? "+" : ""}{p.rs3m}%</p>
                    {p.topMovers?.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-border/50">
                        <p className="text-slate-400 mb-0.5">Bellwethers (1m vs SPY):</p>
                        {p.topMovers.map((m) => (
                          <span key={m.ticker} className="inline-block mr-2">
                            {m.ticker} {m.rs1m != null ? `${m.rs1m > 0 ? "+" : ""}${m.rs1m}%` : "—"}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            <Scatter data={points} fill="#8884d8">
              <LabelList
                dataKey="label"
                position="top"
                fontSize={11}
                fill="#ddd"
                offset={8}
              />
              {points.map((p) => (
                <Cell key={p.ticker} fill={QUADRANT_COLOR[p.quadrant ?? ""] ?? "#888"} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {leaders.length > 0 && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/50 text-xs">
          <span className="text-slate-400">Leading:</span>
          <span className="font-medium text-slate-200">{leaders.join(", ")}</span>
        </div>
      )}
      <p className="text-xs text-slate-500 mt-2">
        Dot size = size of 1m move vs SPY. Price-based proxy, not measured fund flow.
      </p>
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
}: {
  data: FedFundsCurvePoint[];
  loading: boolean;
  period: CurvePeriod;
  onPeriodChange: (p: CurvePeriod) => void;
}) {
  const hasData = data.some((p) => p.impliedRate != null);
  const isProxy = data.some((p) => p.isTbillProxy);
  const periodLabel =
    period === "1wk" ? "1 Wk Ago" : period === "1mo" ? "1 Mo Ago" : period === "3mo" ? "3 Mo Ago" : "";

  return (
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-400" />
            Fed Funds Curve
          </h3>
          {isProxy && (
            <p className="text-[9px] text-muted-foreground/60 italic">T-bill proxy (ZQ futures unavailable)</p>
          )}
        </div>
        <CurvePeriodButtons period={period} onChange={onPeriodChange} />
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <div className="h-[160px] flex flex-col items-center justify-center text-xs text-muted-foreground gap-1">
          <span>Fed Funds futures data unavailable</span>
          <span className="text-[10px]">ZQ futures not found on this feed</span>
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={160}>
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
          {period !== "current" && (
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

// ── Rate History Chart ──────────────────────────────────────────────────────────

type HistoryPeriod = "1m" | "3m" | "6m" | "1y";

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
}: {
  title: string;
  data: ChartPoint[];
  color: string;
  loading: boolean;
  yFormatter?: (v: number) => string;
  tooltipFormatter?: (v: number) => [string];
  referenceLines?: { y: number; label: string; color: string }[];
}) {
  const [period, setPeriod] = useState<HistoryPeriod>("3m");
  const filtered = filterByPeriod(data, period);

  return (
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex rounded-md border border-border overflow-hidden text-[10px]">
          {(["1m", "3m", "6m", "1y"] as HistoryPeriod[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={cn("px-2 py-0.5 transition-colors", period === p ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
              {p === "1y" ? "1Y" : p === "6m" ? "6M" : p === "3m" ? "3M" : "1M"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length > 0 ? (
        <ResponsiveContainer width="100%" height={160}>
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
              tickFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
              }
              interval={Math.floor(data.length / 6)}
            />
            <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={yFormatter} />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: unknown) => tooltipFormatter(v as number)}
              labelFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              }
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
        <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
          No data
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
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex rounded-md border border-border overflow-hidden text-[10px]">
          {(["1m", "3m", "6m", "1y"] as HistoryPeriod[]).map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={cn("px-2 py-0.5 transition-colors", period === p ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
              {p === "1y" ? "1Y" : p === "6m" ? "6M" : p === "3m" ? "3M" : "1M"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : merged.length > 0 ? (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={merged} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#cbd5e1" }}
              tickFormatter={(d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
              interval={Math.floor(merged.length / 6)} />
            <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} domain={["auto", "auto"]} tickFormatter={yFormatter} />
            <Tooltip contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: unknown, name: unknown) => tooltipFormatter(v as number, name as string)}
              labelFormatter={(d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} />
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
        <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      )}
    </div>
  );
}

// ── Macro data table row ─────────────────────────────────────────────────────────

export function MacroRow({
  indicatorKey,
  label,
  value,
  mom,
  momRaw,
  yoy,
  date,
  inflSign,
  isSelected,
  highlight,
  onSelect,
}: {
  indicatorKey: string;
  label: string;
  value: string;
  mom?: number | null;
  momRaw?: string | null;
  yoy?: number | null;
  date?: string | null;
  inflSign?: boolean;
  isSelected?: boolean;
  highlight?: "recent" | "upcoming" | null;
  onSelect?: () => void;
}) {
  const momDisplay =
    momRaw != null
      ? momRaw
      : mom != null
      ? `${mom > 0 ? "+" : ""}${mom.toFixed(2)}`
      : "—";
  const momColor = inflSign ? inflColor(mom ?? null) : changeColor(mom ?? null);
  const yoyDisplay = yoy != null ? `${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%` : "—";
  const yoyColor = inflSign ? inflColor(yoy ?? null) : changeColor(yoy ?? null);

  const rowBg = isSelected
    ? "bg-primary/10"
    : highlight === "recent"
    ? "bg-blue-900/10"
    : highlight === "upcoming"
    ? "bg-yellow-900/10"
    : "";

  const labelColor =
    highlight === "recent"
      ? "text-blue-300"
      : highlight === "upcoming"
      ? "text-yellow-300"
      : "text-muted-foreground";

  return (
    <tr
      className={cn("hover:bg-secondary/30 cursor-pointer transition-colors", rowBg)}
      onClick={onSelect}
    >
      <td className={cn("px-4 py-2", labelColor)}>
        <span className="flex items-center gap-1.5">
          {label}
          {highlight === "recent" && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block shrink-0" title="Recently released" />
          )}
          {highlight === "upcoming" && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block shrink-0" title="Upcoming this week" />
          )}
        </span>
      </td>
      <td className="px-3 py-2 text-right font-medium">{value}</td>
      <td className={cn("px-3 py-2 text-right", momColor)}>{momDisplay}</td>
      <td className={cn("px-3 py-2 text-right", yoyColor)}>{yoyDisplay}</td>
      <td className="px-4 py-2 text-right text-muted-foreground/70">
        {date ? fmtMonthYear(date) : "—"}
      </td>
    </tr>
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          {data ? `${data.label}${data.isYoY ? " (YoY %)" : ` (${data.unit})`}` : "Select a row above to view history"}
        </p>
        {data && (
          <span className="text-[10px] text-muted-foreground/60">~10 year history</span>
        )}
      </div>
      {loading ? (
        <div className="h-[160px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.data.length === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
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
              tickFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short" })
              }
              interval={Math.floor(data.data.length / 8)}
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
              labelFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric" })
              }
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
}: {
  sepData: SepData;
  actuals: SepActuals | undefined;
  metric: SepMetric;
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

  if (!actuals) {
    return (
      <div className="h-[180px] flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block" /> Actual</span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-orange-400 inline-block" style={{ width: 8, height: 8 }} />
          SEP Projection (median)
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={combined} margin={{ top: 4, right: 16, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "#cbd5e1" }}
            tickFormatter={(d: string) =>
              new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short" })
            }
            interval={Math.floor(combined.length / 8)}
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
            labelFormatter={(d: string) =>
              new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric" })
            }
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

// ── Fed stance group ─────────────────────────────────────────────────────────────

export function FedStanceGroup({
  title,
  hawkish,
  neutral,
  dovish,
}: {
  title: string;
  hawkish: FedMember[];
  neutral: FedMember[];
  dovish: FedMember[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground font-medium">{title}</p>

      {hawkish.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-red-400 uppercase tracking-wider font-semibold">Hawkish ({hawkish.length})</p>
          {hawkish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {neutral.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-yellow-400 uppercase tracking-wider font-semibold">Neutral ({neutral.length})</p>
          {neutral.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {dovish.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-green-400 uppercase tracking-wider font-semibold">Dovish ({dovish.length})</p>
          {dovish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
    </div>
  );
}

export function InitialsAvatar({ name, stance }: { name: string; stance: FedMember["stance"] }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const cls =
    stance === "hawkish"
      ? "bg-red-900/70 text-red-200"
      : stance === "dovish"
      ? "bg-green-900/70 text-green-200"
      : "bg-yellow-900/70 text-yellow-200";
  return (
    <div className={cn("w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0", cls)}>
      {initials}
    </div>
  );
}

export function FedMemberCard({ member }: { member: FedMember }) {
  const [photoFailed, setPhotoFailed] = useState(false);

  return (
    <div className="border border-border rounded-md p-2.5 flex items-start gap-2.5">
      {member.photoUrl && !photoFailed ? (
        <img
          src={member.photoUrl}
          alt={member.name}
          className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary"
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <InitialsAvatar name={member.name} stance={member.stance} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold leading-tight">{member.name}</p>
          {member.recentChange && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700">
              Updated
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">{member.title}</p>
        {member.notes && (
          <p className="text-[11px] text-muted-foreground/80 italic mt-0.5 line-clamp-2">{member.notes}</p>
        )}
        {member.recentChange && (
          <p className="text-[10px] text-blue-300/80 mt-0.5">↳ {member.recentChange}</p>
        )}
      </div>
    </div>
  );
}

// ── Bank Research Card ──────────────────────────────────────────────────────────

export function BankCard({ bank }: { bank: BankResearch }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { data: news, isLoading: newsLoading } = useQuery<NewsArticle[]>({
    queryKey: ["bank-news", bank.name],
    queryFn: () =>
      fetch(`/api/macro/bank-news?bank=${encodeURIComponent(bank.name)}`).then((r) => r.json()),
    enabled: isExpanded,
    staleTime: 15 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  const bg =
    bank.stance === "bullish"
      ? "border-green-900/40 bg-green-900/5"
      : bank.stance === "bearish"
      ? "border-red-900/40 bg-red-900/5"
      : "border-border";

  return (
    <div className={cn("border rounded-lg overflow-hidden", bg)}>
      <div
        className="p-3 space-y-2 cursor-pointer hover:bg-secondary/10 transition-colors"
        onClick={() => setIsExpanded((e) => !e)}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div
              className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold mb-1",
                stanceBadgeClass(bank.stance)
              )}
            >
              {bank.shortName.slice(0, 4)}
            </div>
            <p className="text-xs font-semibold leading-tight">{bank.name}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize",
                stanceBadgeClass(bank.stance)
              )}
            >
              {stanceLabel(bank.stance)}
            </span>
            {isExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground font-medium">{bank.rateView}</p>
        <p className="text-[11px] text-muted-foreground/80 leading-relaxed line-clamp-3">{bank.summary}</p>
        <p className="text-[9px] text-muted-foreground/50">
          {new Date(bank.lastUpdated + "T12:00:00").toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          })}
        </p>
      </div>

      {/* News articles panel */}
      {isExpanded && (
        <div className="border-t border-border px-3 py-2 space-y-2 bg-secondary/10">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
            <Newspaper className="h-3 w-3" />
            Recent News
          </div>
          {newsLoading ? (
            <div className="flex items-center gap-1.5 py-2">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">Fetching news…</span>
            </div>
          ) : !news || news.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic py-1">No recent articles found.</p>
          ) : (
            <div className="space-y-1.5">
              {news.map((article, i) => (
                <a
                  key={i}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 group"
                >
                  <ExternalLink className="h-3 w-3 text-muted-foreground/50 shrink-0 mt-0.5 group-hover:text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] leading-snug group-hover:text-primary transition-colors line-clamp-2">
                      {article.title}
                    </p>
                    <p className="text-[9px] text-muted-foreground/50">
                      {article.source}
                      {article.publishedAt ? ` · ${new Date(article.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                    </p>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Event row ───────────────────────────────────────────────────────────────────

export function importanceBadgeClass(imp: MacroEvent["importance"]) {
  switch (imp) {
    case "high":   return "bg-amber-900/60 text-amber-200";
    case "medium": return "bg-blue-900/60 text-blue-200";
    case "low":    return "bg-secondary text-muted-foreground";
  }
}

export function EventRow({ event, todayStr }: { event: MacroEvent; todayStr: string }) {
  const isToday = event.date === todayStr;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md border border-border text-sm",
        isToday && "border-l-2 border-l-primary bg-primary/5"
      )}
    >
      <span className="text-[11px] text-muted-foreground font-medium w-12 shrink-0">
        {fmtDate(event.date)}
      </span>
      <span className="flex-1 text-xs">{event.event}</span>
      <span
        className={cn(
          "text-[10px] px-2 py-0.5 rounded-full font-medium capitalize",
          importanceBadgeClass(event.importance)
        )}
      >
        {event.importance}
      </span>
    </div>
  );
}

// ── COT Section (compact, embedded in Macro tabs) ──────────────────────────────

export function fmtCot(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function CotSection({
  title, summaries, history, selectedInstrument, onSelectInstrument,
}: {
  title: string;
  summaries: COTSummary[];
  history: COTRecord[] | undefined;
  selectedInstrument: string;
  onSelectInstrument: (id: string) => void;
}) {
  const [cotWeeks, setCotWeeks] = useState<12 | 26 | 52>(26);
  const selected = summaries.find((s) => s.instrument === selectedInstrument) ?? summaries[0];
  const historyForSelected = history?.[0]?.instrument === selectedInstrument ? history : undefined;

  const extremes = [...summaries].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/20">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[10px] text-muted-foreground/60 ml-auto">CFTC · weekly</span>
      </div>
      <div className="p-4 space-y-4">

        {/* Instrument selector cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {summaries.map((s) => {
            const net = s.latest.levMoneyNet;
            const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
            const isSelected = s.instrument === selectedInstrument;
            const absZ = Math.abs(s.zScore);
            return (
              <button
                key={s.instrument}
                onClick={() => onSelectInstrument(s.instrument)}
                className={cn(
                  "text-left rounded-lg border p-2.5 transition-all",
                  isSelected ? "border-primary/60 bg-primary/10" : "border-border hover:border-border/80 hover:bg-card/80"
                )}
              >
                <div className="text-xs font-semibold truncate mb-1">{s.displayName}</div>
                <div className={cn("text-sm font-bold", net >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {net >= 0 ? "+" : ""}{fmtCot(net)}
                </div>
                <div className={cn("text-[10px]", chg > 0 ? "text-emerald-400" : chg < 0 ? "text-red-400" : "text-muted-foreground")}>
                  {chg >= 0 ? "+" : ""}{fmtCot(chg)} WoW
                </div>
                {absZ >= 1 && (
                  <span className={cn(
                    "text-[9px] px-1 py-0.5 rounded border font-semibold mt-1 inline-block",
                    absZ > 1.5
                      ? s.zScore > 0 ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" : "bg-red-500/20 text-red-300 border-red-500/30"
                      : "bg-yellow-500/15 text-yellow-300 border-yellow-500/20"
                  )}>
                    {s.zScore > 0 ? "Extreme Long" : "Extreme Short"}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Selected instrument detail */}
        {selected && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* History chart */}
            <div className="lg:col-span-2 border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold">{selected.displayName} — Net Positioning</p>
                  <p className="text-[10px] text-muted-foreground">as of {selected.latest.date}</p>
                </div>
                <div className="flex gap-1">
                  {([12, 26, 52] as const).map((w) => (
                    <button key={w} onClick={() => setCotWeeks(w)}
                      className={cn("text-[10px] px-2 py-1 rounded font-medium transition-colors",
                        cotWeeks === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                      {w}W
                    </button>
                  ))}
                </div>
              </div>
              {historyForSelected ? (
                <>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart
                      data={historyForSelected.slice(-cotWeeks).map((r) => ({
                        date: r.date.slice(5),
                        "Lev. Money": r.levMoneyNet,
                        "Asset Mgr":  r.assetMgrNet,
                        "Dealer":     r.dealerNet,
                      }))}
                      margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} axisLine={false} tickFormatter={fmtCot} width={48} />
                      <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
                        formatter={(v: number, name: string) => [fmtCot(v), name]} />
                      <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="Lev. Money" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="Asset Mgr"  stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="Dealer"     stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="4 2" isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] text-muted-foreground">
                    <div><span className="inline-block w-2 h-0.5 bg-amber-400 mr-1 align-middle" />Lev. Money = hedge funds</div>
                    <div><span className="inline-block w-2 h-0.5 bg-blue-400 mr-1 align-middle" />Asset Mgr = institutions</div>
                    <div><span className="inline-block w-2 h-0.5 bg-violet-400 mr-1 align-middle" />Dealer = market makers</div>
                  </div>
                </>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin mr-2" />Loading history…
                </div>
              )}
            </div>

            {/* Category breakdown + quick stats */}
            <div className="space-y-3">
              {/* Quick stats */}
              <div className="border border-border rounded-lg p-3 grid grid-cols-2 gap-3">
                {[
                  { label: "Open Interest", val: fmtCot(selected.latest.openInterest) },
                  { label: "HF Net",        val: `${selected.latest.levMoneyNet >= 0 ? "+" : ""}${fmtCot(selected.latest.levMoneyNet)}` },
                  { label: "HF WoW",        val: `${(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg) >= 0 ? "+" : ""}${fmtCot(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg)}` },
                  { label: "Z-Score",       val: `${selected.zScore >= 0 ? "+" : ""}${selected.zScore.toFixed(2)}σ` },
                ].map(({ label, val }) => (
                  <div key={label}>
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
                    <div className="text-xs font-semibold">{val}</div>
                  </div>
                ))}
              </div>

              {/* Position breakdown bar chart */}
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold mb-0.5">Position Breakdown</p>
                <p className="text-[10px] text-muted-foreground mb-2">Long vs short by category</p>
                <ResponsiveContainer width="100%" height={130}>
                  <BarChart
                    data={[
                      { name: "Lev. Money", Long: selected.latest.levMoneyLong, Short: -selected.latest.levMoneyShort },
                      { name: "Asset Mgr",  Long: selected.latest.assetMgrLong,  Short: -selected.latest.assetMgrShort },
                      { name: "Dealer",     Long: selected.latest.dealerLong,     Short: -selected.latest.dealerShort },
                    ]}
                    layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
                  >
                    <XAxis type="number" tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} tickFormatter={(v: number) => fmtCot(Math.abs(v))} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} axisLine={false} width={68} />
                    <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
                      formatter={(v: number) => fmtCot(Math.abs(v))} />
                    <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
                    <Bar dataKey="Long"  fill="#34d399" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                    <Bar dataKey="Short" fill="#f87171" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* Positioning extremes table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-secondary/10">
            <p className="text-xs font-semibold">Positioning Extremes</p>
            <p className="text-[10px] text-muted-foreground">Ranked by Z-score vs 52-week range (hedge fund positioning)</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
                <th className="text-left px-4 py-2">Instrument</th>
                <th className="text-right px-3 py-2">Net</th>
                <th className="text-right px-3 py-2">WoW Chg</th>
                <th className="text-right px-4 py-2">Z-Score</th>
              </tr>
            </thead>
            <tbody>
              {extremes.map((s) => {
                const net = s.latest.levMoneyNet;
                const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
                return (
                  <tr key={s.instrument} onClick={() => onSelectInstrument(s.instrument)}
                    className="border-b border-border/50 hover:bg-white/5 cursor-pointer transition-colors">
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-2">
                        {s.displayName}
                        {Math.abs(s.zScore) >= 1 && (
                          <span className={cn("text-[9px] px-1 py-0.5 rounded border font-semibold",
                            Math.abs(s.zScore) > 1.5
                              ? s.zScore > 0 ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" : "bg-red-500/20 text-red-300 border-red-500/30"
                              : "bg-yellow-500/15 text-yellow-300 border-yellow-500/20")}>
                            {s.zScore > 0 ? "Extreme Long" : "Extreme Short"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", net >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {net >= 0 ? "+" : ""}{fmtCot(net)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", chg > 0 ? "text-emerald-400" : chg < 0 ? "text-red-400" : "text-muted-foreground")}>
                      {chg >= 0 ? "+" : ""}{fmtCot(chg)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={cn("font-mono font-semibold",
                        Math.abs(s.zScore) > 1.5 ? s.zScore > 0 ? "text-emerald-400" : "text-red-400"
                        : Math.abs(s.zScore) > 1 ? "text-yellow-400" : "text-muted-foreground")}>
                        {s.zScore >= 0 ? "+" : ""}{s.zScore.toFixed(2)}σ
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}

// ── TradingView Widgets ────────────────────────────────────────────────────────

export function TradingViewMarketOverview() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      colorTheme: "dark", dateRange: "12M", showChart: true,
      locale: "en", width: "100%", height: 660, largeChartUrl: "",
      isTransparent: false, showSymbolLogo: true, showFloatingTooltip: false,
      plotLineColorGrowing: "rgba(41, 98, 255, 1)",
      plotLineColorFalling: "rgba(41, 98, 255, 1)",
      gridLineColor: "rgba(240, 243, 250, 0)",
      scaleFontColor: "rgba(106, 109, 120, 1)",
      belowLineFillColorGrowing: "rgba(41, 98, 255, 0.12)",
      belowLineFillColorFalling: "rgba(41, 98, 255, 0.12)",
      belowLineFillColorGrowingBottom: "rgba(41, 98, 255, 0)",
      belowLineFillColorFallingBottom: "rgba(41, 98, 255, 0)",
      symbolActiveColor: "rgba(41, 98, 255, 0.12)",
      tabs: [
        {
          title: "Indices", symbols: [
            { s: "FOREXCOM:SPXUSD", d: "S&P 500" },
            { s: "FOREXCOM:NSXUSD", d: "Nasdaq 100" },
            { s: "FOREXCOM:DJI",    d: "Dow Jones" },
            { s: "INDEX:RTY",       d: "Russell 2000" },
            { s: "INDEX:VIX",       d: "VIX" },
          ], originalTitle: "Indices",
        },
        {
          title: "Bonds", symbols: [
            { s: "CBOT:ZB1!", d: "T-Bond Futures" },
            { s: "CBOT:ZN1!", d: "10Y Note Futures" },
            { s: "CBOT:ZF1!", d: "5Y Note Futures" },
            { s: "CBOT:ZT1!", d: "2Y Note Futures" },
          ], originalTitle: "Bonds",
        },
        {
          title: "Commodities", symbols: [
            { s: "CME_MINI:NQ1!", d: "Crude Oil" },
            { s: "NYMEX:CL1!",   d: "WTI Crude" },
            { s: "NYMEX:NG1!",   d: "Natural Gas" },
            { s: "COMEX:GC1!",   d: "Gold" },
            { s: "COMEX:SI1!",   d: "Silver" },
          ], originalTitle: "Commodities",
        },
        {
          title: "Forex", symbols: [
            { s: "FX:EURUSD", d: "EUR/USD" },
            { s: "FX:GBPUSD", d: "GBP/USD" },
            { s: "FX:USDJPY", d: "USD/JPY" },
            { s: "FX:USDCNY", d: "USD/CNY" },
            { s: "FX:USDCHF", d: "USD/CHF" },
          ], originalTitle: "Forex",
        },
      ],
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 660, width: "100%" }}
    />
  );
}

export function TradingViewForexCrossRates() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-forex-cross-rates.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      width: "100%", height: 400,
      currencies: ["EUR", "USD", "JPY", "GBP", "CHF", "AUD", "CAD", "CNY"],
      isTransparent: false, colorTheme: "dark", locale: "en",
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 400, width: "100%" }}
    />
  );
}

export function TradingViewHeatmap() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      exchanges: [], dataSource: "SPX500", grouping: "sector",
      blockSize: "market_cap_basic", blockColor: "change",
      locale: "en", colorTheme: "dark",
      hasTopBar: true, isDataSetEnabled: true, isZoomEnabled: true,
      hasSymbolTooltip: true, isMonoSize: false,
      width: "100%", height: 720,
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 720, width: "100%" }}
    />
  );
}

export function TradingViewEconomicCalendar() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      colorTheme: "dark", isTransparent: false,
      width: "100%", height: "560", locale: "en",
      importanceFilter: "0,1", countryFilter: "us",
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 560 }}
    />
  );
}
