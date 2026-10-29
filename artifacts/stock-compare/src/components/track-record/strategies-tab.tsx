/**
 * Track Record › Strategies (A175). Admin-only. Reads /api/strategies — never computes trades.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, ComposedChart, Area, Line, CartesianGrid, XAxis, YAxis, Tooltip,
  ReferenceArea,
} from "recharts";
import { cn } from "@/lib/utils";
import { useStrategySignals, type StrategySignal } from "@/hooks/use-strategy-signals";

interface ListStats {
  totalReturn: number | null;
  annualizedReturn: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  profitFactor: number | null;
  tradeCount: number;
  holdoutReturn: number | null;
  vsSpy: number | null;
  lastEquity: number | null;
}

interface ListItem {
  strategyId: string;
  version: string;
  name: string;
  family: string;
  instrument: string;
  status: string;
  summary: string;
  studyRef: string | null;
  priceSource: string;
  windowStart: string;
  windowEnd: string;
  holdoutStart: string | null;
  stats: ListStats;
}

interface ListResponse {
  tried: number;
  passed: number;
  strategies: ListItem[];
}

interface DetailStats extends ListStats {
  avgWin: number | null;
  avgLoss: number | null;
}

interface EquityPt {
  d: string;
  equity: number;
  spyEquity: number;
  drawdown: number;
  isHoldout: boolean;
}

interface TradeRow {
  id: number;
  entryTs: string;
  exitTs: string | null;
  ticker: string;
  instrument: string;
  side: string;
  optionType: string | null;
  strike: number | null;
  expiry: string | null;
  dteAtEntry: number | null;
  qty: number;
  entryPx: number;
  exitPx: number | null;
  capital: number;
  pnl: number | null;
  retPct: number | null;
  trigger: string;
  exitReason: string | null;
  isHoldout: boolean;
}

interface DetailResponse {
  strategy: ListItem & { rulesMd: string; caveatsMd: string | null; updatedAt: string };
  stats: DetailStats;
  equity: EquityPt[];
  trades: TradeRow[];
}

function pct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function signedPct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  const x = v * 100;
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

function shortDate(iso: string): string {
  const d = iso.slice(0, 10);
  const [, m, day] = d.split("-");
  return `${parseInt(m!, 10)}/${parseInt(day!, 10)}`;
}

function contractLabel(t: TradeRow): string {
  if (t.instrument !== "option" || t.strike == null || !t.optionType) return t.ticker;
  const exp = t.expiry ? shortDate(t.expiry) : "?";
  return `${t.ticker} ${exp} $${t.strike}${t.optionType}`;
}

const STATUS_CLR: Record<string, string> = {
  live: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  candidate: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  retired: "bg-zinc-500/20 text-amber-100 border-zinc-500/30",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-semibold", STATUS_CLR[status] ?? STATUS_CLR.retired)}>
      {status}
    </span>
  );
}

function Kpi({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} className="rounded border border-[#d4af37]/15 bg-zinc-950 px-2 py-1.5 min-w-[5.5rem]">
      <div className="text-[9px] uppercase tracking-wider text-[#d4af37]/70">{label}</div>
      <div className="text-[13px] font-mono font-semibold text-sky-100 tabular-nums">{value}</div>
    </div>
  );
}

type TradeSort = "entryTs" | "ticker" | "pnl" | "retPct";

function signalNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A189 — Today's signals + live strip for panic-puts-hiv (and any strategy with signals). */
function StrategySignalsPanel({ strategyId }: { strategyId: string }) {
  const { data, isLoading, error } = useStrategySignals(strategyId, 30);
  if (isLoading) {
    return <p className="text-[11px] text-amber-100/80 py-2">Loading signals…</p>;
  }
  if (error || !data) return null;
  if (data.count === 0) {
    return (
      <div className="rounded border border-[#d4af37]/15 bg-zinc-950 px-2 py-1.5 text-[11px] text-amber-100/80">
        No live signals in the last 30d
      </div>
    );
  }

  const live = data.live;
  const byGroup = new Map<string, StrategySignal[]>();
  for (const s of data.signals) {
    const g = (s.details?.peer_group as string | null | undefined) ?? "ungrouped";
    const arr = byGroup.get(g) ?? [];
    arr.push(s);
    byGroup.set(g, arr);
  }
  for (const [, arr] of byGroup) {
    arr.sort((a, b) => (signalNum(b.details?.iv_jump_5d) ?? -1) - (signalNum(a.details?.iv_jump_5d) ?? -1));
  }
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);

  const hit = live.hitRate == null ? "—" : `${(live.hitRate * 100).toFixed(0)}%`;
  const mean = live.meanRet == null ? "—" : `${(live.meanRet * 100).toFixed(2)}%`;
  const bt = `${(live.backtestMeanRet * 100).toFixed(2)}%`;

  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 space-y-1.5 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-[#d4af37]">Today&apos;s signals</span>
        <span className="text-[10px] text-amber-100 font-mono">
          live since {live.since} · graded {live.graded} · hit {hit} · mean {mean}
          <span className="text-zinc-600"> (backtest {bt})</span>
        </span>
      </div>
      {groups.map(([group, rows]) => {
        const cluster = signalNum(rows[0]?.details?.same_group_today) ?? rows.length;
        return (
          <div key={group} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[9px] uppercase tracking-wider text-amber-100/80">{group}</span>
              <span className="text-[9px] text-zinc-600">{rows.length}</span>
              {cluster >= 4 && (
                <span className="text-[10px] text-amber-200/90 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
                  {cluster} signals in one group = one correlated bet; consider the top 2–3
                </span>
              )}
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-amber-100/80">
                  <th className="text-left font-semibold px-1 py-0.5">Ticker</th>
                  <th className="text-left font-semibold px-1 py-0.5">Contract</th>
                  <th className="text-right font-semibold px-1 py-0.5">Entry mid</th>
                  <th className="text-right font-semibold px-1 py-0.5">IV</th>
                  <th className="text-right font-semibold px-1 py-0.5">Drop (z)</th>
                  <th className="text-left font-semibold px-1 py-0.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const iv = signalNum(s.details?.iv30);
                  const z = signalNum(s.details?.z);
                  return (
                    <tr key={`${s.asOf}-${s.ticker}`} className="border-t border-white/5">
                      <td className="px-1 py-0.5 font-mono text-sky-100">{s.ticker}</td>
                      <td className="px-1 py-0.5 font-mono text-zinc-300 whitespace-nowrap">
                        {s.occ ?? "—"}
                        <span className="text-zinc-600 ml-1 text-[9px]">{s.asOf.slice(5)}</span>
                      </td>
                      <td className="px-1 py-0.5 font-mono text-right tabular-nums text-zinc-300">
                        {s.entryMid == null ? "—" : s.entryMid.toFixed(2)}
                      </td>
                      <td className="px-1 py-0.5 font-mono text-right tabular-nums text-zinc-300">
                        {iv == null ? "—" : iv.toFixed(1)}
                      </td>
                      <td className="px-1 py-0.5 font-mono text-right tabular-nums text-zinc-300">
                        {z == null ? "—" : z.toFixed(2)}
                      </td>
                      <td className="px-1 py-0.5 text-amber-100/80">{s.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function StrategyDetail({ id, version }: { id: string; version: string }) {
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState("");
  const [tickerFilter, setTickerFilter] = useState("");
  const [sort, setSort] = useState<TradeSort>("entryTs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const qs = new URLSearchParams({ version, from });
  if (to) qs.set("to", to);

  const { data, isLoading, error } = useQuery({
    queryKey: ["strategies", id, version, from, to],
    queryFn: async (): Promise<DetailResponse> => {
      const res = await fetch(`/api/strategies/${encodeURIComponent(id)}?${qs}`);
      if (res.status === 404) throw new Error("not found");
      if (!res.ok) throw new Error("strategy detail failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const chartData = useMemo(() => {
    if (!data?.equity) return [];
    return data.equity.map((e) => ({
      d: e.d,
      strategyPct: (e.equity - 1) * 100,
      spyPct: (e.spyEquity - 1) * 100,
      drawdownPct: e.drawdown * 100,
      isHoldout: e.isHoldout,
    }));
  }, [data?.equity]);

  const holdoutRange = useMemo(() => {
    const pts = data?.equity ?? [];
    const hold = pts.filter((e) => e.isHoldout);
    if (!hold.length) return null;
    return { x1: hold[0]!.d, x2: hold[hold.length - 1]!.d };
  }, [data?.equity]);

  const trades = useMemo(() => {
    let rows = data?.trades ?? [];
    const q = tickerFilter.trim().toUpperCase();
    if (q) rows = rows.filter((t) => t.ticker.includes(q));
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data?.trades, tickerFilter, sort, sortDir]);

  const toggleSort = (k: TradeSort) => {
    if (sort === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(k); setSortDir(k === "ticker" ? "asc" : "desc"); }
  };

  if (isLoading) return <p className="text-xs text-amber-100 py-6 text-center">Loading strategy…</p>;
  if (error || !data) return <p className="text-xs text-red-400/80 py-6 text-center">Could not load strategy</p>;

  const { strategy: s, stats } = data;
  const showPxBadge = s.priceSource === "model" || s.priceSource === "close";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-[#d4af37]">{s.name}</h2>
            <StatusBadge status={s.status} />
            {showPxBadge && (
              <span
                className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-200/80"
                title="S021: model option prices ran ~25% off real quotes"
              >
                prices: {s.priceSource}
              </span>
            )}
            {s.studyRef && (
              <span className="text-[10px] text-amber-100/80 font-mono">{s.studyRef}</span>
            )}
          </div>
          <p className="text-[11px] text-amber-100">{s.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <label className="text-amber-100/80">From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="ml-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1 py-0.5 text-sky-100" />
          </label>
          <label className="text-amber-100/80">To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="ml-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1 py-0.5 text-sky-100" />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Kpi label="Return" value={signedPct(stats.totalReturn)} title="Last equity index − 1 (starts at 1.0)" />
        <Kpi label="Ann." value={signedPct(stats.annualizedReturn)} title="Annualized from first→last equity date" />
        <Kpi label="Sharpe" value={stats.sharpe == null ? "—" : stats.sharpe.toFixed(2)} title="Daily equity returns × √252" />
        <Kpi label="Max DD" value={pct(stats.maxDrawdown)} title="Worst drawdown from equity peak" />
        <Kpi label="Win%" value={pct(stats.winRate, 0)} title="Share of trades with pnl > 0" />
        <Kpi label="PF" value={stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} title="Sum wins ÷ |sum losses|" />
        <Kpi label="Trades" value={String(stats.tradeCount)} />
        <Kpi label="vs SPY" value={signedPct(stats.vsSpy)} title="Last strategy equity − last SPY equity (same base)" />
        {stats.holdoutReturn != null && (
          <Kpi label="Holdout" value={signedPct(stats.holdoutReturn)} title="Return in holdout window only (not tuned on)" />
        )}
      </div>

      <StrategySignalsPanel strategyId={id} />

      <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold text-[#d4af37]">Cumulative return</span>
          <span className="text-[9px] text-amber-100/80">strategy vs SPY · holdout shaded</span>
        </div>
        {chartData.length === 0 ? (
          <div className="h-[140px] flex items-center justify-center text-xs text-amber-100/80">No equity series</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="d" tick={{ fontSize: 9, fill: "#7dd3fc" }} tickFormatter={shortDate} minTickGap={40} />
                <YAxis tick={{ fontSize: 9, fill: "#7dd3fc" }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip
                  contentStyle={{ background: "#09090b", border: "1px solid #d4af3740", fontSize: 11 }}
                  formatter={(v: number, key: string) => [
                    `${v.toFixed(2)}%`,
                    key === "strategyPct" ? "strategy" : key === "spyPct" ? "SPY" : key,
                  ]}
                  labelFormatter={(l) => String(l).slice(0, 10)}
                />
                {holdoutRange && (
                  <ReferenceArea x1={holdoutRange.x1} x2={holdoutRange.x2} fill="#d4af37" fillOpacity={0.08}
                    strokeOpacity={0} label={{ value: "holdout (not tuned on)", fill: "#a1a1aa", fontSize: 9 }} />
                )}
                <Area type="monotone" dataKey="strategyPct" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.15} strokeWidth={1.5} name="strategy" />
                <Line type="monotone" dataKey="spyPct" stroke="#a1a1aa" strokeWidth={1} dot={false} strokeDasharray="4 3" name="SPY" />
              </ComposedChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={48}>
              <ComposedChart data={chartData} margin={{ top: 0, right: 8, left: -12, bottom: 0 }}>
                <XAxis dataKey="d" hide />
                <YAxis tick={{ fontSize: 8, fill: "#71717a" }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={36} />
                <Area type="monotone" dataKey="drawdownPct" stroke="#f87171" fill="#f87171" fillOpacity={0.25} strokeWidth={1} />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="text-[9px] text-zinc-600 text-right">drawdown</p>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <MdPanel title="Rules" body={s.rulesMd} />
        <MdPanel title="Caveats" body={s.caveatsMd ?? "—"} />
      </div>

      <div className="rounded border border-[#d4af37]/15 bg-zinc-950">
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-[#d4af37]/10">
          <span className="text-[10px] font-semibold text-[#d4af37]">Trades</span>
          <span className="text-[10px] text-amber-100/80">{trades.length} shown</span>
          <input
            value={tickerFilter}
            onChange={(e) => setTickerFilter(e.target.value)}
            placeholder="Filter ticker"
            className="ml-auto bg-zinc-900 border border-[#d4af37]/20 rounded px-1.5 py-0.5 text-[11px] text-sky-100 w-28"
          />
        </div>
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-zinc-950 z-10">
              <tr className="text-[9px] uppercase tracking-wider text-amber-100/80">
                {([
                  ["entryTs", "Entry"],
                  ["ticker", "Contract"],
                  ["pnl", "P&L"],
                  ["retPct", "Ret"],
                ] as const).map(([k, label]) => (
                  <th key={k} className="px-1.5 py-1 text-left font-semibold cursor-pointer hover:text-[#d4af37]"
                    onClick={() => toggleSort(k)}>
                    {label}{sort === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                  </th>
                ))}
                <th className="px-1.5 py-1 text-left font-semibold">Trigger</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                  <td className="px-1.5 py-1 font-mono text-amber-100 whitespace-nowrap">{shortDate(t.entryTs)}</td>
                  <td className="px-1.5 py-1 font-mono text-sky-100 whitespace-nowrap">
                    {contractLabel(t)}
                    <span className="text-zinc-600 ml-1">{t.side}</span>
                  </td>
                  <td className={cn("px-1.5 py-1 font-mono tabular-nums text-right",
                    t.pnl == null ? "text-amber-100/80" : t.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {t.pnl == null ? "—" : t.pnl.toFixed(0)}
                  </td>
                  <td className={cn("px-1.5 py-1 font-mono tabular-nums text-right",
                    t.retPct == null ? "text-amber-100/80" : t.retPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {signedPct(t.retPct)}
                  </td>
                  <td className="px-1.5 py-1 text-amber-100 truncate max-w-[12rem]" title={t.trigger}>{t.trigger}</td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-4 text-center text-amber-100/80">No trades in range</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MdPanel({ title, body }: { title: string; body: string }) {
  return (
    <details className="rounded border border-[#d4af37]/15 bg-zinc-950 px-2.5 py-1.5 group" open={title === "Rules"}>
      <summary className="cursor-pointer text-[10px] font-semibold text-[#d4af37]/80 list-none flex items-center gap-1">
        <span className="text-amber-100/80 group-open:rotate-90 transition-transform">▸</span>
        {title}
      </summary>
      <pre className="mt-1.5 text-[11px] text-amber-100 whitespace-pre-wrap font-sans leading-relaxed">{body}</pre>
    </details>
  );
}

export function StrategiesTab() {
  const [family, setFamily] = useState("");
  const [status, setStatus] = useState("");
  const [instrument, setInstrument] = useState("");
  const [showFailed, setShowFailed] = useState(true);
  const [selected, setSelected] = useState<{ id: string; version: string } | null>(null);

  const qs = new URLSearchParams();
  if (family) qs.set("family", family);
  if (status) qs.set("status", status);
  if (instrument) qs.set("instrument", instrument);

  const { data, isLoading, error } = useQuery({
    queryKey: ["strategies", "list", family, status, instrument],
    queryFn: async (): Promise<ListResponse> => {
      const res = await fetch(`/api/strategies${qs.toString() ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error("strategies list failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const list = data?.strategies ?? [];
    return showFailed ? list : list.filter((s) => s.status !== "failed");
  }, [data?.strategies, showFailed]);

  if (isLoading) return <p className="text-xs text-amber-100 py-10 text-center">Loading strategies…</p>;
  if (error) return <p className="text-xs text-red-400/80 py-10 text-center">Could not load strategies</p>;

  if (!data || data.strategies.length === 0) {
    return (
      <div className="rounded border border-[#d4af37]/15 bg-zinc-950 px-4 py-10 text-center">
        <p className="text-sm text-zinc-300">No strategies backtested yet</p>
        <p className="text-[11px] text-amber-100/80 mt-1">Seeds land via the strategy runner (A176). This page only reads.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-amber-100">
          <span className="font-semibold text-sky-100">{data.tried}</span> strategies tried ·{" "}
          <span className="font-semibold text-emerald-300">{data.passed}</span> passed
        </span>
        <select value={family} onChange={(e) => setFamily(e.target.value)}
          className="bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 text-[11px] text-sky-100">
          <option value="">All families</option>
          <option value="options-income">options-income</option>
          <option value="tail/long-option">tail/long-option</option>
          <option value="stock-swing">stock-swing</option>
          <option value="index">index</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 text-[11px] text-sky-100">
          <option value="">All statuses</option>
          <option value="live">live</option>
          <option value="candidate">candidate</option>
          <option value="failed">failed</option>
          <option value="retired">retired</option>
        </select>
        <select value={instrument} onChange={(e) => setInstrument(e.target.value)}
          className="bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 text-[11px] text-sky-100">
          <option value="">All instruments</option>
          <option value="option">option</option>
          <option value="stock">stock</option>
          <option value="mixed">mixed</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-amber-100 cursor-pointer ml-auto">
          <input type="checkbox" checked={showFailed} onChange={(e) => setShowFailed(e.target.checked)}
            className="accent-[#d4af37]" />
          Show failed
        </label>
      </div>

      {selected ? (
        <div className="space-y-2">
          <button type="button" onClick={() => setSelected(null)}
            className="text-[11px] text-[#d4af37]/80 hover:text-[#d4af37]">← All strategies</button>
          <StrategyDetail id={selected.id} version={selected.version} />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
          {rows.map((s) => (
            <button
              key={`${s.strategyId}-${s.version}`}
              type="button"
              onClick={() => setSelected({ id: s.strategyId, version: s.version })}
              className="text-left rounded border border-[#d4af37]/15 bg-zinc-950 px-2.5 py-2 hover:border-[#d4af37]/40 transition-colors"
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[12px] font-semibold text-sky-100 truncate">{s.name}</span>
                <StatusBadge status={s.status} />
              </div>
              <p className="text-[10px] text-amber-100/80 line-clamp-2 mb-1.5">{s.summary}</p>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-mono text-amber-100">
                <span className={s.stats.totalReturn != null && s.stats.totalReturn >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {signedPct(s.stats.totalReturn)}
                </span>
                <span title="Sharpe (daily × √252)">Sh {s.stats.sharpe?.toFixed(2) ?? "—"}</span>
                <span title="Max drawdown">DD {pct(s.stats.maxDrawdown)}</span>
                <span>n={s.stats.tradeCount}</span>
              </div>
            </button>
          ))}
          {rows.length === 0 && (
            <p className="text-xs text-amber-100/80 col-span-full py-6 text-center">No strategies match filters</p>
          )}
        </div>
      )}
    </div>
  );
}
