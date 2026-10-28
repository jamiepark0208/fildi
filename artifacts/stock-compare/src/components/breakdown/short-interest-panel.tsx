/**
 * Breakdown › Short interest — headline % of float (LSEG, daily) + shares-short line with days-to-cover (FINRA via Polygon,
 * twice a month since 2020). Context, not a signal (untested as a predictor). Data: GET /api/stocks/:ticker/short-interest.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";

type Point = { date: string; sharesShort: number; daysToCover: number | null };
type VolPoint = { date: string; shortVolumeRatio: number };
type View = {
  points: Point[];
  shortVolume?: VolPoint[];
  shortVolumeAvg20?: number | null;
  current: { shortPctFloat: number | null; asOf: string | null };
  refreshing: boolean;
};

const RANGES = [["1Y", 365], ["3Y", 1095], ["All", 99_999]] as const;

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function useShortInterest(ticker: string) {
  return useQuery({
    queryKey: ["short-interest", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/short-interest`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
    refetchInterval: (q) => (q.state.data?.refreshing ? 10_000 : false), // first view: server answers before Polygon lands
  });
}

/** Compact headline for BreakdownPanel header (right of title). */
export function ShortInterestHeaderStats({ ticker }: { ticker: string }) {
  const { data } = useShortInterest(ticker);
  if (!data) return null;
  const pct = data.current.shortPctFloat;
  const last = data.points[data.points.length - 1];
  const ago = data.points.find((p) => new Date(p.date).getTime() >= new Date(last?.date ?? 0).getTime() - 90 * 86_400_000);
  const chg = last && ago && ago.sharesShort > 0 ? (last.sharesShort / ago.sharesShort - 1) * 100 : null;
  const asOf = data.current.asOf ? formatMdYy(data.current.asOf) : null;
  return (
    <span className="text-[11px] font-mono tabular-nums text-white shrink-0 whitespace-nowrap">
      <span
        className={cn(
          "font-semibold",
          pct == null ? "text-white" : pct >= 30 ? "text-red-300" : pct >= 15 ? "text-amber-200" : "text-white",
        )}
      >
        {pct == null ? "—" : `${pct.toFixed(1)}%`}
      </span>
      <span> float</span>
      {last?.daysToCover != null && <span> · {last.daysToCover.toFixed(1)}d</span>}
      {chg != null && (
        <span className={cn(" ml-1", chg > 0 ? "text-red-300" : "text-emerald-300")}>
          {chg > 0 ? "+" : ""}{chg.toFixed(0)}% 3m
        </span>
      )}
      {asOf && <span className="ml-1.5 font-semibold">{asOf}</span>}
    </span>
  );
}

export function ShortInterestPanel({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<number>(365);
  const { data, isLoading } = useShortInterest(ticker);
  const pts = useMemo(() => {
    const cutoff = Date.now() - range * 86_400_000;
    return (data?.points ?? []).filter((p) => new Date(p.date).getTime() >= cutoff);
  }, [data, range]);
  const volPts = useMemo(() => {
    const cutoff = Date.now() - Math.min(range, 90) * 86_400_000;
    return (data?.shortVolume ?? []).filter((p) => new Date(p.date).getTime() >= cutoff);
  }, [data, range]);

  if (isLoading) return <p className="text-[10px] text-white/70">Loading…</p>;
  if (!data || (data.points.length === 0 && data.current.shortPctFloat == null)) {
    return <p className="text-[10px] text-white/70 italic">No short-interest data for this ticker.</p>;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end gap-0.5 shrink-0">
        {RANGES.map(([label, d]) => (
          <button
            key={label}
            type="button"
            onClick={() => setRange(d)}
            className={cn(
              "px-1 text-[9px] rounded font-semibold",
              range === d ? "bg-[#d4af37] text-black" : "text-white/70 hover:text-[#d4af37]",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {pts.length >= 2 && (
        <div className="h-28 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={pts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis hide domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{ background: "#09090b", border: "1px solid #d4af3766", fontSize: 10 }}
                labelFormatter={(v) => formatMdYy(String(v))}
                formatter={(v: number, name: string) =>
                  name === "sharesShort" ? [compact(v), "shares short"] : [v?.toFixed?.(1) ?? v, "d cover"]
                }
              />
              <Line type="monotone" dataKey="sharesShort" stroke="#d4af37" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="daysToCover" stroke="#e4e4e7" strokeWidth={1} strokeDasharray="3 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {volPts.length >= 2 && (
        <div className="flex items-baseline gap-2 text-[10px] text-white/70">
          <span>short vol ratio</span>
          {data.shortVolumeAvg20 != null && (
            <span className="font-mono text-white">{(data.shortVolumeAvg20 * 100).toFixed(0)}% 20d avg</span>
          )}
        </div>
      )}
    </div>
  );
}
