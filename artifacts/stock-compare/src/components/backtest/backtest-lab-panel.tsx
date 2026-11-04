/**
 * A331 Backtest Lab — answer-first results UI (Settings › Research link + /backtest).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type StockMetrics } from "@workspace/api-client-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PriceChart, type Period, type ChartMarkerInput } from "@/components/price-chart";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";

const DEFAULT_PRESET = "put_climax_spy_oversold";

type VsAnyDay = {
  breachSig?: number;
  breachBase?: number;
  excessMean?: number;
  meanSig?: number;
  meanBase?: number;
  n?: number;
  nMonths?: number;
};

type BacktestSummary = {
  preset?: string;
  vsAnyDay?: VsAnyDay;
  verdict?: string;
  pnlUnit?: string;
  survivorshipNote?: string;
  firingToday?: string[];
  pricing?: { badge?: string; note?: string; realQuoteCoveragePct?: number };
  answerLine?: string;
};

type BacktestTrade = {
  ticker: string;
  date: string;
  pnl?: number;
  breach?: boolean;
  K?: number;
  S?: number;
};

type RunRow = {
  id: string;
  summary: BacktestSummary;
  holdout_unlocked?: boolean;
  params?: { preset?: string };
};

type InspectPayload = {
  ticker: string;
  date: string;
  asOf?: string;
  features?: Record<string, number | null>;
  quintiles?: Record<string, number | null>;
  conditions?: Record<string, boolean>;
  signalFired?: boolean;
  labelOutcomeNext?: Record<string, unknown>;
};

type TabId = "overview" | "trades" | "lift" | "inspector";

/** Breach rates are fractions (0.0088 → 0.9 %). */
function fmtBreachRate(x: number | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return "—";
  return `${(100 * x).toFixed(digits)} %`;
}

/** Trade / excess P&L from runner is already in percent points (0.6026 → 0.60 %). */
function fmtTradePct(x: number | undefined, digits = 2): string {
  if (x == null || Number.isNaN(x)) return "—";
  return `${x.toFixed(digits)} %`;
}

function pnlUnitLabel(unit: string | undefined): string {
  if (unit === "per_$collateral") return "%/trade on $ collateral";
  if (unit === "per_$debit") return "%/trade on $ debit";
  return "%/trade";
}

function buildAnswerLine(summary: BacktestSummary, holdoutLocked: boolean): string {
  const vs = summary.vsAnyDay ?? {};
  const verdict = summary.verdict === "PASS" ? "PASS sell bar" : (summary.verdict ?? "—");
  const hold = holdoutLocked ? "holdout locked" : "holdout ✓";
  const unit = pnlUnitLabel(summary.pnlUnit);
  return (
    `vs any day: breach ${fmtBreachRate(vs.breachSig)} vs ${fmtBreachRate(vs.breachBase)} · ` +
    `+${vs.excessMean == null || Number.isNaN(vs.excessMean) ? "—" : vs.excessMean.toFixed(2)} ${unit} · n ${vs.n ?? "—"} / ${vs.nMonths ?? "—"} signal mo · ${verdict} · ${hold}`
  );
}

function usePresetRun(preset: string) {
  return useMutation({
    mutationFn: async (): Promise<{ run: RunRow; trades: BacktestTrade[] }> => {
      const runRes = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preset }),
      });
      const runBody = await runRes.json();
      if (!runRes.ok) throw new Error(runBody.error ?? `run ${runRes.status}`);
      const id = runBody.runId as string;
      const detailRes = await fetch(`/api/backtest/runs/${id}`, { credentials: "include" });
      const detail = (await detailRes.json()) as RunRow;
      if (!detailRes.ok) throw new Error("run detail failed");
      const trRes = await fetch(`/api/backtest/runs/${id}/trades`, { credentials: "include" });
      const trBody = (await trRes.json()) as { trades: BacktestTrade[] };
      return { run: detail, trades: trBody.trades ?? [] };
    },
  });
}

function EquityMini({ trades, meanBase }: { trades: BacktestTrade[]; meanBase: number }) {
  const points = useMemo(() => {
    let sig = 0;
    let base = 0;
    return trades.map((t, i) => {
      sig += t.pnl ?? 0;
      base += meanBase;
      return { i, sig, base };
    });
  }, [trades, meanBase]);
  if (points.length < 2) {
    return <p className="text-[10px] text-amber-100/80">Need ≥2 trades for equity curve.</p>;
  }
  const maxY = Math.max(...points.map((p) => Math.max(p.sig, p.base)), 0.001);
  const minY = Math.min(...points.map((p) => Math.min(p.sig, p.base)), 0);
  const h = 72;
  const w = 320;
  const y = (v: number) => h - ((v - minY) / (maxY - minY || 1)) * h;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const sigPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.sig).toFixed(1)}`).join(" ");
  const basePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.base).toFixed(1)}`).join(" ");
  return (
    <div className="space-y-1">
      <div className="flex gap-3 text-[9px] text-amber-100/90">
        <span><span className="text-[#d4af37]">—</span> signal cumulative</span>
        <span><span className="text-amber-100/70">- -</span> any-day mean × n</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-md h-[72px] border border-[#d4af37]/15 rounded bg-black/40">
        <path d={basePath} fill="none" stroke="#71717a" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={sigPath} fill="none" stroke="#d4af37" strokeWidth="2" />
      </svg>
    </div>
  );
}

function MonthHeatmap({ trades }: { trades: BacktestTrade[] }) {
  const cells = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of trades) {
      const d = t.date.slice(0, 7);
      m.set(d, (m.get(d) ?? 0) + (t.pnl ?? 0));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [trades]);
  if (!cells.length) return null;
  const max = Math.max(...cells.map(([, v]) => Math.abs(v)), 0.0001);
  return (
    <div className="flex flex-wrap gap-1 max-w-lg">
      {cells.map(([ym, v]) => (
        <Tooltip key={ym} delayDuration={150}>
          <TooltipTrigger asChild>
            <div
              className="w-8 h-5 rounded-sm border border-[#d4af37]/10 text-[8px] flex items-center justify-center tabular-nums"
              style={{
                backgroundColor: v >= 0
                  ? `rgba(52, 211, 153, ${0.15 + 0.55 * (v / max)})`
                  : `rgba(248, 113, 113, ${0.15 + 0.55 * (Math.abs(v) / max)})`,
              }}
            >
              {ym.slice(2)}
            </div>
          </TooltipTrigger>
          <TooltipContent className="text-[10px]">{ym}: {v.toFixed(2)} % sum</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function BacktestLabPanel() {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [tab, setTab] = useState<TabId>("overview");
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const [chartPeriod, setChartPeriod] = useState<Period>("1Y");
  const [inspTicker, setInspTicker] = useState("AAPL");
  const [inspDate, setInspDate] = useState("2023-01-04");

  const catalogQuery = useQuery({
    queryKey: ["backtest-catalog"],
    queryFn: async () => {
      const r = await fetch("/api/backtest/catalog", { credentials: "include" });
      if (!r.ok) throw new Error(`catalog ${r.status}`);
      return r.json() as Promise<{ presets?: Record<string, { title?: string; delta?: number; instrument?: string; entry?: string }> }>;
    },
    staleTime: 60 * 60_000,
  });

  const runMut = usePresetRun(preset);

  useEffect(() => {
    runMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preset run once on open (U4)
  }, []);

  const summary = runMut.data?.run.summary;
  const trades = runMut.data?.trades ?? [];
  const holdoutLocked = !runMut.data?.run.holdout_unlocked;
  const vs = summary?.vsAnyDay ?? {};
  const presetMeta = catalogQuery.data?.presets?.[preset];

  const implication = useMemo(() => {
    const delta = presetMeta?.delta ?? 0.08;
    const entry = presetMeta?.entry?.replace("_", " ") ?? "next open";
    const inst = presetMeta?.instrument === "sell_put" ? `sell ${delta}Δ puts at ${entry}` : preset;
    const firing = summary?.firingToday?.length
      ? summary.firingToday.join(", ")
      : "none";
    return { inst, firing };
  }, [presetMeta, preset, summary?.firingToday]);

  const chartTicker = selectedTrade?.ticker ?? trades[0]?.ticker ?? "SPY";
  const stubStock = useMemo(
    (): StockMetrics => ({ ticker: chartTicker, currentPrice: selectedTrade?.S ?? 100 } as StockMetrics),
    [chartTicker, selectedTrade?.S],
  );

  const chartMarkers = useMemo((): ChartMarkerInput[] => {
    const same = trades.filter((t) => t.ticker === chartTicker);
    const list = selectedTrade ? [selectedTrade, ...same.filter((t) => t.date !== selectedTrade.date).slice(0, 4)] : same.slice(0, 8);
    return list.map((t) => ({
      date: t.date,
      price: t.S,
      text: "▲",
      detail: `Signal ${t.date} · P&L ${fmtTradePct(t.pnl)}`,
      color: "#22c55e",
    }));
  }, [trades, chartTicker, selectedTrade]);

  const inspectQuery = useQuery({
    queryKey: ["backtest-inspect", inspTicker, inspDate, preset],
    queryFn: async (): Promise<InspectPayload> => {
      const q = new URLSearchParams({ ticker: inspTicker, date: inspDate, preset });
      const r = await fetch(`/api/backtest/inspect?${q}`, { credentials: "include" });
      if (!r.ok) throw new Error(`inspect ${r.status}`);
      return r.json();
    },
    enabled: (tab === "inspector" || tab === "lift") && inspTicker.length >= 1 && inspDate.length >= 8,
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "trades", label: "Trades" },
    { id: "lift", label: "Lift" },
    { id: "inspector", label: "Inspector" },
  ];

  return (
    <div className="space-y-2 min-w-0" data-testid="backtest-lab">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xs font-semibold text-white uppercase tracking-wide">Backtest Lab</h1>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span className="rounded border border-amber-500/40 px-1.5 py-px text-[9px] text-amber-200 cursor-default">
              {summary?.pricing?.badge ?? "model-priced"}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-[10px]">{summary?.pricing?.note ?? "Black-Scholes at IV for history."}</TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span className="rounded border border-zinc-500/50 px-1.5 py-px text-[9px] text-zinc-300 cursor-default">
              static universe
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-[10px]">
            Today&apos;s research universe applied to past dates (survivorship). See E2 in A331.
          </TooltipContent>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            className="rounded border border-[#d4af37]/25 bg-zinc-950 text-[10px] text-white px-1.5 py-0.5"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {Object.entries(catalogQuery.data?.presets ?? { [DEFAULT_PRESET]: { title: "S151 put climax" } }).map(([id, p]) => (
              <option key={id} value={id}>{p.title ?? id}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={runMut.isPending}
            onClick={() => runMut.mutate()}
            className="text-[10px] font-semibold bg-[#d4af37] text-black px-2 py-0.5 rounded disabled:opacity-50"
          >
            {runMut.isPending ? "Running…" : "Re-run"}
          </button>
        </div>
      </div>

      {runMut.isError && (
        <p className="text-[10px] text-red-300">{(runMut.error as Error).message}</p>
      )}

      {summary && (
        <>
          <p className="text-[11px] font-semibold text-white leading-snug" data-testid="backtest-answer-line">
            {buildAnswerLine(summary, holdoutLocked)}
          </p>
          <p className="text-[10px] text-amber-100/90 leading-snug" data-testid="backtest-firing-today">
            Use: {implication.inst} when it fires.{" "}
            <span className="text-white font-semibold">Firing today: {implication.firing}</span>
          </p>
        </>
      )}

      <div className="flex gap-1 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors",
              tab === t.id ? "bg-[#d4af37] text-black border-[#d4af37]" : "border-[#d4af37]/25 text-white hover:bg-white/5",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && summary && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded border border-[#d4af37]/20 p-2 bg-zinc-950/80">
            <p className="text-[9px] uppercase text-[#d4af37] mb-1">Equity vs any-day</p>
            <EquityMini trades={trades} meanBase={vs.meanBase ?? 0} />
          </div>
          <div className="rounded border border-[#d4af37]/20 p-2 bg-zinc-950/80">
            <p className="text-[9px] uppercase text-[#d4af37] mb-1">Monthly P&L heatmap</p>
            <MonthHeatmap trades={trades} />
          </div>
        </div>
      )}

      {tab === "trades" && (
        <div className="grid gap-2 lg:grid-cols-2 min-w-0">
          <div className={GRID_WRAP}>
            <table className="w-full">
              <thead>
                <tr className={GRID_HEADER}>
                  <th className={cn(GRID_TH, "text-left")}>Date</th>
                  <th className={cn(GRID_TH, "text-left")}>Ticker</th>
                  <th className={cn(GRID_TH, "text-right")}>P&L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr
                    key={`${t.ticker}-${t.date}`}
                    className={cn(gridRow(i), "cursor-pointer", selectedTrade?.date === t.date && selectedTrade.ticker === t.ticker && "bg-[#d4af37]/15")}
                    onClick={() => setSelectedTrade(t)}
                  >
                    <td className={GRID_TD}>{t.date}</td>
                    <td className={GRID_TD}>{t.ticker}</td>
                    <td className={cn(GRID_TD, "text-right")}>{fmtTradePct(t.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="h-[360px] min-w-0 overflow-hidden rounded border border-[#d4af37]/15">
            <PriceChart
              tickers={[chartTicker]}
              loadedStocks={[stubStock]}
              selectedPeriod={chartPeriod}
              onPeriodChange={setChartPeriod}
              compact
              showTechnicalZones={false}
              extraMarkers={chartMarkers}
            />
          </div>
        </div>
      )}

      {tab === "lift" && (
        <div className={cn(GRID_WRAP, "max-w-xl")}>
          <p className="text-[10px] text-amber-100/90 mb-2">
            Quintile lift for preset conditions (fit-window edges). Full multi-condition lift ships in P3.
          </p>
          <table className="w-full">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")}>Feature</th>
                <th className={cn(GRID_TH, "text-right")}>Bottom Q hit rate</th>
              </tr>
            </thead>
            <tbody>
              {inspectQuery.data?.conditions
                ? Object.entries(inspectQuery.data.conditions).map(([f, ok], i) => (
                  <tr key={f} className={gridRow(i)}>
                    <td className={GRID_TD}>{f}</td>
                    <td className={cn(GRID_TD, "text-right")}>{ok ? "fires" : "miss"}</td>
                  </tr>
                ))
                : (
                  <tr><td className={GRID_TD} colSpan={2}>Open Inspector tab or pick AAPL 2023-01-04.</td></tr>
                )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "inspector" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <input className="rounded border border-[#d4af37]/25 bg-zinc-950 px-2 py-0.5 text-[10px] w-20" value={inspTicker} onChange={(e) => setInspTicker(e.target.value.toUpperCase())} />
            <input className="rounded border border-[#d4af37]/25 bg-zinc-950 px-2 py-0.5 text-[10px] w-28" value={inspDate} onChange={(e) => setInspDate(e.target.value)} />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded border border-[#d4af37]/20 p-2 bg-zinc-950/80">
              <p className="text-[9px] uppercase text-[#d4af37] mb-1">Features (as of bar close)</p>
              <div className="max-h-48 overflow-auto text-[10px] font-mono space-y-0.5">
                {inspectQuery.isLoading && <span className="text-amber-100/70">Loading…</span>}
                {inspectQuery.data?.features && Object.entries(inspectQuery.data.features).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <span className="text-amber-100/80">{k}</span>
                    <span className="text-white tabular-nums">{v == null ? "—" : v.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded border border-sky-500/30 p-2 bg-zinc-950/80">
              <p className="text-[9px] uppercase text-sky-300 mb-1">What happened next (label)</p>
              <pre className="text-[10px] text-white whitespace-pre-wrap font-mono">
                {inspectQuery.data?.labelOutcomeNext
                  ? JSON.stringify(inspectQuery.data.labelOutcomeNext, null, 2)
                  : "Pick a date with history."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
