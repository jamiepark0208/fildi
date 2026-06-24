import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { Sidebar } from "@/components/sidebar";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface COTRecord {
  date: string;
  instrument: string;
  displayName: string;
  dataset: "tff" | "legacy";
  openInterest: number;
  levMoneyLong: number;
  levMoneyShort: number;
  levMoneyNet: number;
  levMoneyLongChg: number;
  levMoneyShortChg: number;
  assetMgrLong: number;
  assetMgrShort: number;
  assetMgrNet: number;
  assetMgrLongChg: number;
  assetMgrShortChg: number;
  dealerLong: number;
  dealerShort: number;
  dealerNet: number;
}

interface COTSummary {
  instrument: string;
  displayName: string;
  dataset: "tff" | "legacy";
  latest: COTRecord;
  history: COTRecord[];
  zScore: number;
  stale?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function chgColor(n: number) {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-muted-foreground";
}

function zBadge(z: number) {
  const abs = Math.abs(z);
  if (abs < 1) return null;
  const label = z > 0 ? "Extreme Long" : "Extreme Short";
  const cls = abs > 1.5
    ? z > 0 ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
             : "bg-red-500/20 text-red-300 border-red-500/30"
    : "bg-yellow-500/15 text-yellow-300 border-yellow-500/20";
  return (
    <span className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded border", cls)}>
      {label}
    </span>
  );
}

// Mini sparkline for the summary cards
function Sparkline({ data, field }: { data: COTRecord[]; field: "levMoneyNet" | "assetMgrNet" }) {
  if (data.length < 2) return null;
  const vals = data.map(r => ({ v: r[field] }));
  const min = Math.min(...vals.map(v => v.v));
  const max = Math.max(...vals.map(v => v.v));
  const lastPositive = (vals[vals.length - 1]?.v ?? 0) >= 0;
  return (
    <ResponsiveContainer width="100%" height={32}>
      <LineChart data={vals} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <YAxis domain={[min, max]} hide />
        <Line
          type="monotone"
          dataKey="v"
          dot={false}
          strokeWidth={1.5}
          stroke={lastPositive ? "#34d399" : "#f87171"}
          isAnimationActive={false}
        />
        <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="2 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ s, selected, onClick }: { s: COTSummary; selected: boolean; onClick: () => void }) {
  const net = s.latest.levMoneyNet;
  const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
  const Icon = chg > 0 ? TrendingUp : chg < 0 ? TrendingDown : Minus;
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border p-3 transition-all",
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card hover:border-border/80 hover:bg-card/80"
      )}
    >
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-semibold text-foreground truncate">{s.displayName}</span>
        {zBadge(s.zScore)}
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <div className={cn("text-sm font-bold", net >= 0 ? "text-emerald-400" : "text-red-400")}>
            {net >= 0 ? "+" : ""}{fmt(net)}
          </div>
          <div className={cn("flex items-center gap-1 text-[10px]", chgColor(chg))}>
            <Icon className="w-2.5 h-2.5" />
            {chg >= 0 ? "+" : ""}{fmt(chg)} WoW
          </div>
        </div>
        <div className="w-20 shrink-0">
          <Sparkline data={s.history} field="levMoneyNet" />
        </div>
      </div>
    </button>
  );
}

// ── History Chart ─────────────────────────────────────────────────────────────

const WEEKS_OPTIONS = [12, 26, 52] as const;

function HistoryChart({ history }: { history: COTRecord[] }) {
  const [weeks, setWeeks] = useState<12 | 26 | 52>(26);
  const data = history.slice(-weeks).map(r => ({
    date: r.date.slice(5), // MM-DD
    "Lev. Money": r.levMoneyNet,
    "Asset Mgr": r.assetMgrNet,
    "Dealer": r.dealerNet,
  }));

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Net Positioning History</h3>
          <p className="text-[10px] text-muted-foreground">Net contracts (long − short) by trader category</p>
        </div>
        <div className="flex gap-1">
          {WEEKS_OPTIONS.map(w => (
            <button
              key={w}
              onClick={() => setWeeks(w)}
              className={cn(
                "text-[10px] px-2 py-1 rounded font-medium transition-colors",
                weeks === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {w}W
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#888" }} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: "#888" }} tickLine={false} axisLine={false}
            tickFormatter={v => fmt(v)} width={48} />
          <Tooltip
            contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
            formatter={(v: number, name: string) => [fmt(v), name]}
          />
          <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="Lev. Money" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="Asset Mgr" stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="Dealer" stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="4 2" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] text-muted-foreground">
        <div><span className="inline-block w-2 h-0.5 bg-amber-400 mr-1 align-middle" />Leveraged Money = hedge funds (contrarian at extremes)</div>
        <div><span className="inline-block w-2 h-0.5 bg-blue-400 mr-1 align-middle" />Asset Manager = institutions (trend-following)</div>
        <div><span className="inline-block w-2 h-0.5 bg-violet-400 mr-1 align-middle" />Dealer = market makers (opposite of client flow)</div>
      </div>
    </div>
  );
}

// ── Category Breakdown ────────────────────────────────────────────────────────

function CategoryBreakdown({ record }: { record: COTRecord }) {
  const data = [
    {
      name: "Lev. Money",
      Long: record.levMoneyLong,
      Short: -record.levMoneyShort,
    },
    {
      name: "Asset Mgr",
      Long: record.assetMgrLong,
      Short: -record.assetMgrShort,
    },
    {
      name: "Dealer",
      Long: record.dealerLong,
      Short: -record.dealerShort,
    },
  ];
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground mb-0.5">Position Breakdown</h3>
      <p className="text-[10px] text-muted-foreground mb-3">Latest week — long vs short by category</p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
          <XAxis type="number" tick={{ fontSize: 9, fill: "#888" }} tickLine={false} tickFormatter={v => fmt(Math.abs(v))} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#ccc" }} tickLine={false} axisLine={false} width={68} />
          <Tooltip
            contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
            formatter={(v: number) => fmt(Math.abs(v))}
          />
          <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
          <Bar dataKey="Long" fill="#34d399" isAnimationActive={false} radius={[0, 3, 3, 0]} />
          <Bar dataKey="Short" fill="#f87171" isAnimationActive={false} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Extremes Table ────────────────────────────────────────────────────────────

function ExtremesTable({ summaries, onSelect }: { summaries: COTSummary[]; onSelect: (id: string) => void }) {
  const sorted = [...summaries].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Positioning Extremes</h3>
        <p className="text-[10px] text-muted-foreground">Ranked by Z-score vs 52-week range (hedge fund positioning)</p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
            <th className="text-left px-4 py-2">Instrument</th>
            <th className="text-right px-3 py-2">Net</th>
            <th className="text-right px-3 py-2">WoW Chg</th>
            <th className="text-right px-4 py-2">Z-Score</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => {
            const net = s.latest.levMoneyNet;
            const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
            const z = s.zScore;
            return (
              <tr
                key={s.instrument}
                onClick={() => onSelect(s.instrument)}
                className="border-b border-border/50 hover:bg-white/5 cursor-pointer transition-colors"
              >
                <td className="px-4 py-2.5 font-medium text-foreground">
                  <div className="flex items-center gap-2">
                    {s.displayName}
                    {zBadge(z)}
                  </div>
                </td>
                <td className={cn("px-3 py-2.5 text-right font-mono", net >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {net >= 0 ? "+" : ""}{fmt(net)}
                </td>
                <td className={cn("px-3 py-2.5 text-right font-mono", chgColor(chg))}>
                  {chg >= 0 ? "+" : ""}{fmt(chg)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={cn(
                    "font-mono font-semibold",
                    Math.abs(z) > 1.5 ? z > 0 ? "text-emerald-400" : "text-red-400"
                    : Math.abs(z) > 1 ? "text-yellow-400" : "text-muted-foreground"
                  )}>
                    {z >= 0 ? "+" : ""}{z.toFixed(2)}σ
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Sentiment() {
  const [selectedInstrument, setSelectedInstrument] = useState("sp500");

  const { data: summaries, isLoading, isError, dataUpdatedAt } = useQuery<COTSummary[]>({
    queryKey: ["cot-summary"],
    queryFn: () => fetch("/api/cot/summary").then(r => r.json()),
    staleTime: 60 * 60 * 1000, // 1h — data is weekly
  });

  const { data: history } = useQuery<COTRecord[]>({
    queryKey: ["cot-history", selectedInstrument],
    queryFn: () => fetch(`/api/cot/history?instrument=${selectedInstrument}&weeks=52`).then(r => r.json()),
    staleTime: 60 * 60 * 1000,
    enabled: !!selectedInstrument,
  });

  const selected = summaries?.find(s => s.instrument === selectedInstrument);

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto" style={{ marginLeft: "var(--sidebar-w, 220px)" }}>
        <div className="max-w-6xl mx-auto px-6 py-8">

          {/* Header */}
          <div className="mb-6">
            <h1 className="text-xl font-bold text-foreground">COT Positioning</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              CFTC Commitments of Traders — weekly futures positioning by trader category
              {dataUpdatedAt ? (
                <span className="ml-2 text-[10px] text-muted-foreground/60">
                  cached {new Date(dataUpdatedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </p>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading COT data from CFTC…
            </div>
          )}

          {isError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              Failed to load COT data. CFTC API may be temporarily unavailable.
            </div>
          )}

          {summaries && (
            <>
              {/* Stale warning */}
              {summaries[0]?.stale && (
                <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
                  Showing cached data — CFTC API unavailable
                </div>
              )}

              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mb-6">
                {summaries.map(s => (
                  <SummaryCard
                    key={s.instrument}
                    s={s}
                    selected={selectedInstrument === s.instrument}
                    onClick={() => setSelectedInstrument(s.instrument)}
                  />
                ))}
              </div>

              {/* Selected instrument detail */}
              {selected && history && (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-sm font-semibold text-foreground">{selected.displayName}</h2>
                    <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
                      {selected.dataset === "tff" ? "Financial Futures" : "Commodity Futures"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      as of {selected.latest.date}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2">
                      <HistoryChart history={history} />
                    </div>
                    <div>
                      <CategoryBreakdown record={selected.latest} />
                      {/* Quick stats */}
                      <div className="mt-3 rounded-lg border border-border bg-card p-3 grid grid-cols-2 gap-2">
                        {[
                          { label: "Open Interest", val: fmt(selected.latest.openInterest) },
                          { label: "HF Net", val: `${selected.latest.levMoneyNet >= 0 ? "+" : ""}${fmt(selected.latest.levMoneyNet)}` },
                          { label: "HF WoW", val: `${(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg) >= 0 ? "+" : ""}${fmt(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg)}` },
                          { label: "Z-Score", val: `${selected.zScore >= 0 ? "+" : ""}${selected.zScore.toFixed(2)}σ` },
                        ].map(({ label, val }) => (
                          <div key={label}>
                            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
                            <div className="text-xs font-semibold text-foreground">{val}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Extremes table */}
              <ExtremesTable summaries={summaries} onSelect={setSelectedInstrument} />

              {/* Data source note */}
              <p className="mt-4 text-[10px] text-muted-foreground/50">
                Data: CFTC Public Reporting Environment · Released weekly (Friday) for prior Tuesday snapshot ·
                Leveraged Money = hedge funds · Asset Manager = institutional investors
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
