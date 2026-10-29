import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const RADIAN = Math.PI / 180;

/** Opaque tooltip chrome — theme `bg-popover` reads as transparent over the chart. */
const TIP =
  "rounded-md border border-[#d4af37]/35 bg-zinc-950 px-2.5 py-2 shadow-2xl shadow-black/80 text-[10px] text-zinc-100";

// ── Tooltips ──────────────────────────────────────────────────────────────────

export function ChartTooltip({ active, payload, format }: {
  active?: boolean; payload?: any[]; format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={cn(TIP, "space-y-1")}>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 min-w-[120px]">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill ?? p.color }} />
          <span className="text-zinc-300 flex-1 truncate">{p.name ?? p.dataKey}</span>
          <span className="font-mono font-semibold tabular-nums text-white">
            {format ? format(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  const displayValue = d.payload.signedValue ?? d.value;
  const breakdown: { name: string; value: number; pct: number }[] | undefined = d.payload.breakdown;
  return (
    <div className={cn(TIP, "max-w-[240px]")}>
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.payload.color }} />
        <span className="font-semibold text-white truncate">{d.name}</span>
      </div>
      <div className="font-mono font-semibold mt-0.5 text-amber-100 tabular-nums">
        {formatCurrency(displayValue)}
        <span className="text-amber-100 font-normal ml-1.5">{d.payload.pct?.toFixed(1)}%</span>
      </div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-[#d4af37]/20 space-y-0.5">
          {breakdown.slice(0, 8).map(b => (
            <div key={b.name} className="flex items-center justify-between gap-3 font-mono tabular-nums">
              <span className="text-amber-100 truncate">{b.name}</span>
              <span className="text-zinc-200 shrink-0">
                {formatCurrency(b.value)}{" "}
                <span className="text-amber-100/80">({b.pct.toFixed(1)}%)</span>
              </span>
            </div>
          ))}
          {breakdown.length > 8 && (
            <div className="text-amber-100/80">+{breakdown.length - 8} more</div>
          )}
        </div>
      )}
    </div>
  );
}

type Slice = {
  name: string;
  value: number;
  color: string;
  pct?: number;
  signedValue?: number;
  breakdown?: { name: string; value: number; pct: number }[];
};

/** Tiny in-slice label for wedges large enough to read. */
function sliceLabel(props: {
  cx?: number; cy?: number; midAngle?: number;
  innerRadius?: number; outerRadius?: number;
  name?: string; pct?: number;
}) {
  const { cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, name = "", pct } = props;
  if (pct == null || pct < 7) return null;
  const r = innerRadius + (outerRadius - innerRadius) * 0.55;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  const short = name.length > 9 ? `${name.slice(0, 8)}…` : name;
  return (
    <text
      x={x}
      y={y}
      fill="#fafafa"
      textAnchor="middle"
      dominantBaseline="central"
      style={{ fontSize: 8, fontWeight: 600, pointerEvents: "none" }}
    >
      <tspan x={x} dy="-0.35em">{short}</tspan>
      <tspan x={x} dy="1.1em" style={{ fontSize: 7, fontWeight: 500, fill: "#e4e4e7" }}>
        {pct.toFixed(0)}%
      </tspan>
    </text>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────

export function DonutChart({ data, total, label }: {
  data: Slice[];
  total: number; label: string;
}) {
  if (!data.length) return (
    <div className="h-[160px] flex items-center justify-center text-xs text-amber-100/80">No data</div>
  );
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={160}>
        <PieChart margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={48}
            outerRadius={68}
            dataKey="value"
            stroke="none"
            paddingAngle={1.5}
            label={sliceLabel}
            labelLine={false}
            isAnimationActive={false}
          >
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip
            content={<PieTooltip />}
            wrapperStyle={{ zIndex: 50, outline: "none", pointerEvents: "none" }}
            // Kill Recharts default white/glass wrapper behind custom content
            contentStyle={{ background: "transparent", border: "none", padding: 0, boxShadow: "none" }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center">
          <div className="text-[9px] text-amber-100 leading-none uppercase tracking-wide">{label}</div>
          <div className="text-sm font-bold font-mono mt-0.5 leading-none text-white tabular-nums">
            {formatCurrency(total)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Always-visible compact legend — slice-colored labels; 1 col when ≤4 so names don't clip. */
export function PieLegend({ data }: { data: Slice[] }) {
  if (!data.length) return null;
  const oneCol = data.length <= 4;
  return (
    <div className={cn("mt-1.5 gap-x-2 gap-y-0.5", oneCol ? "flex flex-col" : "grid grid-cols-2")}>
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-1.5 min-w-0 text-[9px] leading-tight">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: d.color }} />
          <span className="font-semibold truncate min-w-0" style={{ color: d.color }} title={d.name}>
            {d.name}
          </span>
          <span className="font-mono tabular-nums shrink-0 ml-auto" style={{ color: d.color, opacity: 0.85 }}>
            {d.pct != null ? `${d.pct.toFixed(0)}%` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Risk stat ─────────────────────────────────────────────────────────────────

export function RiskStat({ label, value, sub, icon, color }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; color?: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/20 border border-border/50">
      <div className={cn("mt-0.5 shrink-0", color ?? "text-white")}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] text-white font-medium uppercase tracking-wide">{label}</div>
        <div className="text-lg font-bold font-mono tabular-nums leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-white mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}
