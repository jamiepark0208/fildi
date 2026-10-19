/** A95 — LSEG sector EPS-revision breadth + rating up/down events (Macro › Heatmap). */
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

type Event = {
  date: string;
  ticker: string;
  firm: string | null;
  action: "upgrade" | "downgrade";
  fromGrade: string | null;
  toGrade: string | null;
  sector: string;
};

type Api = {
  bySector: Record<string, Point[]>;
  bySectorPt?: Record<string, Point[]>;
  events?: Event[];
  note?: string;
};

export function SectorRevisionBreadth({
  enabled,
  watchlistTickers = [],
}: {
  enabled: boolean;
  /** When set, "Watchlist only" filters event chips to these tickers. */
  watchlistTickers?: string[];
}) {
  const { data, isLoading, isError } = useQuery<Api>({
    queryKey: ["macro-revision-breadth", 60, "v2"],
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
  const [wlOnly, setWlOnly] = useState(false);
  const [bookOnly, setBookOnly] = useState(false);
  const [metric, setMetric] = useState<"eps" | "pt">("eps");
  const wlSet = useMemo(
    () => new Set(watchlistTickers.map((t) => t.toUpperCase())),
    [watchlistTickers],
  );
  const { data: bookOdds } = useQuery<{ positions?: { ticker: string }[] }>({
    queryKey: ["pm-odds", "a95-book-filter"],
    queryFn: async () => {
      const r = await fetch("/api/pm/odds", { credentials: "include" });
      if (!r.ok) return { positions: [] };
      return r.json();
    },
    staleTime: 5 * 60_000,
    enabled,
  });
  const bookSet = useMemo(
    () => new Set((bookOdds?.positions ?? []).map((p) => p.ticker.toUpperCase())),
    [bookOdds],
  );

  const active = sector && data?.bySector[sector] ? sector : sectors[0] ?? "";
  const series = active
    ? metric === "pt"
      ? (data?.bySectorPt?.[active] ?? [])
      : (data?.bySector[active] ?? [])
    : [];
  const events = useMemo(() => {
    let list = (data?.events ?? []).filter((e) => e.sector === active);
    if (wlOnly && wlSet.size > 0) list = list.filter((e) => wlSet.has(e.ticker));
    if (bookOnly && bookSet.size > 0) list = list.filter((e) => bookSet.has(e.ticker));
    return list.slice(0, 24);
  }, [data, active, wlOnly, wlSet, bookOnly, bookSet]);

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
        <div className="flex items-center gap-2">
          {wlSet.size > 0 && (
            <button
              type="button"
              onClick={() => setWlOnly((v) => !v)}
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded border border-[#d4af37]/20",
                wlOnly ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
              )}
              title="Filter rating chips to your watchlist tickers"
            >
              Watchlist
            </button>
          )}
          {bookSet.size > 0 && (
            <button
              type="button"
              onClick={() => setBookOnly((v) => !v)}
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded border border-[#d4af37]/20",
                bookOnly ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
              )}
              title="Filter rating chips to open pm_book tickers"
            >
              Book
            </button>
          )}
          <div className="flex rounded border border-[#d4af37]/20 overflow-hidden">
            {(["eps", "pt"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={cn(
                  "text-[10px] font-semibold px-2 py-0.5 uppercase",
                  metric === m ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                )}
              >
                {m}
              </button>
            ))}
          </div>
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
            <Line
              type="monotone"
              dataKey="breadth"
              stroke={metric === "pt" ? "#fbbf24" : "#38bdf8"}
              dot={false}
              strokeWidth={1.5}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {events.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5 max-h-[72px] overflow-y-auto">
          {events.map((e, i) => (
            <span
              key={`${e.date}-${e.ticker}-${e.firm}-${i}`}
              title={`${e.firm ?? "?"} · ${e.fromGrade ?? "?"} → ${e.toGrade ?? "?"} · ${e.date}`}
              className={cn(
                "text-[10px] font-mono px-1.5 py-0.5 rounded border",
                e.action === "upgrade"
                  ? "text-emerald-300 border-emerald-600/40 bg-emerald-950/40"
                  : "text-rose-300 border-rose-600/40 bg-rose-950/40",
              )}
            >
              {e.date.slice(5)} {e.ticker} {e.action === "upgrade" ? "↑" : "↓"}
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-amber-200/35 px-3 pb-2">
        Line = {metric === "pt" ? "PT mean 30d % change" : "FY1 EPS 30d drift"} breadth (up − down).
        Chips = rating up/down only. Display only until S0xx.
      </p>
    </div>
  );
}
