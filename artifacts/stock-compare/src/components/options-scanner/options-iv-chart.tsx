import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IvTermPoint } from "./options-scanner-types";

// ── IV term structure chart (ticker-level — ATM IV across the expiry calendar) ─

export function IvTermStructureChart({ data, isLoading }: { data: IvTermPoint[] | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white py-4">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading term structure…
      </div>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-xs text-white italic py-4">No term structure data available.</p>;
  }

  const points = data.map(d => ({ ...d, ivPct: d.iv * 100 }));
  const first = points[0]!.ivPct;
  const last = points[points.length - 1]!.ivPct;
  const shape = last > first * 1.03 ? "Contango" : last < first * 0.97 ? "Backwardation" : "Flat";
  const shapeColor = shape === "Backwardation" ? "text-orange-400" : shape === "Contango" ? "text-green-400" : "text-white";

  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-white uppercase tracking-wide">ATM IV by expiry</span>
        <span className={cn("text-[10px] font-semibold", shapeColor)}>{shape}</span>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={points} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#fff" }} axisLine={{ stroke: "#3f3f46" }} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: "#fff" }} axisLine={{ stroke: "#3f3f46" }} tickLine={false} width={36} tickFormatter={v => `${v}%`} />
          <Tooltip content={(p) => {
            const d = p.payload?.[0]?.payload as (IvTermPoint & { ivPct: number }) | undefined;
            if (!p.active || !d) return null;
            return (
              <div className="bg-popover border border-border rounded-lg px-2.5 py-1.5 shadow-xl text-xs space-y-0.5">
                <div className="text-white font-bold">{d.label} · {d.dte}d · exp {d.expiry}</div>
                <div className="text-amber-400 font-bold tabular-nums">{d.ivPct.toFixed(1)}% IV</div>
              </div>
            );
          }} />
          <Line type="monotone" dataKey="ivPct" stroke="#fbbf24" strokeWidth={1.75} dot={{ r: 3, fill: "#fbbf24" }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
