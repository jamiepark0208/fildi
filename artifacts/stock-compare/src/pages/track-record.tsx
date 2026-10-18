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

interface TickerSummaryRow {
  ticker: string;
  put: TickerSideAgg;
  call: TickerSideAgg;
  currentPrice: number | null;
  priceChangePct: number | null;
  currentPut: CurrentPick | null;
  currentCall: CurrentPick | null;
}

/** Graded history header tint */
const PUT_HEAD = "bg-sky-500/10 text-sky-200";
const CALL_HEAD = "bg-orange-500/10 text-orange-300";
/** Model's live best-rec columns — distinct wash so users see "this is the pick" */
const PUT_REC_HEAD = "bg-emerald-500/15 text-emerald-200";
const CALL_REC_HEAD = "bg-amber-500/15 text-amber-200";
const PUT_REC_BODY = "bg-emerald-500/[0.06]";
const CALL_REC_BODY = "bg-amber-500/[0.06]";
const PUT_EDGE = "border-l border-sky-500/25";
const CALL_EDGE = "border-l border-orange-500/25";
const PUT_REC_EDGE = "border-l border-emerald-500/35";
const CALL_REC_EDGE = "border-l border-amber-500/35";

const TH = "font-semibold text-[10px] uppercase tracking-wider px-1.5 py-1";
const TH_SUB = "font-semibold text-[9px] uppercase tracking-wider px-1.5 py-0.5";
const TD = "px-1.5 py-1 font-mono text-[11px]";

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
      title="Model sell-option expectancy (capital-weighted avg P&L on graded recs). Primary accountability signal."
    >
      <span className={cn(
        "text-[12px] font-bold ml-auto font-mono tabular-nums",
        exp != null && exp >= 0 ? "text-green-400" : "text-red-400",
      )}>
        {signed(exp)}
      </span>
      <span className="text-[10px] text-sky-200/70 whitespace-nowrap">
        n={summary.n} · {pct(summary.winRate)}
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
    return (
      <>
        <td className={cn(TD, "text-right text-zinc-500 whitespace-nowrap text-[9px]", edge)} title={tip}>
          {agg.pending > 0 ? `${agg.pending}p` : "—"}
        </td>
        <td className={cn(TD, "text-right text-zinc-500")} title={tip}>—</td>
        <td className={cn(TD, "text-right text-zinc-500")} title={tip}>—</td>
        <td className={cn(TD, "text-right text-zinc-500")} title={tip}>—</td>
      </>
    );
  }
  const sh = displaySharpe(agg);
  const adv = pathAdv(agg);
  const cush = agg.avgCushionUsedPct;
  return (
    <>
      <td
        className={cn(TD, "text-right text-white whitespace-nowrap text-[9px] leading-none", edge)}
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
          sh == null ? "text-zinc-600" : sh >= 1 ? "text-emerald-300" : sh >= 0 ? "text-sky-300/80" : "text-red-400",
        )}
        title={tip}
      >
        {sh != null ? sh.toFixed(2) : "—"}
      </td>
      <td
        className={cn(
          TD, "text-right tabular-nums whitespace-nowrap",
          adv == null ? "text-zinc-600" : adv >= 8 ? "text-red-400" : adv >= 4 ? "text-amber-300" : "text-sky-300/80",
        )}
        title={tip}
      >
        {adv == null ? "—" : (
          <>
            {adv.toFixed(1)}%
            {cush != null && <span className="text-zinc-500">/{Math.round(cush)}</span>}
          </>
        )}
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
      <span className="text-[10px] text-zinc-600 font-mono" title={`Need ≥${SHARPE_MIN_N} graded ${side}s on a ticker`}>
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
      title={sideExplain(agg, side)}
    >
      <span className="font-semibold uppercase tracking-wide" style={{ color }}>{label}</span>
      <span className="text-white font-bold">{row.ticker}</span>
      <span className="text-emerald-300">Shrp {sh.toFixed(2)}</span>
      <span className="text-zinc-400">{agg.wins}W-{agg.losses}L</span>
      <span className={agg.avgPnlPct != null && agg.avgPnlPct >= 0 ? "text-green-400" : "text-red-400"}>
        {agg.avgPnlPct != null ? signed(agg.avgPnlPct) : "—"}
      </span>
      {pathAdv(agg) != null && (
        <span className="text-amber-200/70" title="Avg path MAE / cushion used">
          MAE {pathAdv(agg)!.toFixed(1)}%
          {agg.avgCushionUsedPct != null ? ` · cush ${Math.round(agg.avgCushionUsedPct)}%` : ""}
        </span>
      )}
    </span>
  );
}

/** L5 — capital-weighted Sharpe + avg path MAE across open (unexpired) model picks. */
function openBookLens(rows: TickerSummaryRow[], side: "put" | "call") {
  let wSum = 0, shW = 0, maeSum = 0, maeN = 0, incSum = 0, n = 0;
  for (const r of rows) {
    const pick = side === "put" ? r.currentPut : r.currentCall;
    if (!pick) continue;
    n++;
    const coll = side === "put" ? pick.strike : pick.spot;
    const sh = displaySharpe(r[side]);
    if (sh != null && coll > 0) {
      shW += sh * coll;
      wSum += coll;
    }
    if (pick.maxAdversePct != null) {
      maeSum += pick.maxAdversePct;
      maeN++;
    }
    if (pick.incomePct != null) incSum += pick.incomePct;
  }
  return {
    n,
    capitalWeightedSharpe: wSum > 0 ? shW / wSum : null,
    avgMae: maeN > 0 ? maeSum / maeN : null,
    avgIncome: n > 0 ? incSum / n : null,
  };
}

function OpenBookChip({
  label, lens, color,
}: {
  label: string;
  lens: ReturnType<typeof openBookLens>;
  color: string;
}) {
  if (lens.n === 0) {
    return (
      <span className="text-[10px] text-zinc-600 font-mono" title="No open (unexpired) model sell recs">
        {label}: —
      </span>
    );
  }
  const sh = lens.capitalWeightedSharpe;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-mono"
      style={{ borderColor: `${color}40`, background: `${color}0d` }}
      title={`Open ${label}: n=${lens.n} unexpired model picks. Capital-weighted Shrp = Σ(ticker Shrp × collateral) / Σ collateral. Avg path MAE since each Init.`}
    >
      <span className="font-semibold uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="text-zinc-500">n={lens.n}</span>
      {sh != null ? (
        <span className={cn(sh >= 1 ? "text-emerald-300" : sh >= 0 ? "text-sky-300/80" : "text-red-400")}>
          book S{sh.toFixed(2)}
        </span>
      ) : (
        <span className="text-zinc-600">book S—</span>
      )}
      {lens.avgMae != null && (
        <span className={cn(lens.avgMae >= 8 ? "text-red-400" : "text-amber-200/70")}>
          MAE {lens.avgMae.toFixed(1)}%
        </span>
      )}
      {lens.avgIncome != null && (
        <span className="text-zinc-500">inc {lens.avgIncome.toFixed(1)}%</span>
      )}
    </span>
  );
}

function RecCells({
  pick, currentPrice, side, edge, bodyClass,
}: {
  pick: CurrentPick | null;
  currentPrice: number | null;
  side: "put" | "call";
  edge?: string;
  bodyClass?: string;
}) {
  if (!pick) {
    return (
      <>
        <td className={cn(TD, "text-right text-zinc-600", edge, bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-zinc-600", bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-zinc-600", bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-zinc-600", bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-zinc-600", bodyClass)}>—</td>
        <td className={cn(TD, "text-right text-zinc-600", bodyClass)}>—</td>
      </>
    );
  }
  const movePct =
    currentPrice != null && pick.spot > 0
      ? ((currentPrice - pick.spot) / pick.spot) * 100
      : null;
  // Seller-favorable: puts like up-moves; calls like down-moves (match Live badge).
  const moveFavorable =
    movePct == null ? null : side === "call" ? movePct < 0 : movePct > 0;
  const dte = pick.dte != null ? Math.max(0, Math.round(pick.dte)) : null;
  const mae = pick.maxAdversePct ?? null;
  const cush = pick.cushionUsedPct ?? null;
  return (
    <>
      <td
        className={cn(TD, "text-right text-emerald-100/90", edge, bodyClass)}
        title={[
          `Model snapshot initiated ${pick.snapshotDate}`,
          pick.incomePct != null ? `income ${pick.incomePct.toFixed(2)}%` : null,
          `premium $${pick.premium.toFixed(2)}`,
          pick.delta != null ? `entry δ ${pick.delta.toFixed(3)}` : null,
          pick.strikeIv != null ? `entry IV ${(pick.strikeIv <= 3 ? pick.strikeIv * 100 : pick.strikeIv).toFixed(0)}%` : null,
        ].filter(Boolean).join(" · ")}
      >
        {shortDate(pick.snapshotDate)}
      </td>
      <td
        className={cn(TD, "text-right text-white/90", bodyClass)}
        title="Underlying price when this model recommendation was made"
      >
        {pick.spot.toFixed(pick.spot < 10 ? 2 : 1)}
      </td>
      <td
        className={cn(
          TD, "text-right font-semibold tabular-nums", bodyClass,
          moveFavorable == null ? "text-zinc-500" : moveFavorable ? "text-green-400" : "text-red-400",
        )}
        title={`Stock % change since Init (live vs Spot@). ${side === "call" ? "↓ helps short call" : "↑ helps short put"}. Not option delta.`}
      >
        {movePct == null ? "—" : `${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}%`}
      </td>
      <td
        className={cn(
          TD, "text-right tabular-nums whitespace-nowrap", bodyClass,
          mae == null ? "text-zinc-600" : mae >= 8 ? "text-red-400" : mae >= 4 ? "text-amber-300" : "text-sky-300/80",
        )}
        title={
          mae == null
            ? "Path MAE needs daily highs/lows since Init"
            : `Max adverse excursion since Init: ${mae.toFixed(1)}%` +
              (cush != null ? ` · OTM cushion used ${Math.round(cush)}%` : "")
        }
      >
        {mae == null ? "—" : (
          <>
            {mae.toFixed(1)}%
            {cush != null && <span className="text-zinc-500">/{Math.round(cush)}</span>}
          </>
        )}
      </td>
      <td
        className={cn(TD, "text-right font-semibold text-amber-300", bodyClass)}
        title={
          pick.delta != null || pick.strikeIv != null
            ? `Strike ${pick.strike.toFixed(2)} · δ ${pick.delta != null ? pick.delta.toFixed(3) : "—"} · IV ${pick.strikeIv != null ? (pick.strikeIv <= 3 ? pick.strikeIv * 100 : pick.strikeIv).toFixed(0) + "%" : "—"}`
            : undefined
        }
      >
        {pick.strike.toFixed(pick.strike < 10 ? 2 : 1)}
        {pick.delta != null && (
          <span className="block text-[9px] font-normal text-sky-300/60 leading-none mt-0.5">
            δ{Math.abs(pick.delta).toFixed(2)}
          </span>
        )}
      </td>
      <td
        className={cn(TD, "text-right text-sky-300/80", bodyClass)}
        title={dte != null ? `${dte}d to expiry` : undefined}
      >
        {shortDate(pick.expiry)}
      </td>
    </>
  );
}

function PriceCell({ price, changePct }: { price: number | null; changePct: number | null }) {
  if (price == null) return <td className={cn(TD, "text-right text-zinc-500")}>—</td>;
  const up = changePct != null && changePct >= 0;
  return (
    <td className={cn(TD, "text-right whitespace-nowrap")}>
      <span className="text-white font-semibold">{price.toFixed(2)}</span>
      {changePct != null && (
        <span className={cn("ml-1 text-[10px] font-semibold", up ? "text-green-400" : "text-red-400")}>
          {up ? "+" : ""}{changePct.toFixed(1)}%
        </span>
      )}
    </td>
  );
}

function TickerSummaryTable({ rows }: { rows: TickerSummaryRow[] }) {
  const [sortMode, setSortMode] = useState<SortMode>("put-shrpe");

  const bestPut = useMemo(() => bestEdgeRow(rows, "put"), [rows]);
  const bestCall = useMemo(() => bestEdgeRow(rows, "call"), [rows]);
  const putBook = useMemo(() => openBookLens(rows, "put"), [rows]);
  const callBook = useMemo(() => openBookLens(rows, "call"), [rows]);

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
                sortMode === mode ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
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
        <span className="text-[10px] text-zinc-500">
          Shrp n≥{SHARPE_MIN_N} · Adv = path MAE%/cush% · hover for full explain
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-0.5">
        <BestEdgeChip label="Best put edge" row={bestPut} side="put" color="#38bdf8" />
        <BestEdgeChip label="Best call edge" row={bestCall} side="call" color="#fbbf24" />
        <OpenBookChip label="Open put book" lens={putBook} color="#38bdf8" />
        <OpenBookChip label="Open call book" lens={callBook} color="#fbbf24" />
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-zinc-400 py-4 text-center">No graded recs yet</p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/20">
                <th rowSpan={2} className={cn(TH, "text-left align-bottom")}>Ticker</th>
                <th rowSpan={2} className={cn(TH, "text-right align-bottom")}>Now</th>
                <th colSpan={4} className={cn(TH_SUB, "text-center border-b border-[#d4af37]/10", PUT_HEAD, PUT_EDGE)}>
                  Put history
                </th>
                <th colSpan={6} className={cn(TH_SUB, "text-center border-b border-emerald-500/20", PUT_REC_HEAD, PUT_REC_EDGE)}>
                  Model best put to sell
                </th>
                <th colSpan={4} className={cn(TH_SUB, "text-center border-b border-[#d4af37]/10", CALL_HEAD, CALL_EDGE)}>
                  Call history
                </th>
                <th colSpan={6} className={cn(TH_SUB, "text-center border-b border-amber-500/20", CALL_REC_HEAD, CALL_REC_EDGE)}>
                  Model best call to sell
                </th>
              </tr>
              <tr className="border-b border-[#d4af37]/20">
                <th className={cn(TH_SUB, "text-right", PUT_HEAD, PUT_EDGE)} title="Wins-Losses on graded sell-put recs">W-L</th>
                <th className={cn(TH_SUB, "text-right", PUT_HEAD)} title="Average P&L % on graded puts">P&L</th>
                <th className={cn(TH_SUB, "text-right", PUT_HEAD)} title={`mean(P&L) ÷ stdev(P&L) — shown only when n≥${SHARPE_MIN_N}`}>Shrp</th>
                <th className={cn(TH_SUB, "text-right", PUT_HEAD)} title="Avg path MAE% / OTM cushion used% — how hard the stock ran against the short">Adv</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD, PUT_REC_EDGE)} title="Date the model made this recommendation">Init</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)} title="Underlying price at initiation">Spot@</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)} title="Stock % change since Init — NOT option Greek delta">StkΔ</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)} title="Path MAE% / cushion% since Init from daily highs/lows">MAE</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)}>Strike</th>
                <th className={cn(TH_SUB, "text-right", PUT_REC_HEAD)}>Exp</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD, CALL_EDGE)}>W-L</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD)}>P&L</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD)} title={`mean(P&L) ÷ stdev(P&L) — n≥${SHARPE_MIN_N}`}>Shrp</th>
                <th className={cn(TH_SUB, "text-right", CALL_HEAD)} title="Avg path MAE% / cushion used%">Adv</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD, CALL_REC_EDGE)}>Init</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)}>Spot@</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)} title="Stock % change since Init">StkΔ</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)} title="Path MAE% / cushion% since Init">MAE</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)}>Strike</th>
                <th className={cn(TH_SUB, "text-right", CALL_REC_HEAD)}>Exp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {sorted.map(r => {
                const isBest = highlightTicker != null && r.ticker === highlightTicker;
                return (
                  <tr
                    key={r.ticker}
                    className={cn(
                      "transition-colors",
                      isBest
                        ? "bg-[#d4af37]/10 ring-1 ring-inset ring-[#d4af37]/35"
                        : "bg-zinc-900/70 even:bg-zinc-800/50 hover:bg-amber-500/10",
                    )}
                  >
                    <td className={cn(TD, "text-left font-semibold text-white")}>
                      {r.ticker}
                      {isBest && (
                        <span className="ml-1 text-[8px] font-bold uppercase tracking-wide text-[#d4af37]">edge</span>
                      )}
                    </td>
                    <PriceCell price={r.currentPrice} changePct={r.priceChangePct} />
                    <SideAggCells agg={r.put} edge={PUT_EDGE} side="put" />
                    <RecCells pick={r.currentPut} currentPrice={r.currentPrice} side="put" edge={PUT_REC_EDGE} bodyClass={PUT_REC_BODY} />
                    <SideAggCells agg={r.call} edge={CALL_EDGE} side="call" />
                    <RecCells pick={r.currentCall} currentPrice={r.currentPrice} side="call" edge={CALL_REC_EDGE} bodyClass={CALL_REC_BODY} />
                  </tr>
                );
              })}
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

  // Defer heavy by-ticker table until summary chrome is up (or immediately if summary cached).
  const { data: tickerSummary, isLoading: tickerSummaryLoading } = useQuery({
    queryKey: ["track-record", "ticker-summary", "v7"],
    queryFn: async (): Promise<TickerSummaryRow[]> => {
      const res = await fetch("/api/track-record/ticker-summary");
      if (!res.ok) throw new Error("track-record ticker-summary fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    enabled: !!summary || !summaryLoading,
  });

  return (
    <div className="min-h-screen bg-zinc-900">
      <TopNav />
      <main className="pt-14 px-4 pb-4 space-y-2 max-w-7xl mx-auto">
        {summaryLoading || !summary ? (
          <div className="text-xs text-zinc-400 py-10 text-center">Loading…</div>
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
                  <span className="text-zinc-500 group-open:rotate-90 transition-transform">▸</span>
                  Score calibration
                  <span className="font-normal text-zinc-500 normal-case tracking-normal">
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
                            b.n >= 25 && b.avgPnlPct < 0 ? "text-red-400" : b.n >= 25 && b.avgPnlPct > 0 ? "text-green-400" : "text-zinc-500",
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
              <p className="text-xs text-zinc-400 py-6 text-center">Loading by-ticker table…</p>
            ) : (
              <TickerSummaryTable rows={tickerSummary ?? []} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
