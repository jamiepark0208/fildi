// Proves the model's own accountability record: graded put/call sell recs, Live-tab
// hotlist dip/rally calls, and business-cycle regime calls — plus the bounded
// auto-tilt those grades feed back into the scorer's default strike weights.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip,
} from "recharts";
import { TopNav } from "@/components/top-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SideSummary {
  n: number;
  wins: number;
  winRate: number | null;
  avgPnlPct: number | null;
  totalPnlPct: number | null;
  pending: number;
  noData: number;
  equityCurve: Array<{ expiry: string; pnlPct: number; cumPnlPct: number; ticker: string }>;
}

interface HotlistSummary {
  side: string;
  signal: string;
  n: number;
  wins: number;
  winRate: number | null;
  avgFwdReturn5d: number | null;
  pending: number;
}

interface SummaryResponse {
  put: SideSummary;
  call: SideSummary;
  hotlist: HotlistSummary[];
  generatedAt: number;
}

interface RegimeCell {
  regime: string;
  horizon: string;
  expectedDirection: string;
  n: number;
  correct: number;
  partial: number;
  incorrect: number;
  pending: number;
  noData: number;
  correctPct: number | null;
  avgFwdReturnPct: number | null;
  avgMaxDrawdownPct: number | null;
}

interface RegimeResponse {
  grid: RegimeCell[];
  generatedAt: number;
}

interface ModelRec {
  id: number;
  snapshotDate: string;
  ticker: string;
  side: string;
  expiry: string;
  strike: string;
  premium: string;
  status: string;
  pnlPct: string | null;
  macroRegime: string | null;
}

const HORIZON_ORDER = ["1w", "4w", "12w"];

function pct(v: number | null, digits = 0): string {
  return v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function signed(v: number | null, digits = 1): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function StatChip({ dot, label, children }: { dot: string; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 bg-zinc-950 border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 flex-1 min-w-[150px]">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
      <span className="text-[11px] font-semibold text-[#d4af37] shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ScoreCard({ title, summary, color }: { title: string; summary: SideSummary; color: string }) {
  return (
    <StatChip dot={color} label={title}>
      <span className="text-sm font-bold text-white ml-auto">{pct(summary.winRate)}</span>
      <span className="text-[11px] text-sky-300/70">
        {summary.wins}/{summary.n} · avg {signed(summary.avgPnlPct)}
      </span>
    </StatChip>
  );
}

function HotlistCard({ hotlist }: { hotlist: HotlistSummary[] }) {
  const goRows = hotlist.filter(h => h.signal === "GO");
  return (
    <StatChip dot="#fb7185" label="Hotlist GO">
      <span className="text-[11px] text-sky-300/70 ml-auto truncate">
        {goRows.map(h => `${h.side} ${pct(h.winRate)} (${h.wins}/${h.n})`).join(" · ")}
      </span>
    </StatChip>
  );
}

function RegimeCard({ grid }: { grid: RegimeCell[] }) {
  const overall = useMemo(() => {
    const graded = grid.filter(c => c.n > 0);
    if (graded.length === 0) return null;
    const totalN = graded.reduce((s, c) => s + c.n, 0);
    const totalCorrect = graded.reduce((s, c) => s + c.correct, 0);
    return totalN > 0 ? totalCorrect / totalN : null;
  }, [grid]);

  return (
    <StatChip dot="#a78bfa" label="Regime">
      <span className="text-sm font-bold text-white ml-auto">{pct(overall)}</span>
      <span className="text-[11px] text-sky-300/70">correct</span>
    </StatChip>
  );
}

function EquityCurve({ put, call }: { put: SideSummary; call: SideSummary }) {
  const [side, setSide] = useState<"put" | "call">("put");
  const summary = side === "put" ? put : call;
  const color = side === "put" ? "#38bdf8" : "#fbbf24";

  return (
    <Card className="bg-zinc-950 border-[#d4af37]/20">
      <CardHeader className="px-3 py-1.5 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-xs text-[#d4af37]">Cumulative P&L</CardTitle>
        <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
          {(["put", "call"] as const).map(s => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={cn(
                "px-2 py-0.5 capitalize transition-colors",
                side === s ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
              )}
            >
              {s}s
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0">
        {summary.equityCurve.length === 0 ? (
          <div className="h-[70px] flex items-center justify-center text-xs text-amber-200/40">
            No graded {side}s yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={70}>
            <AreaChart data={summary.equityCurve} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="trackRecordGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="expiry" tick={{ fontSize: 9, fill: "#7dd3fc" }} />
              <YAxis
                tick={{ fontSize: 9, fill: "#7dd3fc" }}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              />
              <Tooltip
                contentStyle={{ background: "#09090b", border: "1px solid #d4af3740", fontSize: 11 }}
                formatter={(v: number, key: string) => [`${v.toFixed(2)}%`, key === "cumPnlPct" ? "Cumulative" : key]}
                labelFormatter={(_: string, payload) => {
                  const p = payload?.[0]?.payload as { ticker?: string; expiry?: string } | undefined;
                  return p ? `${p.ticker} · exp ${p.expiry}` : "";
                }}
              />
              <Area type="monotone" dataKey="cumPnlPct" stroke={color} fill="url(#trackRecordGrad)" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function correctPctColor(v: number | null): string {
  if (v == null) return "bg-white/5 text-amber-200/40";
  if (v >= 0.66) return "bg-emerald-600 text-white";
  if (v >= 0.4) return "bg-amber-500 text-black";
  return "bg-rose-600 text-white";
}

function RegimeGrid({ grid }: { grid: RegimeCell[] }) {
  const regimes = useMemo(
    () => [...new Set(grid.map(c => c.regime))].sort(),
    [grid],
  );
  const cellFor = (regime: string, horizon: string) =>
    grid.find(c => c.regime === regime && c.horizon === horizon);

  return (
    <Card className="bg-zinc-950 border-[#d4af37]/20">
      <CardHeader className="px-3 py-1.5">
        <CardTitle className="text-xs text-[#d4af37]">Regime Accuracy</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0 space-y-1">
        {regimes.length === 0 ? (
          <div className="text-xs text-amber-200/40 py-2 text-center">No regime grades yet</div>
        ) : (
          regimes.map(regime => (
            <div key={regime} className="flex items-center gap-2 text-xs">
              <span className="capitalize text-sky-300/70 w-20 shrink-0 truncate">{regime.replace(/_/g, " ")}</span>
              <div className="flex items-center gap-1.5">
                {HORIZON_ORDER.map(horizon => {
                  const cell = cellFor(regime, horizon);
                  return (
                    <div key={horizon} className={cn("rounded px-1.5 py-0.5 flex items-center gap-1", correctPctColor(cell?.correctPct ?? null))}>
                      <span className="opacity-70">{horizon}</span>
                      {cell && cell.n > 0 ? (
                        <>
                          <span className="font-semibold">{pct(cell.correctPct)}</span>
                          <span className="text-[10px] opacity-70">n={cell.n}</span>
                        </>
                      ) : (
                        <span className="opacity-50">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function statusColor(status: string): string {
  if (status === "WIN") return "bg-emerald-600 text-white";
  if (status === "LOSS") return "bg-rose-600 text-white";
  if (status === "NO_DATA") return "bg-white/10 text-amber-200/40";
  return "bg-amber-500 text-black";
}

function RecentRecsTable({ recs }: { recs: ModelRec[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-[#d4af37] uppercase tracking-wide">Recent Recs</h2>
      {recs.length === 0 ? (
        <p className="text-xs text-amber-200/40 py-4 text-center">No recs yet</p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Ticker</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Side</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Snapshot</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Expiry</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Strike</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Premium</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">P&L</th>
                <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {recs.map(r => (
                <tr key={r.id} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-3 py-1.5 font-mono font-semibold text-white">{r.ticker}</td>
                  <td className="px-3 py-1.5 capitalize font-mono text-sky-300/80">{r.side}</td>
                  <td className="px-3 py-1.5 font-mono text-sky-300/80">{r.snapshotDate}</td>
                  <td className="px-3 py-1.5 font-mono text-sky-300/80">{r.expiry}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-400">{parseFloat(r.strike).toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-white">{parseFloat(r.premium).toFixed(2)}</td>
                  <td className={cn("px-3 py-1.5 text-right font-mono font-semibold", r.pnlPct != null && parseFloat(r.pnlPct) >= 0 ? "text-green-400" : "text-red-400")}>
                    {r.pnlPct != null ? signed(parseFloat(r.pnlPct)) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <Badge variant="outline" className={cn("text-[10px] border-0", statusColor(r.status))}>
                      {r.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function TrackRecord() {
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["track-record", "summary"],
    queryFn: async (): Promise<SummaryResponse> => {
      const res = await fetch("/api/track-record/summary");
      if (!res.ok) throw new Error("track-record summary fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
  });

  const { data: regime } = useQuery({
    queryKey: ["track-record", "regime"],
    queryFn: async (): Promise<RegimeResponse> => {
      const res = await fetch("/api/track-record/regime");
      if (!res.ok) throw new Error("track-record regime fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
  });

  const { data: recs } = useQuery({
    queryKey: ["track-record", "recs"],
    queryFn: async (): Promise<ModelRec[]> => {
      const res = await fetch("/api/track-record/recs?limit=20");
      if (!res.ok) throw new Error("track-record recs fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  return (
    <div className="min-h-screen bg-zinc-900">
      <TopNav />
      <main className="pt-14 p-6 space-y-2.5 max-w-5xl mx-auto">
        <h1 className="text-lg font-bold text-[#d4af37]">Track Record</h1>

        {summaryLoading || !summary ? (
          <div className="text-xs text-amber-200/40 py-10 text-center">Loading track record…</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <ScoreCard title="Puts" summary={summary.put} color="#38bdf8" />
              <ScoreCard title="Calls" summary={summary.call} color="#fbbf24" />
              <HotlistCard hotlist={summary.hotlist} />
              <RegimeCard grid={regime?.grid ?? []} />
            </div>

            <EquityCurve put={summary.put} call={summary.call} />

            <RegimeGrid grid={regime?.grid ?? []} />

            <RecentRecsTable recs={recs ?? []} />
          </>
        )}
      </main>
    </div>
  );
}
