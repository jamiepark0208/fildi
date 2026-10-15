/**
 * Breakdown › Short interest — headline % of float (LSEG, daily) + shares-short line with days-to-cover (FINRA via Polygon,
 * twice a month since 2020). Context, not a signal (untested as a predictor). Data: GET /api/stocks/:ticker/short-interest.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

type Point = { date: string; sharesShort: number; daysToCover: number | null };
type View = { points: Point[]; current: { shortPctFloat: number | null; asOf: string | null }; refreshing: boolean };

const RANGES = [["1Y", 365], ["3Y", 1095], ["All", 99_999]] as const;

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export function ShortInterestPanel({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<number>(365);
  const { data, isLoading } = useQuery({
    queryKey: ["short-interest", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/short-interest`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
  const pts = useMemo(() => {
    const cutoff = Date.now() - range * 86_400_000;
    return (data?.points ?? []).filter((p) => new Date(p.date).getTime() >= cutoff);
  }, [data, range]);

  if (isLoading) return <p className="text-[10px] text-amber-200/40">Loading…</p>;
  if (!data || (data.points.length === 0 && data.current.shortPctFloat == null)) return <p className="text-[10px] text-amber-200/40 italic">No short-interest data for this ticker.</p>;

  const pct = data.current.shortPctFloat;
  const last = data.points[data.points.length - 1];
  const ago = data.points.find((p) => new Date(p.date).getTime() >= new Date(last?.date ?? 0).getTime() - 90 * 86_400_000);
  const chg = last && ago && ago.sharesShort > 0 ? (last.sharesShort / ago.sharesShort - 1) * 100 : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-3 text-[11px]">
        <span className={cn("text-[15px] font-semibold tabular-nums", pct == null ? "text-amber-200/40" : pct >= 30 ? "text-red-300" : pct >= 15 ? "text-amber-300" : "text-amber-100")}>
          {pct == null ? "—" : `${pct.toFixed(1)}%`}
        </span>
        <span className="text-amber-200/50">of float short</span>
        {last?.daysToCover != null && <span className="text-amber-200/70 tabular-nums">{last.daysToCover.toFixed(1)}d to cover</span>}
        {chg != null && (
          <span className={cn("tabular-nums", chg > 0 ? "text-red-300/80" : "text-emerald-300/80")} title="Shares short vs ~3 months earlier">
            {chg > 0 ? "+" : ""}{chg.toFixed(0)}% 3m
          </span>
        )}
        <span className="ml-auto flex gap-0.5">
          {RANGES.map(([label, d]) => (
            <button key={label} type="button" onClick={() => setRange(d)}
              className={cn("px-1 text-[9px] rounded", range === d ? "bg-[#d4af37]/80 text-black" : "text-amber-200/50 hover:text-[#d4af37]")}>
              {label}
            </button>
          ))}
        </span>
      </div>
      {pts.length >= 2 && (
        <div className="h-28 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={pts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis yAxisId="s" hide domain={["auto", "auto"]} />
              <YAxis yAxisId="d" hide orientation="right" domain={[0, "auto"]} />
              <Tooltip
                contentStyle={{ background: "#09090b", border: "1px solid #d4af3733", fontSize: 10 }}
                labelStyle={{ color: "#fde68a99" }}
                formatter={(v: number, name: string) => (name === "sharesShort" ? [compact(v), "shares short"] : [v?.toFixed(1), "days to cover"])}
              />
              <Line yAxisId="s" type="monotone" dataKey="sharesShort" stroke="#d4af37" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line yAxisId="d" type="monotone" dataKey="daysToCover" stroke="#a1a1aa" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-[9px] text-amber-200/30">
        Gold = shares short, dashed = days to cover (FINRA, twice monthly). % float: LSEG {data.current.asOf ?? ""}. Context, not a signal.
      </p>
    </div>
  );
}
