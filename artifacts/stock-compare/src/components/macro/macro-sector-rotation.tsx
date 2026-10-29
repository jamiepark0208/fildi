import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, ScatterChart, XAxis, YAxis, CartesianGrid, ZAxis,
  ReferenceLine, Tooltip, Scatter, LabelList, Cell,
} from "recharts";
import { Loader2, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SectorRotationPoint } from "./macro-page-types";

/** Select Sector SPDRs — same set as GET /macro/etf-flows default (A98). */
const SECTOR_FLOW_LABELS: Record<string, string> = {
  XLB: "Materials", XLE: "Energy", XLF: "Financials", XLI: "Industrials",
  XLK: "Tech", XLP: "Staples", XLU: "Utilities", XLV: "Health",
  XLY: "Discretionary", XLRE: "Real Estate", XLC: "Comm",
};
/** Theme / market SPDRs with SSGA navhist (A98). */
const THEME_FLOW_LABELS: Record<string, string> = {
  SPY: "S&P 500", MDY: "Midcap", GLD: "Gold", XBI: "Biotech",
  KRE: "Regional banks", XOP: "Oil & gas", XHB: "Homebuilders",
};
const FLOW_UNIVERSE = {
  sector: SECTOR_FLOW_LABELS,
  theme: THEME_FLOW_LABELS,
} as const;
const ALL_FLOW_ETFS = [...Object.keys(SECTOR_FLOW_LABELS), ...Object.keys(THEME_FLOW_LABELS)].join(",");

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
                <p className="text-[10px] text-amber-100 font-mono">{s.ticker}</p>
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

type FlowRow = { etf: string; date: string; flow_usd: number; aum: number };
type FlowApi = {
  series: Record<string, FlowRow[]>;
  note?: string;
};

const FLOW_WINDOWS = [
  { id: "1w" as const, label: "1W", days: 5 },
  { id: "1m" as const, label: "1M", days: 21 },
];

function windowFlowPct(rows: FlowRow[], n: number): number | null {
  if (!rows.length) return null;
  const slice = rows.slice(-n);
  const aum = Number(slice[slice.length - 1]?.aum);
  if (!(aum > 0)) return null;
  const flow = slice.reduce((s, r) => s + Number(r.flow_usd || 0), 0);
  return (flow / aum) * 100;
}

/** Rolling n-day %AUM over history → z of the latest window vs that sample. */
function windowZ(rows: FlowRow[], n: number): number | null {
  if (rows.length < n + 20) return null;
  const pcts: number[] = [];
  for (let i = n; i <= rows.length; i++) {
    const slice = rows.slice(i - n, i);
    const aum = Number(slice[slice.length - 1]?.aum);
    if (!(aum > 0)) continue;
    const flow = slice.reduce((s, r) => s + Number(r.flow_usd || 0), 0);
    pcts.push((flow / aum) * 100);
  }
  if (pcts.length < 20) return null;
  const latest = pcts[pcts.length - 1]!;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const var_ = pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length;
  const sd = Math.sqrt(var_);
  if (!(sd > 1e-9)) return null;
  return (latest - mean) / sd;
}

/** A98 P2 — SSGA creation/redemption flows (% AUM), not price RS. */
export function SectorFundFlowBars({ enabled }: { enabled: boolean }) {
  const [win, setWin] = useState<(typeof FLOW_WINDOWS)[number]>(FLOW_WINDOWS[0]!);
  const [univ, setUniv] = useState<keyof typeof FLOW_UNIVERSE>("sector");
  const labels = FLOW_UNIVERSE[univ];
  const { data, isLoading, isError } = useQuery<FlowApi>({
    queryKey: ["macro-etf-flows", 400, ALL_FLOW_ETFS],
    queryFn: () => fetch(`/api/macro/etf-flows?days=400&etfs=${ALL_FLOW_ETFS}`).then((r) => {
      if (!r.ok) throw new Error(`etf-flows ${r.status}`);
      return r.json();
    }),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled,
  });

  const bars = useMemo(() => {
    if (!data?.series) return [];
    return Object.keys(labels)
      .map((etf) => {
        const rows = data.series[etf] ?? [];
        return {
          etf,
          label: labels[etf]!,
          pct: windowFlowPct(rows, win.days),
          z: windowZ(rows, win.days),
          lastDate: rows[rows.length - 1]?.date ?? null,
        };
      })
      .sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  }, [data, win, labels]);

  const maxAbs = Math.max(0.5, ...bars.map((b) => Math.abs(b.pct ?? 0)));

  if (isLoading || (!data && enabled)) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 flex items-center justify-center h-[160px]">
        <Loader2 className="h-5 w-5 animate-spin text-amber-200/40" />
      </div>
    );
  }

  if (isError || !bars.some((b) => b.pct != null)) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 text-[11px] text-amber-200/50">
        No SSGA fund-flow rows yet — run nightly SSGA ingest (A98 P1).
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black border-b border-[#d4af37]/20">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          ETF Fund Flows
        </h3>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className="text-[10px] text-amber-200/40">% AUM · z vs 1y</span>
          <div className="flex gap-1">
            {(["sector", "theme"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUniv(u)}
                className={cn(
                  "px-2 py-1 transition-colors text-[11px] font-semibold rounded border border-[#d4af37]/20 capitalize",
                  univ === u ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                )}
              >
                {u}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {FLOW_WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWin(w)}
                className={cn(
                  "px-2 py-1 transition-colors text-[11px] font-semibold rounded border border-[#d4af37]/20",
                  win.id === w.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-1 p-2">
        {bars.map((b) => {
          const pct = b.pct ?? 0;
          const w = `${Math.min(100, (Math.abs(pct) / maxAbs) * 100)}%`;
          const pos = pct >= 0;
          return (
            <div key={b.etf} className="flex items-center gap-2 text-[11px] font-mono" title={`${b.etf} through ${b.lastDate ?? "—"}`}>
              <span className="w-[88px] shrink-0 text-amber-200/70 truncate">{b.label}</span>
              <span className="w-8 shrink-0 text-amber-200/40">{b.etf}</span>
              <div className="relative flex-1 h-4 bg-zinc-900 rounded overflow-hidden">
                <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600 z-10" />
                {pos ? (
                  <div className="absolute top-0 left-1/2 h-full bg-emerald-600/80 rounded-r" style={{ width: w }} />
                ) : (
                  <div className="absolute top-0 right-1/2 h-full bg-rose-600/80 rounded-l" style={{ width: w }} />
                )}
              </div>
              <span className={cn("w-14 text-right tabular-nums", pos ? "text-emerald-400" : "text-rose-400")}>
                {b.pct != null ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
              </span>
              <span className="w-10 text-right text-amber-200/40 tabular-nums">
                {b.z != null ? `${b.z > 0 ? "+" : ""}${b.z.toFixed(1)}σ` : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-amber-200/35 px-3 pb-2">
        SSGA navhist creations/redemptions — not price momentum.
      </p>
    </div>
  );
}

type BidApi = {
  rows: Array<{ ticker: string; bidUsd: number | null; etfN: number; holdingsAsOf: string | null }>;
};

const BID_FALLBACK = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AVGO", "JPM"];

/** A98 P3 — Σ ETF flow × weight for watchlist (or mega fallback). */
export function EtfBidStrip({
  enabled,
  tickers = [],
}: {
  enabled: boolean;
  tickers?: string[];
}) {
  const list = (tickers.length ? tickers.map((t) => t.toUpperCase()) : BID_FALLBACK).slice(0, 12);
  const q = list.join(",");
  const { data, isLoading, isError } = useQuery<BidApi>({
    queryKey: ["macro-etf-bid", 20, q],
    queryFn: () =>
      fetch(`/api/macro/etf-bid?tickers=${encodeURIComponent(q)}&days=20`).then((r) => {
        if (!r.ok) throw new Error(`etf-bid ${r.status}`);
        return r.json();
      }),
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    enabled: enabled && list.length > 0,
  });

  if (isLoading || (!data && enabled)) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-[72px]">
        <Loader2 className="h-4 w-4 animate-spin text-amber-200/40" />
      </div>
    );
  }
  if (isError || !data?.rows?.length) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-2 text-[11px] text-amber-200/50">
        No ETF-bid rows — need holdings + flows (A98 P3).
      </div>
    );
  }

  const fmt = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return n.toFixed(0);
  };

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black border-b border-[#d4af37]/20">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
          ETF Bid (20d)
        </h3>
        <span className="text-[10px] text-amber-200/40">flow × weight · display only</span>
      </div>
      <div className="flex flex-wrap gap-1.5 p-2">
        {data.rows.map((r) => {
          const pos = (r.bidUsd ?? 0) >= 0;
          return (
            <span
              key={r.ticker}
              title={`${r.etfN} ETFs · holdings ${r.holdingsAsOf ?? "—"}`}
              className={cn(
                "text-[11px] font-mono px-2 py-0.5 rounded border",
                pos
                  ? "text-emerald-300 border-emerald-600/40 bg-emerald-950/40"
                  : "text-rose-300 border-rose-600/40 bg-rose-950/40",
              )}
            >
              {r.ticker} {r.bidUsd != null ? `${pos ? "+" : ""}${fmt(r.bidUsd)}` : "—"}
            </span>
          );
        })}
      </div>
    </div>
  );
}
