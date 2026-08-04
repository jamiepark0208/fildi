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

interface TickerSideAgg {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnlPct: number | null;
  pending: number;
  noData: number;
}

interface CurrentPick {
  strike: number;
  expiry: string;
  premium: number;
  incomePct: number | null;
  dte: number | null;
}

interface TickerSummaryRow {
  ticker: string;
  put: TickerSideAgg;
  call: TickerSideAgg;
  currentPrice: number | null;
  priceChangePct: number | null;
  currentPut: CurrentPick | null;
  currentCall: CurrentPick | null;
}

const PUT_BG = "bg-sky-500/10";
const CALL_BG = "bg-orange-500/10";

/** "2026-08-07" → "8/7" */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${parseInt(m!, 10)}/${parseInt(d!, 10)}`;
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
      <span className="text-[11px] text-sky-200">
        {summary.wins}/{summary.n} · avg {signed(summary.avgPnlPct)}
      </span>
    </StatChip>
  );
}

function HotlistCard({ hotlist }: { hotlist: HotlistSummary[] }) {
  const goRows = hotlist.filter(h => h.signal === "GO");
  return (
    <StatChip dot="#fb7185" label="Hotlist GO">
      <span className="text-[11px] text-sky-200 ml-auto truncate">
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
      <span className="text-[11px] text-sky-200">correct</span>
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
                side === s ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white hover:text-[#d4af37]",
              )}
            >
              {s}s
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0">
        {summary.equityCurve.length === 0 ? (
          <div className="h-[70px] flex items-center justify-center text-xs text-zinc-400">
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
  if (v == null) return "bg-white/5 text-zinc-400";
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
          <div className="text-xs text-zinc-400 py-2 text-center">No regime grades yet</div>
        ) : (
          regimes.map(regime => (
            <div key={regime} className="flex items-center gap-2 text-xs">
              <span className="capitalize text-sky-200 w-20 shrink-0 truncate">{regime.replace(/_/g, " ")}</span>
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

function SideAggCells({ agg, bg }: { agg: TickerSideAgg; bg: string }) {
  if (agg.n === 0) {
    return (
      <>
        <td className={cn("px-3 py-1.5 text-center text-zinc-500", bg)}>—</td>
        <td className={cn("px-3 py-1.5 text-center text-zinc-500", bg)}>—</td>
        <td className={cn("px-3 py-1.5 text-center text-zinc-500", bg)}>
          {agg.pending > 0 ? `${agg.pending} pending` : "—"}
        </td>
      </>
    );
  }
  return (
    <>
      <td className={cn("px-3 py-1.5 text-center font-mono text-white", bg)}>
        {agg.wins}W-{agg.losses}L
      </td>
      <td className={cn("px-3 py-1.5 text-center font-mono font-semibold", bg, agg.winRate != null && agg.winRate >= 0.5 ? "text-green-400" : "text-red-400")}>
        {pct(agg.winRate)}
      </td>
      <td className={cn("px-3 py-1.5 text-center font-mono", bg, agg.avgPnlPct != null && agg.avgPnlPct >= 0 ? "text-green-400" : "text-red-400")}>
        {agg.avgPnlPct != null ? signed(agg.avgPnlPct) : "—"}
      </td>
    </>
  );
}

function RecCell({ pick, color, bg }: { pick: CurrentPick | null; color: string; bg: string }) {
  if (!pick) return <td className={cn("px-3 py-1.5 text-center text-zinc-500", bg)}>—</td>;
  return (
    <td className={cn("px-3 py-1.5 text-center font-mono text-xs whitespace-nowrap", bg)}>
      <span className="font-bold" style={{ color }}>${pick.strike}</span>
      <span className="text-white"> · {shortDate(pick.expiry)}</span>
      {pick.incomePct != null && <span className="text-green-400 font-semibold"> · {pick.incomePct.toFixed(1)}%</span>}
    </td>
  );
}

function PriceCell({ price, changePct }: { price: number | null; changePct: number | null }) {
  if (price == null) return <td className="px-3 py-1.5 text-center text-zinc-500">—</td>;
  const up = changePct != null && changePct >= 0;
  return (
    <td className="px-3 py-1.5 text-center font-mono whitespace-nowrap">
      <span className="text-white font-semibold">${price.toFixed(2)}</span>
      {changePct != null && (
        <span className={cn("ml-1.5 text-xs font-bold", up ? "text-green-400" : "text-red-400")}>
          {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}%
        </span>
      )}
    </td>
  );
}

function TickerSummaryTable({ rows }: { rows: TickerSummaryRow[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-[#d4af37] uppercase tracking-wide">By Ticker</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-400 py-4 text-center">No graded recs yet</p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th rowSpan={2} className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5 align-bottom">Ticker</th>
                <th rowSpan={2} className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5 align-bottom">Price</th>
                <th colSpan={4} className={cn("text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1 border-b border-[#d4af37]/10 text-sky-200", PUT_BG)}>Put</th>
                <th colSpan={4} className={cn("text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1 border-b border-[#d4af37]/10 text-orange-300", CALL_BG)}>Call</th>
              </tr>
              <tr className="border-b border-[#d4af37]/25">
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", PUT_BG)}>W-L</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", PUT_BG)}>Win%</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", PUT_BG)}>Avg P&L</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", PUT_BG)}>This/Next Wk Rec</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", CALL_BG)}>W-L</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", CALL_BG)}>Win%</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", CALL_BG)}>Avg P&L</th>
                <th className={cn("text-center font-semibold text-[10px] uppercase tracking-wider px-3 py-1", CALL_BG)}>This/Next Wk Rec</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map(r => (
                <tr key={r.ticker} className="bg-zinc-900/70 even:bg-zinc-800/60 transition-colors">
                  <td className="px-3 py-1.5 font-mono font-semibold text-white">{r.ticker}</td>
                  <PriceCell price={r.currentPrice} changePct={r.priceChangePct} />
                  <SideAggCells agg={r.put} bg={PUT_BG} />
                  <RecCell pick={r.currentPut} color="#7dd3fc" bg={PUT_BG} />
                  <SideAggCells agg={r.call} bg={CALL_BG} />
                  <RecCell pick={r.currentCall} color="#fdba74" bg={CALL_BG} />
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

  const { data: tickerSummary } = useQuery({
    queryKey: ["track-record", "ticker-summary"],
    queryFn: async (): Promise<TickerSummaryRow[]> => {
      const res = await fetch("/api/track-record/ticker-summary");
      if (!res.ok) throw new Error("track-record ticker-summary fetch failed");
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
          <div className="text-xs text-zinc-400 py-10 text-center">Loading track record…</div>
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

            <TickerSummaryTable rows={tickerSummary ?? []} />
          </>
        )}
      </main>
    </div>
  );
}
