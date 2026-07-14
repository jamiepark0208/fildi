import { useState } from "react";
import {
  ResponsiveContainer, ScatterChart, XAxis, YAxis, CartesianGrid, ZAxis,
  ReferenceLine, Tooltip, Scatter, LabelList, Cell,
} from "recharts";
import { Loader2, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SectorRotationPoint } from "./macro-page-types";

// Discrete red→green intensity bands — same visual language as TradingView/Finviz
// heatmaps (a handful of solid, saturated steps reads far better at a glance than
// a continuous gradient, which washes out to grey for realistic sub-1% moves).
const GREEN_STEPS = ["#0f3d22", "#146632", "#189042", "#1fb854", "#2ecc66"]; // dim → bright
const RED_STEPS   = ["#4a1414", "#7a1c1c", "#a32424", "#cc2e2e", "#f0413f"]; // dim → bright
const FLAT_COLOR = "#3f3f46"; // zinc-700 — effectively unchanged
const NULL_COLOR = "#27272a"; // zinc-800 — no data

// scaleMax = the |%| at which color hits full intensity — wider bands for longer
// timeframes so a +4% week doesn't look identical to a +4% day.
function heatColor(pct: number | null, scaleMax: number): string {
  if (pct == null) return NULL_COLOR;
  if (Math.abs(pct) < 0.03) return FLAT_COLOR;
  const steps = pct > 0 ? GREEN_STEPS : RED_STEPS;
  const t = Math.min(1, Math.abs(pct) / scaleMax);
  const idx = Math.min(steps.length - 1, Math.floor(t * steps.length));
  return steps[idx];
}

function fmtPct(pct: number | null): string {
  return pct != null ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "—";
}

const HEATMAP_TIMEFRAMES = [
  { id: "1d", label: "1D", key: "ret1d" as const, scaleMax: 2.5 },
  { id: "1w", label: "1W", key: "ret1w" as const, scaleMax: 5 },
  { id: "1m", label: "1M", key: "ret1m" as const, scaleMax: 10 },
];

export function SectorHeatmapGrid({
  data, loading,
}: {
  data: SectorRotationPoint[] | undefined;
  loading?: boolean;
}) {
  const [timeframe, setTimeframe] = useState<typeof HEATMAP_TIMEFRAMES[number]>(HEATMAP_TIMEFRAMES[0]);

  if (loading || !data) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-[280px]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Tile "footprint" scales with |% move| for this timeframe — a true treemap-style
  // weight (bigger box = bigger flow), not a uniform grid. flex-grow does the sizing;
  // flex-wrap packs rows so bigger movers naturally claim more space per row.
  const weightOf = (s: SectorRotationPoint) => Math.max(0.35, Math.abs(s[timeframe.key] ?? 0));

  return (
    <div className="border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sector Performance</h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: RED_STEPS[4] }} />
            down
            <span className="w-2.5 h-2.5 rounded-sm ml-2" style={{ background: FLAT_COLOR }} />
            flat
            <span className="w-2.5 h-2.5 rounded-sm ml-2" style={{ background: GREEN_STEPS[4] }} />
            up
          </div>
          <div className="flex gap-1">
            {HEATMAP_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                  timeframe.id === tf.id ? "bg-primary text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:bg-muted/70",
                )}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {data.map((s) => {
          const val = s[timeframe.key];
          return (
            <div
              key={s.ticker}
              className="rounded-md p-2.5 flex flex-col justify-between min-h-[100px]"
              style={{ background: heatColor(val, timeframe.scaleMax), flex: `${weightOf(s)} 1 170px` }}
              title={`${s.label} (${s.ticker}) ${timeframe.label}: ${fmtPct(val)}`}
            >
              <div>
                <p className="text-xs font-semibold text-white leading-tight drop-shadow-sm">{s.label}</p>
                <p className="text-[10px] text-white/70 font-mono">{s.ticker}</p>
              </div>
              <p className="text-xl font-bold text-white tabular-nums drop-shadow-sm">
                {fmtPct(val)}
              </p>
              {s.topMovers?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {s.topMovers.map((m) => {
                    const mv = m[timeframe.key];
                    return (
                      <span
                        key={m.ticker}
                        className="text-[9px] font-mono px-1 py-0.5 rounded text-white leading-tight"
                        style={{ background: heatColor(mv, timeframe.scaleMax * 1.4) }}
                      >
                        {m.ticker} {fmtPct(mv)}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500 mt-2">
        Price-based sector ETF performance (XLK, XLF, etc.) — a proxy, not measured fund flow. Box size = magnitude of move.
      </p>
    </div>
  );
}

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
