// Proves the model's own accountability record: graded put/call sell recs, Live-tab
// hotlist dip/rally calls, and business-cycle regime calls — plus the bounded
// auto-tilt those grades feed back into the scorer's default strike weights.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip,
} from "recharts";
import { AppPage } from "@/components/app-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TickerDrilldown } from "@/components/track-record/ticker-drilldown";
import { StrategiesTab } from "@/components/track-record/strategies-tab";
import { JournalTab } from "@/components/track-record/journal-tab";
import { AnimatedNumber } from "@/components/animated-number";
import { useAuth } from "@/context/AuthContext";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { GRADED_REC_WIN_RATE } from "@/lib/track-record-labels";

interface SideSummary {
  n: number;
  wins: number;
  winRate: number | null;
  avgPnlPct: number | null;
  totalPnlPct: number | null;
  capitalWeightedAvgPnlPct?: number | null;
  maxDrawdownPct?: number | null;
  pending: number;
  assigned?: number;
  noData: number;
  equityCurve: Array<{
    expiry: string;
    pnlPct: number;
    cumPnlPct: number;
    premiumCumPnlPct?: number;
    capitalCumPnlPct?: number;
    ticker: string;
  }>;
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
  calibration?: {
    put: Array<{ lo: number; hi: number; n: number; avgPnlPct: number }>;
    call: Array<{ lo: number; hi: number; n: number; avgPnlPct: number }>;
    version: number;
  } | null;
  secondary?: { hotlistThin: boolean; minHotlistN: number };
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
  avgIncomePct?: number | null;
  avgAbsMovePct?: number | null;
  avgAdverseMovePct?: number | null;
  /** Avg path MAE (daily high/low) against the short. */
  avgMaxAdversePct?: number | null;
  /** Avg % of OTM cushion consumed on the path. */
  avgCushionUsedPct?: number | null;
  /** mean(pnl) / stdev(pnl) — higher = more consistent edge (n≥3). */
  sharpe?: number | null;
}

interface CurrentPick {
  strike: number;
  expiry: string;
  premium: number;
  incomePct: number | null;
  dte: number | null;
  snapshotDate: string;
  spot: number;
  maxAdversePct?: number | null;
  cushionUsedPct?: number | null;
  delta?: number | null;
  strikeIv?: number | null;
}

/** Same board as Options Rankings (Overall nightly snapshot). */
interface RankPick {
  strike: number;
  expiry: string;
  spot: number;
  premium: number;
  optionScore: number;
  rank: number;
  dte: number | null;
  delta: number | null;
  asOf: string;
}

interface TickerSummaryRow {
  ticker: string;
  put: TickerSideAgg;
  call: TickerSideAgg;
  currentPrice: number | null;
  priceChangePct: number | null;
  currentPut: CurrentPick | null;
  currentCall: CurrentPick | null;
  rankPut: RankPick | null;
  rankCall: RankPick | null;
}

/** Graded history header tint */
const PUT_HEAD = "bg-zinc-900 text-white border-b border-sky-400/50";
const CALL_HEAD = "bg-zinc-900 text-white border-b border-orange-400/50";
/** Model's live best-rec columns — distinct wash so users see "this is the pick" */
const PUT_REC_HEAD = "bg-zinc-900 text-white border-b border-emerald-400/60";
const CALL_REC_HEAD = "bg-zinc-900 text-white border-b border-amber-400/60";
const PUT_REC_BODY = "bg-emerald-500/[0.06]";
const CALL_REC_BODY = "bg-amber-500/[0.06]";
const PUT_EDGE = "border-l border-sky-500/25";
const CALL_EDGE = "border-l border-orange-500/25";
const PUT_REC_EDGE = "border-l border-emerald-500/35";
const CALL_REC_EDGE = "border-l border-amber-500/35";

const TH = "font-semibold text-[9px] uppercase tracking-wide px-1 py-0.5";
const TH_SUB = "font-semibold text-[8px] uppercase tracking-wide px-1 py-0.5";
const TD = "px-1 py-0.5 font-mono text-[10px] leading-tight";

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

function StatChip({
  dot, label, title, children,
}: { dot: string; label: string; title?: string; children: ReactNode }) {
  return (
    <div
      title={title}
      className="flex items-center gap-1.5 bg-zinc-950 border border-[#d4af37]/15 rounded px-2 py-1 flex-1 min-w-0"
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
      <span className="text-[10px] font-semibold text-[#d4af37] shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ScoreCard({ title, summary, color }: { title: string; summary: SideSummary; color: string }) {
  const exp = summary.capitalWeightedAvgPnlPct ?? summary.avgPnlPct;
  return (
    <StatChip
      dot={color}
      label={title}
      title={`Model sell-option expectancy (capital-weighted avg P&L on graded recs). Primary accountability signal. · ${GRADED_REC_WIN_RATE}`}
    >
      <span className={cn(
        "text-[12px] font-bold ml-auto font-mono tabular-nums",
        exp != null && exp >= 0 ? "text-green-400" : "text-red-400",
      )}>
        {exp == null ? "—" : (
          <AnimatedNumber
            value={exp * 100}
            format={(n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`}
          />
        )}
      </span>
      <span className="text-[10px] text-sky-200/70 whitespace-nowrap" title={GRADED_REC_WIN_RATE}>
        n={summary.n} · wr {pct(summary.winRate)}
      </span>
    </StatChip>
  );
}

function HotlistCard({ hotlist, thin }: { hotlist: HotlistSummary[]; thin?: boolean }) {
  const goRows = hotlist.filter(h => h.signal === "GO");
  const totalN = goRows.reduce((s, h) => s + h.n, 0);
  return (
    <StatChip
      dot="#fb7185"
      label="Hotlist"
      title="Live-tab GO signals graded on forward returns. Secondary until n≥20 — not the main model score."
    >
      <span className="text-[10px] text-sky-200/60 ml-auto truncate">
        {thin || totalN < 20
          ? `n=${totalN} (secondary)`
          : goRows.map(h => `${h.side[0]} ${pct(h.winRate)}`).join(" · ")}
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
    return { pct: totalN > 0 ? totalCorrect / totalN : null, n: totalN };
  }, [grid]);

  const thin = !overall || overall.n < 15;
  return (
    <StatChip
      dot="#a78bfa"
      label="Regime"
      title="Macro-regime direction calls graded later. Secondary until sample matures."
    >
      {thin ? (
        <span className="text-[10px] text-sky-200/60 ml-auto">n={overall?.n ?? 0}</span>
      ) : (
        <span className="text-[12px] font-bold text-white ml-auto font-mono">{pct(overall.pct)} <span className="text-[10px] font-normal text-sky-200/60">n={overall.n}</span></span>
      )}
    </StatChip>
  );
}

function EquityCurve({ put, call }: { put: SideSummary; call: SideSummary }) {
  const [side, setSide] = useState<"put" | "call">("put");
  // A92 — default all-in (day-10 assignment); premium-only is the old chart.
  const [mode, setMode] = useState<"allIn" | "premium">("allIn");
  const summary = side === "put" ? put : call;
  const color = side === "put" ? "#38bdf8" : "#fbbf24";
  const dataKey = mode === "allIn" ? "cumPnlPct" : "premiumCumPnlPct";

  return (
    <Card className="bg-zinc-950 border-[#d4af37]/20">
      <CardHeader className="px-3 py-1.5 flex-row items-center justify-between space-y-0 gap-2">
        <CardTitle className="text-xs text-[#d4af37]">Cumulative P&L</CardTitle>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {([
              { id: "allIn" as const, label: "All-in" },
              { id: "premium" as const, label: "Premium" },
            ]).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                title={m.id === "allIn" ? "Includes day-10 stock leg after assignment" : "Option premium only"}
                className={cn(
                  "px-2 py-0.5 transition-colors",
                  mode === m.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white hover:text-[#d4af37]",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {(["put", "call"] as const).map(s => (
              <button
                key={s}
                type="button"
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
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0">
        {(summary.assigned ?? 0) > 0 && (
          <p className="text-[10px] text-amber-200/50 mb-1">{summary.assigned} assigned — stock leg open (day-10 pending)</p>
        )}
        {summary.equityCurve.length === 0 ? (
          <div className="h-[70px] flex items-center justify-center text-xs text-amber-100">
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
                formatter={(v: number, key: string) => {
                  const label =
                    key === "cumPnlPct" ? "All-in cum"
                      : key === "premiumCumPnlPct" ? "Premium cum"
                        : key === "capitalCumPnlPct" ? "Capital-wtd"
                          : key;
                  return [`${Number(v).toFixed(2)}%`, label];
                }}
                labelFormatter={(_: string, payload) => {
                  const p = payload?.[0]?.payload as { ticker?: string; expiry?: string } | undefined;
                  return p ? `${p.ticker} · exp ${p.expiry}` : "";
                }}
              />
              <Area type="monotone" dataKey={dataKey} stroke={color} fill="url(#trackRecordGrad)" dot={false} strokeWidth={1.5} />
              {mode === "allIn" && summary.equityCurve.some(p => p.capitalCumPnlPct != null) && (
                <Area type="monotone" dataKey="capitalCumPnlPct" stroke="#a78bfa" fill="none" dot={false} strokeWidth={1} strokeDasharray="4 3" />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function correctPctColor(v: number | null): string {
  if (v == null) return "bg-white/5 text-amber-100";
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
          <div className="text-xs text-amber-100 py-2 text-center">No regime grades yet</div>
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

const SHARPE_MIN_N = 3;

function pathAdv(agg: TickerSideAgg): number | null {
  return agg.avgMaxAdversePct ?? agg.avgAdverseMovePct ?? null;
}

function sideExplain(agg: TickerSideAgg, side: "put" | "call"): string {
  if (agg.n === 0) {
    return agg.pending > 0
      ? `${side}: ${agg.pending} pending — not graded yet`
      : `${side}: no graded recs yet`;
  }
  const parts = [
    `${side.toUpperCase()} graded n=${agg.n}`,
    `${agg.wins}W-${agg.losses}L (wr ${pct(agg.winRate)})`,
    `avg P&L ${agg.avgPnlPct != null ? signed(agg.avgPnlPct) : "—"}`,
  ];
  if (agg.n >= SHARPE_MIN_N && agg.sharpe != null) {
    parts.push(`Shrp ${agg.sharpe.toFixed(2)} (mean÷stdev P&L)`);
  } else {
    parts.push(`Shrp — (need ≥${SHARPE_MIN_N} graded)`);
  }
  const adv = pathAdv(agg);
  if (adv != null) {
    parts.push(`avg path MAE ${adv.toFixed(1)}% (max adverse stock move against short)`);
  }
  if (agg.avgCushionUsedPct != null) {
    parts.push(`avg OTM cushion used ${agg.avgCushionUsedPct.toFixed(0)}%`);
  }
  if (agg.avgIncomePct != null) {
    parts.push(`avg income ${agg.avgIncomePct.toFixed(2)}%`);
  }
  return parts.join(" · ");
}

/** Display Sharpe only when n≥3; otherwise em dash (thin samples lie). */
function displaySharpe(agg: TickerSideAgg): number | null {
  if (agg.n < SHARPE_MIN_N) return null;
  return agg.sharpe ?? null;
}

function SideAggCells({ agg, edge, side }: { agg: TickerSideAgg; edge?: string; side: "put" | "call" }) {
  const tip = sideExplain(agg, side);
  if (agg.n === 0) {
    const pendTip = agg.pending > 0
      ? `${agg.pending} open rec${agg.pending === 1 ? "" : "s"} not graded yet (expiry still out)`
      : tip;
    return (
      <>
        <td className={cn(TD, "text-right text-amber-200/70 whitespace-nowrap", edge)} title={pendTip}>—</td>
        <td className={cn(TD, "text-right text-amber-200/70")} title={pendTip}>—</td>
        <td className={cn(TD, "text-right text-amber-200/70")} title={pendTip}>—</td>
      </>
    );
  }
  const sh = displaySharpe(agg);
  return (
    <>
      <td
        className={cn(TD, "text-right text-white whitespace-nowrap", edge)}
        title={tip}
      >
        {agg.wins}W-{agg.losses}L
      </td>
      <td
        className={cn(
          TD, "text-right font-semibold tabular-nums",
          agg.avgPnlPct != null && agg.avgPnlPct >= 0 ? "text-green-400" : "text-red-400",
        )}
        title={tip}
      >
        {agg.avgPnlPct != null ? signed(agg.avgPnlPct) : "—"}
      </td>
      <td
        className={cn(
          TD, "text-right tabular-nums",
          sh == null ? "text-amber-200/55" : sh >= 1 ? "text-emerald-300" : sh >= 0 ? "text-sky-300" : "text-red-400",
        )}
        title={tip}
      >
        {sh != null ? sh.toFixed(2) : "—"}
      </td>
    </>
  );
}

type SortMode = "put-shrpe" | "call-shrpe" | "az";

function sideSharpeRank(agg: TickerSideAgg): number {
  const sh = displaySharpe(agg);
  // No Sharpe → sink below all ranked rows (use -Infinity)
  return sh ?? Number.NEGATIVE_INFINITY;
}

function compareBySharpe(a: TickerSideAgg, b: TickerSideAgg): number {
  const dSh = sideSharpeRank(b) - sideSharpeRank(a);
  if (dSh !== 0) return dSh;
  const dPnl = (b.avgPnlPct ?? -Infinity) - (a.avgPnlPct ?? -Infinity);
  if (dPnl !== 0) return dPnl;
  const dWr = (b.winRate ?? -1) - (a.winRate ?? -1);
  if (dWr !== 0) return dWr;
  return b.n - a.n;
}

function bestEdgeRow(rows: TickerSummaryRow[], side: "put" | "call"): TickerSummaryRow | null {
  const eligible = rows.filter(r => displaySharpe(r[side]) != null);
  if (eligible.length === 0) return null;
  return eligible.slice().sort((a, b) => compareBySharpe(a[side], b[side]))[0] ?? null;
}

function BestEdgeChip({
  label, row, side, color,
}: {
  label: string;
  row: TickerSummaryRow | null;
  side: "put" | "call";
  color: string;
}) {
  if (!row) {
    return (
      <span className="text-[10px] text-amber-200/60 font-mono" title={`Need ≥${SHARPE_MIN_N} graded ${side}s on a ticker`}>
        {label}: —
      </span>
    );
  }
  const agg = row[side];
  const sh = displaySharpe(agg)!;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-mono"
      style={{ borderColor: `${color}55`, background: `${color}14` }}
      title={`Highest ${side} Sharpe (n≥${SHARPE_MIN_N}). ${sideExplain(agg, side)}`}
    >
      <span className="font-semibold uppercase tracking-wide" style={{ color }}>{label}</span>
      <span className="text-white font-bold">{row.ticker}</span>
      <span className="text-emerald-300">Shrp {sh.toFixed(2)}</span>
      <span className="text-amber-100/80">{agg.wins}W-{agg.losses}L</span>
      <span className={agg.avgPnlPct != null && agg.avgPnlPct >= 0 ? "text-green-400" : "text-red-400"}>
        {agg.avgPnlPct != null ? signed(agg.avgPnlPct) : "—"}
      </span>
    </span>
  );
}

/** Compact Options Rankings pick — same strike/exp/score as Rankings › Overall. */
function RankCells({
  pick, edge, bodyClass,
}: {
  pick: RankPick | null;
  edge?: string;
  bodyClass?: string;
}) {
  if (!pick) {
    return (
      <>
        <td className={cn(TD, "text-right text-amber-200/55", edge, bodyClass)} title="Not on latest Options Rankings board">—</td>
        <td className={cn(TD, "text-right text-amber-200/55", bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-amber-200/55", bodyClass)}>—</td>
      </>
    );
  }
  const dte = pick.dte != null ? Math.max(0, Math.round(pick.dte)) : null;
  return (
    <>
      <td
        className={cn(TD, "text-right font-semibold text-amber-300", edge, bodyClass)}
        title={`#${pick.rank} on Options Rankings · asOf ${pick.asOf}${pick.delta != null ? ` · δ ${pick.delta.toFixed(3)}` : ""} · prem $${pick.premium.toFixed(2)}`}
      >
        {pick.strike.toFixed(pick.strike < 10 ? 2 : 1)}
      </td>
      <td
        className={cn(TD, "text-right text-sky-300", bodyClass)}
        title={dte != null ? `${dte}d to expiry` : undefined}
      >
        {shortDate(pick.expiry)}
      </td>
      <td
        className={cn(TD, "text-right font-semibold tabular-nums text-emerald-300", bodyClass)}
        title={`Option score ${pick.optionScore.toFixed(1)} · rank #${pick.rank}`}
      >
        {pick.optionScore.toFixed(0)}
        <span className="text-amber-200/70 font-normal">#{pick.rank}</span>
      </td>
    </>
  );
}

function PriceCell({ price, changePct }: { price: number | null; changePct: number | null }) {
  if (price == null) return <td className={cn(TD, "text-right text-amber-200/55")}>—</td>;
  const up = changePct != null && changePct >= 0;
  return (
    <td className={cn(TD, "text-right whitespace-nowrap")}>
      <span className="text-white font-semibold">{price.toFixed(2)}</span>
      {changePct != null && (
        <span className={cn("ml-1 text-[9px] font-semibold", up ? "text-green-400" : "text-red-400")}>
          {up ? "+" : ""}{changePct.toFixed(1)}%
        </span>
      )}
    </td>
  );
}

function TickerSummaryTable({ rows }: { rows: TickerSummaryRow[] }) {
  const [sortMode, setSortMode] = useState<SortMode>("put-shrpe");
  const [openTicker, setOpenTicker] = useState<string | null>(null);

  const bestPut = useMemo(() => bestEdgeRow(rows, "put"), [rows]);
  const bestCall = useMemo(() => bestEdgeRow(rows, "call"), [rows]);

  const sorted = useMemo(() => {
    const copy = rows.slice();
    if (sortMode === "az") {
      copy.sort((a, b) => a.ticker.localeCompare(b.ticker));
      return copy;
    }
    const side = sortMode === "put-shrpe" ? "put" : "call";
    copy.sort((a, b) => {
      const d = compareBySharpe(a[side], b[side]);
      return d !== 0 ? d : a.ticker.localeCompare(b.ticker);
    });
    return copy;
  }, [rows, sortMode]);

  const highlightTicker =
    sortMode === "call-shrpe" ? bestCall?.ticker : sortMode === "put-shrpe" ? bestPut?.ticker : null;

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap px-0.5">
        <h2 className="text-[11px] font-semibold text-[#d4af37] uppercase tracking-wide shrink-0">By Ticker</h2>
        <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
          {([
            ["put-shrpe", "Put Shrp"],
            ["call-shrpe", "Call Shrp"],
            ["az", "A–Z"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setSortMode(mode)}
              className={cn(
                "px-2 py-0.5 transition-colors",
                sortMode === mode ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/70 hover:text-[#d4af37]",
              )}
              title={
                mode === "az"
                  ? "Alphabetical"
                  : `Rank by ${mode === "put-shrpe" ? "put" : "call"} Sharpe (mean÷stdev P&L). n<${SHARPE_MIN_N} sink to bottom.`
              }
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-amber-200/70">
          History = graded W/L · Sell = Options Rankings pick · click row for drill-down
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-0.5">
        <BestEdgeChip label="Best put" row={bestPut} side="put" color="#38bdf8" />
        <BestEdgeChip label="Best call" row={bestCall} side="call" color="#fbbf24" />
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-amber-200/70 py-4 text-center">No graded recs yet</p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
          <table className="w-full table-fixed text-[10px]">
            <colgroup>
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[6%]" /><col className="w-[6%]" /><col className="w-[5%]" />
              <col className="w-[6%]" /><col className="w-[5%]" /><col className="w-[7%]" />
              <col className="w-[6%]" /><col className="w-[6%]" /><col className="w-[5%]" />
              <col className="w-[6%]" /><col className="w-[5%]" /><col className="w-[7%]" />
            </colgroup>
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/20">
                <th rowSpan={2} className={cn(TH, "text-left align-bottom")}>Ticker</th>
                <th rowSpan={2} className={cn(TH, "text-right align-bottom")}>Now</th>
                <th colSpan={3} className={cn(TH_SUB, "text-center border-b border-[#d4af37]/10", PUT_HEAD, PUT_EDGE)}>
                  Put history
                </th>
                <th colSpan={3} className={cn(TH_SUB, "text-center border-b border-emerald-500/20", PUT_REC_HEAD, PUT_REC_EDGE)}>
                  Ranked put
                </th>
                <th colSpan={3} className={cn(TH_SUB, "text-center border-b border-[#d4af37]/10", CALL_HEAD, CALL_EDGE)}>
                  Call history
                </th>
                <th colSpan={3} className={cn(TH_SUB, "text-center border-b border-amber-500/20", CALL_REC_HEAD, CALL_REC_EDGE)}>
                  Ranked call
                </th>
              </tr>
              <tr className="border-b border-[#d4af37]/20">
                <th className={cn(TH_SUB, "text-right", PUT_HEAD, PUT_EDGE)} title="Wins-Losses on graded sell-put recs">W-L</th>
                <th className={cn(TH_SUB, "text-right", PUT_HEAD)} title="Average P&L % on graded puts">P&L</th>
                <th className={cn(TH_SUB, "text-right", PUT_HEAD)} title={`mean(P&L) ÷ stdev(P&L) — n≥${SHARPE_MIN_N}`}>Shrp</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD, PUT_REC_EDGE)} title="Strike from Options Rankings">Strike</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)}>Exp</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)} title="Option score + board rank">Scr</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD, CALL_EDGE)}>W-L</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD)}>P&L</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD)} title={`mean(P&L) ÷ stdev(P&L) — n≥${SHARPE_MIN_N}`}>Shrp</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD, CALL_REC_EDGE)}>Strike</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)}>Exp</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)} title="Option score + board rank">Scr</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {sorted.map(r => {
                const isBest = highlightTicker != null && r.ticker === highlightTicker;
                const isOpen = openTicker === r.ticker;
                return (
                  <tr
                    key={r.ticker}
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenTicker(isOpen ? null : r.ticker)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenTicker(isOpen ? null : r.ticker);
                      }
                    }}
                    className={cn(
                      "transition-colors cursor-pointer",
                      isOpen ? "bg-[#d4af37]/15"
                        : isBest
                          ? "bg-[#d4af37]/10 ring-1 ring-inset ring-[#d4af37]/35"
                          : "bg-zinc-900/70 even:bg-zinc-800/50 hover:bg-amber-500/10",
                    )}
                  >
                    <td className={cn(TD, "text-left font-semibold text-white truncate")}>
                      {r.ticker}
                      {isBest && (
                        <span
                          className="ml-1 text-[8px] font-bold uppercase tracking-wide text-[#d4af37]"
                          title={`Top ${sortMode === "call-shrpe" ? "call" : "put"} Sharpe in this sort`}
                        >
                          top
                        </span>
                      )}
                    </td>
                    <PriceCell price={r.currentPrice} changePct={r.priceChangePct} />
                    <SideAggCells agg={r.put} edge={PUT_EDGE} side="put" />
                    <RankCells pick={r.rankPut} edge={PUT_REC_EDGE} bodyClass={PUT_REC_BODY} />
                    <SideAggCells agg={r.call} edge={CALL_EDGE} side="call" />
                    <RankCells pick={r.rankCall} edge={CALL_REC_EDGE} bodyClass={CALL_REC_BODY} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openTicker && (
        <TickerDrilldown ticker={openTicker} onClose={() => setOpenTicker(null)} />
      )}
    </section>
  );
}

type TrackTab = "model" | "strategies" | "journal";

/** `embedded` — Live › Track Record sub-tab (no TopNav / AppPage shell). */
export default function TrackRecord({ embedded = false }: { embedded?: boolean } = {}) {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useSessionState<TrackTab>("fildi_track_record_tab", "model");
  const activeTab: TrackTab = (tab === "strategies" || tab === "journal") && !isAdmin ? "model" : tab;

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["track-record", "summary"],
    queryFn: async (): Promise<SummaryResponse> => {
      const res = await fetch("/api/track-record/summary");
      if (!res.ok) throw new Error("track-record summary fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    enabled: activeTab === "model",
  });

  const { data: regime } = useQuery({
    queryKey: ["track-record", "regime"],
    queryFn: async (): Promise<RegimeResponse> => {
      const res = await fetch("/api/track-record/regime");
      if (!res.ok) throw new Error("track-record regime fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    enabled: activeTab === "model",
  });

  // Fetch in parallel with summary — don't wait on chrome.
  const { data: tickerSummary, isLoading: tickerSummaryLoading } = useQuery({
    queryKey: ["track-record", "ticker-summary", "v8"],
    queryFn: async (): Promise<TickerSummaryRow[]> => {
      const res = await fetch("/api/track-record/ticker-summary");
      if (!res.ok) throw new Error("track-record ticker-summary fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    enabled: activeTab === "model",
  });

  const body = (
      <div className={cn("space-y-2 max-w-7xl mx-auto", embedded ? "px-4 pb-4 pt-2" : undefined)}>
        {isAdmin && (
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {([
              { id: "model" as const, label: "Model" },
              { id: "strategies" as const, label: "Strategies" },
              { id: "journal" as const, label: "Journal" },
            ]).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "px-2.5 py-0.5 transition-colors",
                  activeTab === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white hover:text-[#d4af37]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {activeTab === "journal" && isAdmin ? (
          <JournalTab />
        ) : activeTab === "strategies" && isAdmin ? (
          <StrategiesTab />
        ) : summaryLoading || !summary ? (
          <div className="text-xs text-amber-200/70 py-10 text-center">Loading…</div>
        ) : (
          <>
            <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
              <ScoreCard title="Puts" summary={summary.put} color="#38bdf8" />
              <ScoreCard title="Calls" summary={summary.call} color="#fbbf24" />
              <HotlistCard hotlist={summary.hotlist} thin={summary.secondary?.hotlistThin} />
              <RegimeCard grid={regime?.grid ?? []} />
            </div>

            <EquityCurve put={summary.put} call={summary.call} />

            {summary.calibration && (
              <details className="rounded border border-[#d4af37]/15 bg-zinc-950/80 px-2.5 py-1 group">
                <summary className="cursor-pointer text-[10px] font-semibold text-[#d4af37]/80 list-none flex items-center gap-1.5">
                  <span className="text-amber-100/80 group-open:rotate-90 transition-transform">▸</span>
                  Score calibration
                  <span className="font-normal text-amber-100/80 normal-case tracking-normal">
                    — does a higher option score historically mean better P&L? (avg P&L by score bucket)
                  </span>
                </summary>
                <div className="mt-1.5 pb-1 space-y-1 text-[10px] font-mono text-sky-200/70">
                  {(["put", "call"] as const).map(side => (
                    <div key={side} className="flex flex-wrap gap-1 items-center">
                      <span className="uppercase text-[#d4af37]/70 w-8">{side}</span>
                      {summary.calibration![side].map(b => (
                        <span
                          key={`${side}-${b.lo}`}
                          className={cn(
                            "rounded px-1 py-0.5 border border-white/10",
                            b.n >= 25 && b.avgPnlPct < 0 ? "text-red-400" : b.n >= 25 && b.avgPnlPct > 0 ? "text-green-400" : "text-amber-100/80",
                          )}
                          title={`n=${b.n} graded in this score range`}
                        >
                          {b.lo.toFixed(0)}–{b.hi.toFixed(0)}: {signed(b.avgPnlPct)}
                          <span className="opacity-50"> ({b.n})</span>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {(() => {
              const regimeThin = (regime?.grid ?? []).every(c => c.n < 5);
              const hotlistThin = summary.secondary?.hotlistThin ?? true;
              if (hotlistThin || regimeThin) return null;
              return <RegimeGrid grid={regime?.grid ?? []} />;
            })()}

            {tickerSummaryLoading && !tickerSummary ? (
              <p className="text-xs text-amber-200/70 py-6 text-center">Loading by-ticker table…</p>
            ) : (
              <TickerSummaryTable rows={tickerSummary ?? []} />
            )}
          </>
        )}
      </div>
  );

  if (embedded) return body;
  return <AppPage contentClassName="px-4 pb-4">{body}</AppPage>;
}
