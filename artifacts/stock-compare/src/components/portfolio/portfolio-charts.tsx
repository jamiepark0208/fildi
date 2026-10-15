import { useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

// ── Tooltips ──────────────────────────────────────────────────────────────────

export function ChartTooltip({ active, payload, format }: {
  active?: boolean; payload?: any[]; format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1">
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 min-w-[120px]">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill ?? p.color }} />
          <span className="text-white flex-1">{p.name ?? p.dataKey}</span>
          <span className="font-mono font-semibold">{format ? format(p.value) : p.value}</span>
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
    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs max-w-[220px]">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full" style={{ background: d.payload.color }} />
        <span className="text-white">{d.name}</span>
      </div>
      <div className="font-mono font-semibold mt-0.5">{formatCurrency(displayValue)}</div>
      <div className="text-white">{d.payload.pct?.toFixed(1)}%</div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-border/60 space-y-0.5">
          {breakdown.slice(0, 8).map(b => (
            <div key={b.name} className="flex items-center justify-between gap-3 font-mono">
              <span className="text-white">{b.name}</span>
              <span>{formatCurrency(b.value)} <span className="text-white">({b.pct.toFixed(1)}%)</span></span>
            </div>
          ))}
          {breakdown.length > 8 && (
            <div className="text-white">+{breakdown.length - 8} more</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────

export function DonutChart({ data, total, label }: {
  data: { name: string; value: number; color: string; pct?: number; signedValue?: number; breakdown?: { name: string; value: number; pct: number }[] }[];
  total: number; label: string;
}) {
  if (!data.length) return (
    <div className="h-[180px] flex items-center justify-center text-xs text-white">No data</div>
  );
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={52} outerRadius={72}
            dataKey="value" stroke="none" paddingAngle={2}>
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<PieTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center">
          <div className="text-[10px] text-white leading-none">{label}</div>
          <div className="text-sm font-bold font-mono mt-0.5 leading-none">{formatCurrency(total)}</div>
        </div>
      </div>
    </div>
  );
}

// Compact dot-strip that expands into the full breakdown on hover — replaces
// the old always-visible multi-row legend, which ate 4-6 lines per card.
export function PieLegend({ data }: { data: { name: string; value: number; color: string; pct?: number; signedValue?: number }[] }) {
  const [open, setOpen] = useState(false);
  if (!data.length) return null;
  return (
    <div className="relative mt-2" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <div className="flex items-center gap-1 flex-wrap cursor-default">
        {data.map((d, i) => (
          <div key={i} className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
        ))}
        <span className="text-[10px] text-white ml-1">
          {data.length} · hover for detail
        </span>
      </div>
      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1.5 min-w-[180px]">
          {data.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
              <span className="text-white flex-1 truncate">{d.name}</span>
              <span className="font-mono tabular-nums text-right">{d.pct?.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
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
