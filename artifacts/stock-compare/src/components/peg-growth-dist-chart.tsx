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

/** Dot only — ticker / PEG-growth live in the Recharts hover tooltip (labels stacked on dense peers). */
function PeerPoint(props: {
  cx?: number;
  cy?: number;
  payload?: {
    ticker?: string;
    growth?: number;
    isSubject?: boolean;
    z?: number;
  };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload?.ticker) return null;
  const fill = zDot(payload.z ?? 0, !!payload.isSubject);
  const r = payload.isSubject ? 6 : 4.5;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={fill} stroke={payload.isSubject ? "#f5e6a3" : fill} strokeWidth={payload.isSubject ? 1.5 : 0} />
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
      const scatterData = display.map((p, i) => ({
      x: p.growth,
      // Stagger vertically so overlapping x still hoverable; no on-chart labels.
      y: 0.42 + (i % 4) * 0.1,
      ticker: p.ticker,
      growth: p.growth,
      z: p.z,
      isSubject: p.isSubject,
    }));
    return { curve: curveData, scatter: scatterData };
  }, [mean, std, display]);

  const sourceTip =
    pegGrowthSource === "trailing_yoy"
      ? "Trailing YoY growth"
      : pegGrowthSource === "forward_implied"
        ? "Forward-implied growth"
        : "PEG growth";

  return (
    <div className="flex flex-col h-full min-h-0 gap-1 overflow-hidden">
      <div className="flex items-center gap-2 min-w-0 shrink-0">
        {groupName ? (
          <span
            className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border border-teal-400/70 bg-zinc-900 text-white truncate max-w-[11rem]"
            title={`${sourceTip} · ${groupName}`}
          >
            {groupName}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "text-[13px] font-bold font-mono tabular-nums leading-none cursor-help shrink-0 text-white",
                zTone(subjectZ),
              )}
              title={sourceTip}
            >
              {formatPercent(subjectGrowth)}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className="max-w-sm bg-card text-foreground border border-border p-2.5 space-y-1"
          >
            <p className="text-[11px] leading-relaxed text-white">
              {pegGrowthExplain ?? "No growth assumption available yet."}
            </p>
            <p className="text-[10px] font-mono text-amber-100">
              {subjectZ != null
                ? `${subjectZ >= 0 ? "+" : ""}${subjectZ.toFixed(2)}σ · n=${members.length}`
                : "peer z unavailable"}
            </p>
          </TooltipContent>
        </Tooltip>
        <span className={cn("text-[13px] font-mono font-semibold shrink-0", zTone(subjectZ))}>
          {subjectZ != null ? `${subjectZ >= 0 ? "+" : ""}${subjectZ.toFixed(1)}σ` : "—"}
        </span>
      </div>

      <div className="relative flex-1 min-h-[140px] w-full overflow-hidden rounded border border-[#d4af37]/15 bg-black/30">
        <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={curve} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
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
              <YAxis hide domain={[0, 1.2]} />
              <RechartsTooltip
                cursor={{ stroke: "#d4af37", strokeOpacity: 0.35 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  // Prefer scatter payload (has ticker); area hover has no peer.
                  const peer = payload.find((x) => (x.payload as { ticker?: string })?.ticker != null)?.payload as
                    | { ticker?: string; growth?: number; z?: number; isSubject?: boolean }
                    | undefined;
                  if (peer?.ticker == null || peer.growth == null) return null;
                  return (
                    <div className="rounded border border-[#d4af37]/40 bg-zinc-950 px-2.5 py-1.5 text-[11px] shadow-lg space-y-0.5">
                      <div className="font-mono font-bold text-white">
                        {peer.ticker}
                        {peer.isSubject ? <span className="text-[#d4af37] font-sans font-semibold ml-1 text-[10px]">you</span> : null}
                      </div>
                      <div className="text-amber-100/90">
                        PEG growth <span className="font-mono font-semibold text-white">{formatPercent(peer.growth)}</span>
                      </div>
                      {peer.z != null && (
                        <div className="text-amber-100/80 text-[10px] font-mono">
                          {peer.z >= 0 ? "+" : ""}{peer.z.toFixed(2)}σ vs peers
                        </div>
                      )}
                      {peer.z != null && Math.abs(peer.z) >= 2 && !peer.isSubject && (
                        <div className="text-[10px] text-amber-50 leading-snug max-w-[200px]">
                          Far from peer mean — check peer group / growth data if the name looks unrelated.
                        </div>
                      )}
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
                activeDot={false}
              />
              <Scatter data={scatter} dataKey="y" shape={<PeerPoint />} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="text-[9px] font-mono text-white shrink-0">n={members.length} peers</p>
    </div>
  );
}
