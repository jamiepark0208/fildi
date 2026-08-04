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
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 flex items-center justify-center h-[200px]">
        <Loader2 className="h-5 w-5 animate-spin text-amber-200/40" />
      </div>
    );
  }

  // Tile "footprint" scales with |% move| for this timeframe — a true treemap-style
  // weight (bigger box = bigger flow), not a uniform grid. flex-grow does the sizing;
  // flex-wrap packs rows so bigger movers naturally claim more space per row.
  const weightOf = (s: SectorRotationPoint) => Math.max(0.35, Math.abs(s[timeframe.key] ?? 0));

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black border-b border-[#d4af37]/20">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Sector Performance</h3>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-amber-200/40">
            <span style={{ color: RED_STEPS[4] }}>down</span> · flat · <span style={{ color: GREEN_STEPS[4] }}>up</span>
          </span>
          <div className="flex gap-1">
            {HEATMAP_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  "px-2 py-1 transition-colors text-[11px] font-semibold rounded border border-[#d4af37]/20",
                  timeframe.id === tf.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                )}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1.5">
        {data.map((s) => {
          const val = s[timeframe.key];
          return (
            <div
              key={s.ticker}
              className="rounded p-2 flex flex-col justify-between min-h-[76px]"
              style={{ background: heatColor(val, timeframe.scaleMax), flex: `${weightOf(s)} 1 150px` }}
              title={`${s.label} (${s.ticker}) ${timeframe.label}: ${fmtPct(val)}`}
            >
              <div className="flex items-baseline justify-between gap-1">
                <p className="text-xs font-semibold text-white leading-tight drop-shadow-sm">{s.label}</p>
                <p className="text-[10px] text-white/70 font-mono">{s.ticker}</p>
              </div>
              <p className="text-lg font-bold text-white tabular-nums drop-shadow-sm font-mono">
                {fmtPct(val)}
              </p>
              {s.topMovers?.length > 0 && (
                <div className="flex flex-wrap gap-1">
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

  return (
    <div className="mb-1.5">
      <p className="text-[11px] font-mono text-sky-300/60">
        {sorted.map((d, i) => {
          const up = d.rs1d! >= 0;
          return (
            <span key={d.ticker}>
              {i > 0 && " · "}
              <span className="text-amber-200/50">{d.label}</span>
              {" "}
              <span className={up ? "text-green-400" : "text-red-400"}>{up ? "+" : ""}{d.rs1d!.toFixed(1)}%</span>
            </span>
          );
        })}
      </p>
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
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 flex items-center justify-center h-[240px]">
        <Loader2 className="h-5 w-5 animate-spin text-amber-200/40" />
      </div>
    );
  }

  const points = data
    .filter((d) => d.rs1m != null && d.momentum != null)
    .map((d) => ({ ...d, z: Math.abs(d.rs1m!) + 0.5 }));
  const leaders = data.filter((d) => d.quadrant === "leading").map((d) => d.label);

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black border-b border-[#d4af37]/20">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-[#d4af37]/80" />
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Sector Rotation vs SPY</h2>
        </div>
        <div className="flex items-center gap-2.5 text-[10px] text-amber-200/50">
          {(["leading", "improving", "lagging", "weakening"] as const).map((q) => (
            <span key={q} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: QUADRANT_COLOR[q] }} />
              {QUADRANT_LABEL[q]}
            </span>
          ))}
        </div>
      </div>

      <div className="px-2 pt-1.5">
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
                  <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-2.5 py-2 text-xs max-w-[230px] shadow-lg shadow-black/60">
                    <p className="font-semibold text-sm text-white">{p.label}</p>
                    <p style={{ color: QUADRANT_COLOR[p.quadrant ?? ""] }} className="font-medium">
                      {QUADRANT_LABEL[p.quadrant ?? ""]} — {QUADRANT_IMPLICATION[p.quadrant ?? ""]}
                    </p>
                    <p className="mt-1 font-mono text-sky-300/70">Today: {p.rs1d != null ? `${p.rs1d > 0 ? "+" : ""}${p.rs1d}%` : "—"} · 1m: {p.rs1m! > 0 ? "+" : ""}{p.rs1m}% · 3m: {p.rs3m! > 0 ? "+" : ""}{p.rs3m}%</p>
                    {p.topMovers?.length > 0 && (
                      <div className="mt-1 pt-1 border-t border-[#d4af37]/20 font-mono text-amber-200/50">
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
        <p className="text-[11px] font-mono text-sky-300/60 px-1 pb-1.5">
          <span className="text-amber-200/50">Leading</span> {leaders.join(", ")}
        </p>
      )}
      </div>
    </div>
  );
}
