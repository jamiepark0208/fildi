import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Scatter,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  ReferenceLine,
} from "recharts";
import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PegGrowthPeerPoint = {
  ticker: string;
  growth: number;
  z: number;
  isSubject: boolean;
  marketCap?: number | null;
};

function normalPdf(x: number, mean: number, std: number): number {
  if (std <= 1e-12) return 0;
  const u = (x - mean) / std;
  return Math.exp(-0.5 * u * u) / (std * Math.sqrt(2 * Math.PI));
}

function zTone(z: number | null | undefined): string {
  if (z == null) return "text-amber-200/50";
  if (z >= 0.5) return "text-emerald-400";
  if (z <= -0.5) return "text-red-400";
  return "text-yellow-400";
}

function zDot(z: number, isSubject: boolean): string {
  if (isSubject) return "#d4af37";
  if (z >= 0.5) return "#34d399";
  if (z <= -0.5) return "#f87171";
  return "#facc15";
}

/** Dot + ticker/value label — white text, larger, edge-aware anchoring. */
function PeerPoint(props: {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: {
    ticker?: string;
    growth?: number;
    isSubject?: boolean;
    z?: number;
    xFrac?: number;
  };
}) {
  const { cx, cy, index = 0, payload } = props;
  if (cx == null || cy == null || !payload?.ticker) return null;
  const fill = zDot(payload.z ?? 0, !!payload.isSubject);
  const above = index % 2 === 0;
  const labelY = above ? cy - 14 : cy + 16;
  const pct = payload.growth != null ? formatPercent(payload.growth) : "";

  const frac = payload.xFrac ?? 0.5;
  let anchor: "start" | "middle" | "end" = "middle";
  let lx = cx;
  if (frac < 0.12) {
    anchor = "start";
    lx = cx + 6;
  } else if (frac > 0.88) {
    anchor = "end";
    lx = cx - 6;
  }

  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill={fill} stroke={fill} />
      <text
        x={lx}
        y={labelY}
        textAnchor={anchor}
        fill={payload.isSubject ? "#d4af37" : "#ffffff"}
        fontSize={11}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontWeight={payload.isSubject ? 700 : 600}
        style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.75)", strokeWidth: 3 }}
      >
        {payload.ticker} {pct}
      </text>
    </g>
  );
}

interface PegGrowthDistChartProps {
  mean: number;
  std: number;
  subjectGrowth: number;
  subjectZ: number | null;
  pegGrowthSource?: string | null;
  pegGrowthExplain?: string | null;
  display: PegGrowthPeerPoint[];
  members: PegGrowthPeerPoint[];
  groupName?: string | null;
}

/** Growth panel — big z-score % + bell curve filling the box with on-chart peer labels. */
export function PegGrowthDistChart({
  mean,
  std,
  subjectGrowth,
  subjectZ,
  pegGrowthSource,
  pegGrowthExplain,
  display,
  members,
  groupName,
}: PegGrowthDistChartProps) {
  const { curve, scatter } = useMemo(() => {
    const lo = mean - 3 * Math.max(std, 1e-6);
    const hi = mean + 3 * Math.max(std, 1e-6);
    const steps = 48;
    const raw: Array<{ x: number; density: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const x = lo + ((hi - lo) * i) / steps;
      raw.push({ x, density: normalPdf(x, mean, Math.max(std, 1e-6)) });
    }
    const peakDensity = Math.max(...raw.map((d) => d.density), 1e-9);
    const curveData = raw.map((d) => ({ x: d.x, density: d.density / peakDensity }));
    const span = Math.max(hi - lo, 1e-9);
    // Keep dots mid-curve so labels above/below stay inside the plot
    const scatterData = display.map((p, i) => ({
      x: p.growth,
      y: 0.45 + (i % 3) * 0.08,
      ticker: p.ticker,
      growth: p.growth,
      z: p.z,
      isSubject: p.isSubject,
      xFrac: (p.growth - lo) / span,
    }));
    return { curve: curveData, scatter: scatterData };
  }, [mean, std, display]);

  const sourceLabel =
    pegGrowthSource === "trailing_yoy"
      ? "Trailing YoY"
      : pegGrowthSource === "forward_implied"
        ? "Forward-implied"
        : "PEG growth";

  return (
    <div className="flex flex-col h-full min-h-0 gap-1.5">
      <div className="flex items-center gap-2 min-w-0 shrink-0">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-200/45 truncate min-w-0">
          {sourceLabel}
          {groupName ? ` · ${groupName}` : ""}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "text-2xl font-bold font-mono tabular-nums leading-none cursor-help shrink-0",
                zTone(subjectZ),
              )}
            >
              {formatPercent(subjectGrowth)}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className="max-w-sm bg-card text-foreground border border-border p-2.5 space-y-1"
          >
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {pegGrowthExplain ?? "No growth assumption available yet."}
            </p>
            <p className="text-[10px] font-mono text-amber-200/70">
              {subjectZ != null
                ? `${subjectZ >= 0 ? "+" : ""}${subjectZ.toFixed(2)}σ · n=${members.length}`
                : "peer z unavailable"}
            </p>
          </TooltipContent>
        </Tooltip>
        <span className={cn("text-sm font-mono font-semibold shrink-0", zTone(subjectZ))}>
          {subjectZ != null ? `${subjectZ >= 0 ? "+" : ""}${subjectZ.toFixed(1)}σ` : "—"}
        </span>
        <span className="text-[9px] font-mono text-amber-200/35 ml-auto shrink-0">n={members.length}</span>
      </div>

      <div className="relative flex-1 min-h-[160px] w-full overflow-hidden rounded border border-[#d4af37]/15 bg-black/30">
        <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={curve} margin={{ top: 28, right: 28, left: 12, bottom: 8 }}>
              <XAxis
                type="number"
                dataKey="x"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                tick={{ fontSize: 11, fill: "#ffffff", fontWeight: 500 }}
                axisLine={{ stroke: "#52525b" }}
                tickLine={false}
                height={22}
              />
              <YAxis hide domain={[0, 1.45]} />
              <RechartsTooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0]?.payload as { ticker?: string; growth?: number; z?: number };
                  if (p?.ticker == null || p.growth == null) return null;
                  return (
                    <div className="rounded border border-border bg-card px-2 py-1 text-[10px] shadow-md">
                      <span className="font-mono font-bold">{p.ticker}</span>
                      {" · "}
                      {formatPercent(p.growth)}
                      {" · "}
                      {p.z != null && p.z >= 0 ? "+" : ""}
                      {p.z?.toFixed(1)}σ
                    </div>
                  );
                }}
              />
              <ReferenceLine x={mean} stroke="#64748b" strokeDasharray="2 2" strokeOpacity={0.55} />
              <ReferenceLine x={subjectGrowth} stroke="#d4af37" strokeWidth={1.5} />
              <Area
                type="monotone"
                dataKey="density"
                stroke="#d4af37"
                strokeOpacity={0.9}
                strokeWidth={2}
                fill="#d4af37"
                fillOpacity={0.28}
                isAnimationActive={false}
              />
              <Scatter data={scatter} dataKey="y" shape={<PeerPoint />} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
