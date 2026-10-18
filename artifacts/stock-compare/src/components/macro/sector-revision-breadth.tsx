/** A95 — LSEG sector EPS-revision breadth (Macro › Heatmap). Display only. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Point = {
  date: string;
  n: number;
  up: number;
  down: number;
  breadth: number;
  medianDrift: number | null;
};

type Api = {
  bySector: Record<string, Point[]>;
  note?: string;
};

export function SectorRevisionBreadth({ enabled }: { enabled: boolean }) {
  const { data, isLoading, isError } = useQuery<Api>({
    queryKey: ["macro-revision-breadth", 60],
    queryFn: () => fetch("/api/macro/revision-breadth?days=60").then((r) => {
      if (!r.ok) throw new Error(`revision-breadth ${r.status}`);
      return r.json();
    }),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled,
  });

  const sectors = useMemo(() => {
    if (!data?.bySector) return [];
    return Object.keys(data.bySector)
      .filter((s) => s !== "Unknown")
      .sort((a, b) => (data.bySector[b]?.length ?? 0) - (data.bySector[a]?.length ?? 0));
  }, [data]);

  const [sector, setSector] = useState<string>("");
  const active = sector && data?.bySector[sector] ? sector : sectors[0] ?? "";
  const series = active ? (data?.bySector[active] ?? []) : [];

  if (isLoading || (!data && enabled)) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 flex items-center justify-center h-[140px]">
        <Loader2 className="h-5 w-5 animate-spin text-amber-200/40" />
      </div>
    );
  }

  if (isError || sectors.length === 0) {
    return (
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 text-[11px] text-amber-200/50">
        No LSEG revision rows yet — wait for signals_daily sync (A95).
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black border-b border-[#d4af37]/20 gap-2">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide shrink-0">
          Sector Revision Breadth
        </h3>
        <select
          value={active}
          onChange={(e) => setSector(e.target.value)}
          className={cn(
            "text-[11px] bg-zinc-950 text-amber-200/80 border border-[#d4af37]/20 rounded px-2 py-0.5 max-w-[200px]",
          )}
        >
          {sectors.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="h-[140px] px-1 pt-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#a8a29e" }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 9, fill: "#a8a29e" }} allowDecimals={false} />
            <ReferenceLine y={0} stroke="#52525b" />
            <Tooltip
              contentStyle={{ background: "#09090b", border: "1px solid #d4af3740", fontSize: 11 }}
              formatter={(v: number, key: string) => [v, key === "breadth" ? "up − down" : key]}
              labelFormatter={(d) => String(d)}
            />
            <Line type="monotone" dataKey="breadth" stroke="#38bdf8" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-amber-200/35 px-3 pb-2">
        LSEG FY1 EPS 30d drift — (# &gt; +1%) − (# &lt; −1%). Display only; not a signal. History from ~2026-10-04.
      </p>
    </div>
  );
}
