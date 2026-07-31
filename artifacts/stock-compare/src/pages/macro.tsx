import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getGetStockQuoteQueryOptions, type StockMetrics } from "@workspace/api-client-react";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWatchlist } from "@/hooks/use-watchlist";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  AreaChart,
  ReferenceLine,
  Area,
  ScatterChart,
  Scatter,
  ComposedChart,
  ReferenceDot,
  BarChart,
  Bar,
} from "recharts";
import {
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Sparkles,
  Calendar,
  AlertTriangle,
  Activity,
  DollarSign,
  Building2,
  Newspaper,
  ExternalLink,
} from "lucide-react";
import { MacroHighlightsPanel } from "@/components/MacroHighlightsPanel";
import { RegimeBanner } from "@/components/macro/RegimeBanner";
import { useAuth } from "@/context/AuthContext";
import { useSessionState } from "@/hooks/use-session-state";


// Types and sub-components extracted for token-efficient editing
import type {
  FredSeries, MarketQuote, YieldCurvePoint, VixCurvePoint, FedFundsCurvePoint,
  ChartPoint, MacroData, MacroCharts, FedMember, MacroEvent, BankResearch,
  SepData, NewsArticle, IndicatorHistory, SepActuals, CurvePeriod, SepMetric,
  MacroTab, COTRecord, COTSummary, SectorRotationPoint,
} from "@/components/macro/macro-page-types";
import {
  fmt, fmtPct, fmtK, fmtB, fmtDate, fmtTs, fmtMonthYear,
  changeColor, inflColor, VIX_LEVEL_LABELS, vixBadgeClass,
  stanceBadgeClass, stanceLabel, getIndicatorHighlight,
} from "@/components/macro/macro-format";
import { CurvePeriodButtons, VixCurveChart, YieldCurveChart, FedFundsCurveChart } from "@/components/macro/macro-curve-charts";
import { RegimeChips, CrossTabReadRow, CompactStat, VolStrip, QuickStats } from "@/components/macro/macro-regime-overview";
import { RegimeAccuracyStrip } from "@/components/macro/regime-accuracy-strip";
import { RateHistoryChart, DualLineHistoryChart, IndicatorHistoryChart, SepDotsChart, BalanceSheetCard } from "@/components/macro/macro-history-charts";
import { MacroRow } from "@/components/macro/macro-indicator-row";
import { LiquidityFlowDiagram, LiquidityImplicationsCard } from "@/components/macro/macro-liquidity-section";
import { SectorRotationBubbles, SectorHeatmapGrid } from "@/components/macro/macro-sector-rotation";
import { VolatilityImplicationsCard, PolicyCspSummary } from "@/components/macro/macro-volatility-policy";
import { FedScaleStrip, BankCard } from "@/components/macro/macro-fed-section";
import { EventRow, CotSection } from "@/components/macro/macro-events-cot";
import {
  TradingViewHeatmap, TradingViewEconomicCalendar, TradingViewMarketOverview, TradingViewForexCrossRates,
} from "@/components/macro/macro-tradingview-embeds";

const MACRO_TABS: { id: MacroTab; label: string }[] = [
  { id: "regime",     label: "Macro & Regime Health" },
  { id: "liquidity",  label: "Liquidity" },
  { id: "volatility", label: "Volatility & Sentiment" },
  { id: "policy",     label: "Policy & Forward Guidance" },
  { id: "heatmap",    label: "Heatmap" },
  { id: "catalyst",   label: "Catalyst Calendar" },
];

const COT_MACRO_IDS = ["sp500", "nasdaq100", "tbonds"];

const TTH = "text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5 text-[#d4af37]";
const TTD = "px-3 py-1.5 text-sm font-mono text-white";

// ── Main component ─────────────────────────────────────────────────────────────

export default function MacroDashboard() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { tickers: watchlistTickers } = useWatchlist();
  const [activeTab, setActiveTab] = useSessionState<MacroTab>("fildi_macro_tab", "regime");
  const [vixPeriod, setVixPeriod] = useState<CurvePeriod>("current");
  const [treasuryPeriod, setTreasuryPeriod] = useState<CurvePeriod>("current");
  const [ffPeriod, setFfPeriod] = useState<CurvePeriod>("current");
  const [selectedIndicatorKey, setSelectedIndicatorKey] = useState<string>("corePce");
  const [selectedSepMetric, setSelectedSepMetric] = useState<SepMetric>("fedRate");
  const [selectedMacroCotId, setSelectedMacroCotId] = useState("sp500");
  const [selectedSentCotId, setSelectedSentCotId] = useState("gold");

  // ?tab= query param overrides the session-persisted tab on load (e.g. /macro?tab=volatility)
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab && MACRO_TABS.some((t) => t.id === tab)) {
      setActiveTab(tab as MacroTab);
    }
  }, []);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: macroData, isLoading, isError, refetch: macroRefetch } = useQuery<MacroData>({
    queryKey: ["macro-data"],
    queryFn: async () => {
      const r = await fetch("/api/macro/data");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<MacroData>;
    },
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: macroCharts } = useQuery<MacroCharts>({
    queryKey: ["macro-charts"],
    queryFn: () => fetch("/api/macro/charts").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: sectorRotation } = useQuery<SectorRotationPoint[]>({
    queryKey: ["macro-sector-rotation"],
    queryFn: () => fetch("/api/macro/sector-rotation").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: activeTab === "liquidity" || activeTab === "heatmap",
  });

  // Only fan out per-ticker quotes when the Heatmap tab is open — used for the
  // "your watchlist in sectors" panel below the TradingView embed.
  const watchlistQuoteQueries = useQueries({
    queries: watchlistTickers.map((ticker) => ({
      ...getGetStockQuoteQueryOptions({ ticker }),
      staleTime: 10 * 60 * 1000,
      enabled: activeTab === "heatmap",
    })),
  });

  const watchlistBySector = useMemo(() => {
    const groups: Record<string, string[]> = {};
    watchlistTickers.forEach((ticker, i) => {
      const data = watchlistQuoteQueries[i]?.data as StockMetrics | undefined;
      const sector = data?.sector || "Unknown";
      (groups[sector] ??= []).push(ticker);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [watchlistTickers, watchlistQuoteQueries]);

  const { data: fedMembers } = useQuery<FedMember[]>({
    queryKey: ["macro-fed-members"],
    queryFn: () => fetch("/api/macro/fed-members").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const { data: events } = useQuery<MacroEvent[]>({
    queryKey: ["macro-events"],
    queryFn: () => fetch("/api/macro/events").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const { data: bankResearch } = useQuery<BankResearch[]>({
    queryKey: ["macro-bank-research"],
    queryFn: () => fetch("/api/macro/bank-research").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const { data: sepData } = useQuery<SepData>({
    queryKey: ["macro-sep"],
    queryFn: () => fetch("/api/macro/sep-projections").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const { data: indicatorHistory, isLoading: indicatorLoading } = useQuery<IndicatorHistory>({
    queryKey: ["macro-indicator-history", selectedIndicatorKey],
    queryFn: () =>
      fetch(`/api/macro/indicator-history?key=${selectedIndicatorKey}`).then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: sepActuals } = useQuery<SepActuals>({
    queryKey: ["macro-sep-actuals"],
    queryFn: () => fetch("/api/macro/sep-actuals").then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: cotSummaries } = useQuery<COTSummary[]>({
    queryKey: ["cot-summary"],
    queryFn: () => fetch("/api/cot/summary").then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: macroCotHistory } = useQuery<COTRecord[]>({
    queryKey: ["cot-history", selectedMacroCotId],
    queryFn: () => fetch(`/api/cot/history?instrument=${selectedMacroCotId}&weeks=52`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !!selectedMacroCotId,
  });

  const { data: sentCotHistory } = useQuery<COTRecord[]>({
    queryKey: ["cot-history", selectedSentCotId],
    queryFn: () => fetch(`/api/cot/history?instrument=${selectedSentCotId}&weeks=52`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !!selectedSentCotId,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const refreshMutation = useMutation({
    mutationFn: () => fetch("/api/macro/refresh", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data: MacroData) => { qc.setQueryData(["macro-data"], data); },
  });

  const generateBankMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/bank-research/generate", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data) => { qc.setQueryData(["macro-bank-research"], data); },
  });

  // ── Derived ───────────────────────────────────────────────────────────────────

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const oneWeekOut = new Date(today);
  oneWeekOut.setDate(today.getDate() + 7);

  const thisWeekEvents = events?.filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d >= today && d <= oneWeekOut;
  }) ?? [];
  const comingUpEvents = events?.filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d > oneWeekOut;
  }) ?? [];

  const sortByPriority = (arr: FedMember[]) =>
    [...arr].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const byStanceVotingFirst = (stance: FedMember["stance"]) => {
    const members = fedMembers?.filter((m) => m.stance === stance) ?? [];
    return [...sortByPriority(members.filter((m) => m.voting)), ...sortByPriority(members.filter((m) => !m.voting))];
  };
  const fedByStance = {
    hawkish: byStanceVotingFirst("hawkish"),
    neutral: byStanceVotingFirst("neutral"),
    dovish:  byStanceVotingFirst("dovish"),
  };

  // ── Loading / Error ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="h-screen">
        <TopNav />
        <div className="flex items-center justify-center mt-14 h-[calc(100vh-3.5rem)]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (isError || (!isLoading && !macroData)) {
    return (
      <div className="h-screen">
        <TopNav />
        <div className="flex flex-col items-center justify-center gap-4 mt-14 h-[calc(100vh-3.5rem)]">
          <AlertTriangle className="h-8 w-8 text-red-400" />
          <p className="text-sm text-muted-foreground">Failed to load macro data.</p>
          <button
            onClick={() => macroRefetch()}
            className="text-xs px-3 py-1.5 rounded-md bg-zinc-950 text-amber-200/70 border border-[#d4af37]/25 hover:bg-[#d4af37] hover:text-black transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const s = macroData!.series;
  const macroCoTs = cotSummaries?.filter((c) => COT_MACRO_IDS.includes(c.instrument)) ?? [];
  const sentCoTs  = cotSummaries?.filter((c) => !COT_MACRO_IDS.includes(c.instrument)) ?? [];

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />

      <main className="flex flex-col mt-14 h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* ── Sub-tabs ────────────────────────────────────────────────────────── */}
        <div className="shrink-0 border-b border-[#d4af37]/20 bg-zinc-950 px-6 py-2 overflow-x-auto">
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {MACRO_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  "px-2.5 py-1.5 transition-colors",
                  activeTab === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">

          {/* ── Tab 1: Macro & Regime Health ─────────────────────────────────── */}
          {activeTab === "regime" && (
            <>
              <RegimeBanner />
              <MacroHighlightsPanel />
              <RegimeChips macroData={macroData!} />
              <RegimeAccuracyStrip />
              <CrossTabReadRow
                volatilityImplications={macroCharts?.volatilityImplications}
                liquidityImplications={macroCharts?.liquidityImplications}
                fedFundsCurve={macroCharts?.fedFundsCurve ?? []}
                sepData={sepData}
                events={events}
                cotSummaries={macroCoTs}
                onJump={setActiveTab}
              />

              {/* Yield & credit stats */}
              <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-md flex flex-wrap items-center divide-x divide-[#d4af37]/10">
                <CompactStat label="10Y" value={`${fmt(macroData!.yield10y.value, 3)}%`}
                  sub={macroData!.yield10y.change != null ? `${macroData!.yield10y.change > 0 ? "+" : ""}${fmt(macroData!.yield10y.change, 3)}` : undefined}
                  subColor={changeColor(macroData!.yield10y.change)} />
                <CompactStat label="2Y" value={`${fmt(macroData!.yield2y.value, 3)}%`}
                  sub={macroData!.yield2y.change != null ? `${macroData!.yield2y.change > 0 ? "+" : ""}${fmt(macroData!.yield2y.change, 3)}` : undefined}
                  subColor={changeColor(macroData!.yield2y.change)} />
                <CompactStat label="2s10s"
                  value={macroData!.yieldSpread != null ? `${macroData!.yieldSpread.toFixed(0)}bps` : "—"}
                  sub={macroData!.yieldSpread != null ? (macroData!.yieldSpread < 0 ? "⚠ Inv" : "Normal") : undefined}
                  subColor={macroData!.yieldSpread != null && macroData!.yieldSpread < 0 ? "text-red-400" : "text-green-400"} />
                <CompactStat label="Fed Funds" value={fmtPct(s.fedFundsRate.value)} />
                <CompactStat label="US Debt" value={macroData!.usDebt != null ? `$${(macroData!.usDebt / 1_000_000).toFixed(1)}T` : "—"} />
              </div>

              {/* Yield Curve + 10Y History */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <YieldCurveChart yieldCurve={macroData!.yieldCurve} period={treasuryPeriod} onPeriodChange={setTreasuryPeriod} />
                <RateHistoryChart title="10Y Treasury" data={macroCharts?.tenYearHistory ?? []} color="#a78bfa" loading={!macroCharts} />
              </div>

              {/* IG/HY Credit Spread + Copper/Gold Ratio */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <DualLineHistoryChart
                  title="Credit Spreads — IG & HY OAS %"
                  data1={macroCharts?.igSpreadHistory ?? []}
                  data2={macroCharts?.hySpreadHistory ?? []}
                  color1="#60a5fa"
                  color2="#fb923c"
                  label1="IG OAS"
                  label2="HY OAS"
                  loading={!macroCharts}
                  yFormatter={(v: number) => `${v.toFixed(1)}%`}
                  tooltipFormatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name]}
                  referenceLines={[{ y: 4, label: "HY Risk-On", color: "#22c55e" }, { y: 7, label: "HY Stress", color: "#ef4444" }]}
                />
                <RateHistoryChart
                  title="Copper / Gold Ratio"
                  data={macroCharts?.copperGoldHistory ?? []}
                  color="#f59e0b" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(4)}
                  tooltipFormatter={(v: number) => [v.toFixed(5)]}
                />
              </div>

              {/* Supply Chain + Liquidity */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <RateHistoryChart
                  title="GSCPI — Global Supply Chain Pressure"
                  data={macroCharts?.gscpiHistory ?? []}
                  color="#34d399" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(2)}
                  tooltipFormatter={(v: number) => [v.toFixed(2)]}
                  referenceLines={[{ y: 0, label: "Neutral", color: "#94a3b8" }, { y: 1.5, label: "Elevated", color: "#f59e0b" }, { y: -1, label: "Easing", color: "#22c55e" }]}
                />
                <RateHistoryChart
                  title="Money Market Fund AUM ($B)"
                  data={macroCharts?.moneyMarketHistory ?? []}
                  color="#60a5fa" loading={!macroCharts}
                  yFormatter={(v: number) => `$${(v / 1000).toFixed(1)}T`}
                  tooltipFormatter={(v: number) => [`$${v.toFixed(0)}B`]}
                />
              </div>

              {/* Financial Conditions + Dollar Strength */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <RateHistoryChart
                  title="Chicago Fed NFCI — Financial Conditions"
                  data={macroCharts?.nfciHistory ?? []}
                  color="#c084fc" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(2)}
                  tooltipFormatter={(v: number) => [v.toFixed(3)]}
                  referenceLines={[
                    { y: 0,    label: "Avg (0)",  color: "#94a3b8" },
                    { y: 0.5,  label: "Tight",    color: "#ef4444" },
                    { y: -0.5, label: "Easy",     color: "#22c55e" },
                  ]}
                />
                <RateHistoryChart
                  title="DXY — US Dollar Index"
                  data={macroCharts?.dxyHistory ?? []}
                  color="#38bdf8" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(1)}
                  tooltipFormatter={(v: number) => [v.toFixed(2)]}
                />
              </div>

              {/* Economic Indicators */}
              <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
                <div
                  className="flex items-center gap-2 px-3 py-1.5 border-b border-[#d4af37]/20 bg-black"
                  title="Blue dot = recently released, yellow dot = upcoming this week. Click a row to view history."
                >
                  <Activity className="h-3.5 w-3.5 text-[#d4af37]/60" />
                  <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Economic Indicators</h3>
                  <div className="flex items-center gap-3 text-[10px] ml-auto text-amber-200/40">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500/70 inline-block" />Recent</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500/70 inline-block" />Upcoming</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-black text-[#d4af37]">
                      <tr className="border-b border-[#d4af37]/25">
                        <th className={cn(TTH, "text-left")}>Indicator</th>
                        <th className={cn(TTH, "text-right")}>Value</th>
                        <th className={cn(TTH, "text-right")}>MoM / QoQ</th>
                        <th className={cn(TTH, "text-right")}>YoY</th>
                        <th className={cn(TTH, "text-right")}>Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {[
                        { key: "cpi",              label: "CPI",               series: s.cpi,               inflSign: true,  mom: s.cpi.change,              yoy: s.cpi.yoy,              value: `${fmt(s.cpi.value, 1)} idx` },
                        { key: "coreCpi",           label: "Core CPI",          series: s.coreCpi,           inflSign: true,  mom: s.coreCpi.change,          yoy: s.coreCpi.yoy,          value: `${fmt(s.coreCpi.value, 1)} idx` },
                        { key: "corePce",           label: "Core PCE (Fed ★)",  series: s.corePce,           inflSign: true,  mom: s.corePce.change,          yoy: s.corePce.yoy,          value: `${fmt(s.corePce.value, 1)} idx` },
                        { key: "ppi",               label: "PPI",               series: s.ppi,               inflSign: true,  mom: s.ppi.change,              yoy: s.ppi.yoy,              value: `${fmt(s.ppi.value, 1)} idx` },
                        { key: "unemployment",      label: "Unemployment",      series: s.unemployment,      inflSign: true,  mom: s.unemployment.change,     yoy: null,                   value: fmtPct(s.unemployment.value) },
                        { key: "nonfarmPayrolls",   label: "Nonfarm Payrolls",  series: s.nonfarmPayrolls,   inflSign: false, mom: null, momRaw: fmtK(s.nonfarmPayrolls.change), yoy: null, value: fmtK(s.nonfarmPayrolls.value) },
                        { key: "jolts",             label: "JOLTS Openings",    series: s.jolts,             inflSign: false, mom: null, momRaw: fmtK(s.jolts.change),           yoy: null, value: fmtK(s.jolts.value) },
                        { key: "gdp",               label: "GDP (annualized)",  series: s.gdp,               inflSign: false, mom: s.gdp.change,              yoy: null,                   value: fmtPct(s.gdp.value) },
                        { key: "retailSales",       label: "Retail Sales",      series: s.retailSales,       inflSign: false, mom: null, momRaw: s.retailSales.change != null ? `${s.retailSales.change > 0 ? "+" : ""}${fmtB(s.retailSales.change)}` : null, yoy: s.retailSales.yoy, value: fmtB(s.retailSales.value) },
                        { key: "consumerSentiment", label: "Consumer Sentiment", series: s.consumerSentiment, inflSign: false, mom: s.consumerSentiment.change, yoy: s.consumerSentiment.yoy, value: fmt(s.consumerSentiment.value, 1) },
                        { key: "fedFundsRate",      label: "Fed Funds Rate",    series: s.fedFundsRate,      inflSign: false, mom: s.fedFundsRate.change,     yoy: null, value: fmtPct(s.fedFundsRate.value) },
                        ...(s.ismManufacturing ? [{ key: "ismManufacturing", label: "ISM Manufacturing PMI", series: s.ismManufacturing, inflSign: false, mom: s.ismManufacturing.change, yoy: null, value: fmt(s.ismManufacturing.value, 1) }] : []),
                      ].map((row) => (
                        <MacroRow
                          key={row.key} indicatorKey={row.key} label={row.label} value={row.value}
                          mom={"mom" in row ? row.mom ?? null : null}
                          momRaw={"momRaw" in row ? row.momRaw ?? null : null}
                          yoy={row.yoy ?? null} date={row.series.date} inflSign={row.inflSign}
                          isSelected={selectedIndicatorKey === row.key}
                          highlight={getIndicatorHighlight(row.label, row.series.date, events ?? [], todayStr)}
                          onSelect={() => setSelectedIndicatorKey(row.key)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-[#d4af37]/20 p-3">
                  <IndicatorHistoryChart data={indicatorHistory} loading={indicatorLoading} />
                </div>
              </div>

              {/* COT — Equity & Rates (S&P, NASDAQ, T-Bonds) */}
              {macroCoTs.length > 0 && (
                <CotSection
                  title="COT Positioning — Equity & Rates"
                  summaries={macroCoTs}
                  history={macroCotHistory}
                  selectedInstrument={selectedMacroCotId}
                  onSelectInstrument={setSelectedMacroCotId}
                />
              )}
            </>
          )}

          {/* ── Tab: Liquidity ───────────────────────────────────────────────── */}
          {activeTab === "liquidity" && (
            <>
              <LiquidityImplicationsCard
                data={macroCharts?.liquidityImplications}
                loading={!macroCharts}
              />

              <LiquidityFlowDiagram
                fedAssetsHistory={macroCharts?.fedAssetsHistory ?? []}
                tgaHistory={macroCharts?.tgaHistory ?? []}
                rrpHistory={macroCharts?.rrpHistory ?? []}
                netLiquidityHistory={macroCharts?.netLiquidityHistory ?? []}
                loading={!macroCharts}
              />

              <div className="grid grid-cols-2 gap-4">
                <RateHistoryChart
                  title="Net Liquidity ($B)"
                  data={macroCharts?.netLiquidityHistory ?? []}
                  color="#22c55e" loading={!macroCharts}
                  yFormatter={(v: number) => `$${(v / 1000).toFixed(1)}T`}
                  tooltipFormatter={(v: number) => [`$${v.toFixed(0)}B`]}
                />
                <RateHistoryChart
                  title="Overnight RRP ($B)"
                  data={macroCharts?.rrpHistory ?? []}
                  color="#fb923c" loading={!macroCharts}
                  yFormatter={(v: number) => `$${v.toFixed(0)}B`}
                  tooltipFormatter={(v: number) => [`$${v.toFixed(1)}B`]}
                />
                <RateHistoryChart
                  title="Money Market Fund AUM ($B)"
                  data={macroCharts?.moneyMarketHistory ?? []}
                  color="#60a5fa" loading={!macroCharts}
                  yFormatter={(v: number) => `$${(v / 1000).toFixed(1)}T`}
                  tooltipFormatter={(v: number) => [`$${v.toFixed(0)}B`]}
                />
                <RateHistoryChart
                  title="Chicago Fed NFCI — Financial Conditions"
                  data={macroCharts?.nfciHistory ?? []}
                  color="#c084fc" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(2)}
                  tooltipFormatter={(v: number) => [v.toFixed(3)]}
                  referenceLines={[
                    { y: 0,    label: "Avg (0)",  color: "#94a3b8" },
                    { y: 0.5,  label: "Tight",    color: "#ef4444" },
                    { y: -0.5, label: "Easy",     color: "#22c55e" },
                  ]}
                />
                <RateHistoryChart
                  title="Bank Reserves ($T)"
                  data={macroCharts?.reservesHistory ?? []}
                  color="#2dd4bf" loading={!macroCharts}
                  yFormatter={(v: number) => `$${(v / 1_000_000).toFixed(1)}T`}
                  tooltipFormatter={(v: number) => [`$${(v / 1000).toFixed(0)}B`]}
                />
                <RateHistoryChart
                  title="SOFR − IORB (bps) — reserve scarcity"
                  data={macroCharts?.sofrIorbSpreadHistory ?? []}
                  color="#f472b6" loading={!macroCharts}
                  yFormatter={(v: number) => `${v.toFixed(0)}bp`}
                  tooltipFormatter={(v: number) => [`${v.toFixed(1)}bp`]}
                  referenceLines={[
                    { y: 0,  label: "Ample (0)",  color: "#22c55e" },
                    { y: 15, label: "Scarce",     color: "#ef4444" },
                  ]}
                />
              </div>

              <SectorRotationBubbles data={sectorRotation} loading={!sectorRotation} />
            </>
          )}

          {/* ── Tab 2: Volatility & Sentiment ────────────────────────────────── */}
          {activeTab === "volatility" && (
            <>
              <VolatilityImplicationsCard
                data={macroCharts?.volatilityImplications}
                loading={!macroCharts}
              />

              {/* Vol stats — compact single-line strip */}
              <VolStrip macroData={macroData!} macroCharts={macroCharts} />

              {/* 6 charts, 2 rows x 3 */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <VixCurveChart vixCurve={macroCharts?.vixCurve ?? []} loading={!macroCharts} period={vixPeriod} onPeriodChange={setVixPeriod} />
                <RateHistoryChart title="VIX History" data={macroCharts?.vixHistory ?? []} color="#facc15" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(1)} tooltipFormatter={(v: number) => [v.toFixed(2)]}
                  referenceLines={[{ y: 20, label: "Elevated", color: "#f59e0b" }, { y: 30, label: "Fear", color: "#ef4444" }]} />
                <RateHistoryChart title="CBOE VVIX (Vol of VIX)" data={macroCharts?.putCallHistory ?? []} color="#38bdf8" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(0)} tooltipFormatter={(v: number) => [v.toFixed(1)]}
                  referenceLines={[{ y: 100, label: "Elevated", color: "#f59e0b" }, { y: 120, label: "Panic", color: "#ef4444" }]} />
                <RateHistoryChart title="Fear & Greed Index" data={macroCharts?.fearGreedHistory ?? []} color="#f472b6" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(0)} tooltipFormatter={(v: number) => [v.toFixed(1)]}
                  referenceLines={[{ y: 25, label: "Fear", color: "#ef4444" }, { y: 75, label: "Greed", color: "#22c55e" }]} />
                <RateHistoryChart title="CBOE Equity Put/Call Ratio" data={macroCharts?.putCallRatioHistory ?? []} color="#a78bfa" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(2)} tooltipFormatter={(v: number) => [v.toFixed(2)]}
                  referenceLines={[{ y: 0.7, label: "Bullish", color: "#22c55e" }, { y: 1.0, label: "Bearish", color: "#ef4444" }]} />
                <RateHistoryChart title="MOVE Index (Bond Vol)" data={macroCharts?.moveHistory ?? []} color="#fb7185" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(0)} tooltipFormatter={(v: number) => [v.toFixed(1)]}
                  referenceLines={[{ y: 90, label: "Calm", color: "#22c55e" }, { y: 140, label: "Stress", color: "#ef4444" }]} />
              </div>
              {/* COT — Commodities, Crypto & FX */}
              {sentCoTs.length > 0 && (
                <CotSection
                  title="COT Positioning — Commodities, Crypto & FX"
                  summaries={sentCoTs}
                  history={sentCotHistory}
                  selectedInstrument={selectedSentCotId}
                  onSelectInstrument={setSelectedSentCotId}
                />
              )}
            </>
          )}

          {/* ── Tab 3: Policy & Forward Guidance ─────────────────────────────── */}
          {activeTab === "policy" && (
            <>
              <PolicyCspSummary
                fedFundsCurve={macroCharts?.fedFundsCurve ?? []}
                sepData={sepData}
                events={events}
                volatilityImplications={macroCharts?.volatilityImplications}
                todayStr={todayStr}
                onViewRegime={() => setActiveTab("regime")}
                loading={!macroCharts}
              />

              {/* Fed Funds Curve + history + SEP dots + Balance Sheet — compact one-line row */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <FedFundsCurveChart data={macroCharts?.fedFundsCurve ?? []} loading={!macroCharts} period={ffPeriod} onPeriodChange={setFfPeriod} compact />
                <RateHistoryChart title="Fed Funds Rate (History)" data={macroCharts?.fedFundsHistory ?? []} color="#4ade80" loading={!macroCharts}
                  yFormatter={(v: number) => `${v.toFixed(2)}%`} tooltipFormatter={(v: number) => [`${v.toFixed(3)}%`]} compact />
                <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-[#d4af37]/60" />
                      SEP Projections
                    </h3>
                    <div className="flex rounded-md border border-[#d4af37]/20 overflow-hidden text-[9px]">
                      {(["fedRate", "gdp", "unemployment", "corePce"] as SepMetric[]).map((m) => (
                        <button key={m} onClick={() => setSelectedSepMetric(m)}
                          className={cn("px-1.5 py-0.5 transition-colors", selectedSepMetric === m ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                          {m === "fedRate" ? "Rate" : m === "gdp" ? "GDP" : m === "unemployment" ? "Unemp." : "PCE"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sepData ? (
                    <SepDotsChart sepData={sepData} actuals={sepActuals} metric={selectedSepMetric} compact />
                  ) : (
                    <div style={{ height: 120 }} className="flex items-center justify-center text-xs text-amber-200/40">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  )}
                </div>
                <BalanceSheetCard
                  fedAssetsHistory={macroCharts?.fedAssetsHistory ?? []}
                  rrpSignal={macroCharts?.liquidityImplications?.signals.find((s) => s.label === "RRP Buffer")}
                  loading={!macroCharts}
                  compact
                />
              </div>

              {/* SEP Projections table — ag-grid styled */}
              {sepData && (
                <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
                  <div
                    className="flex items-center justify-between px-3 py-1.5 border-b border-[#d4af37]/20 bg-black"
                    title={`FOMC SEP ${sepData.asOf} — updated after each SEP release`}
                  >
                    <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-[#d4af37]/60" />
                      Fed SEP Projections
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-black text-[#d4af37]">
                        <tr className="border-b border-[#d4af37]/25">
                          <th className={cn(TTH, "text-left")}>Metric</th>
                          {sepData.projections.map((p) => <th key={p.year} className={cn(TTH, "text-right")}>{p.year}</th>)}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800">
                        {([
                          { label: "Fed Rate (median dot)", get: (p: typeof sepData.projections[number]) => fmtPct(p.fedRate, 3), bold: true },
                          { label: "GDP Growth", get: (p: typeof sepData.projections[number]) => fmtPct(p.gdp, 1) },
                          { label: "Unemployment", get: (p: typeof sepData.projections[number]) => fmtPct(p.unemployment, 1) },
                          { label: "Core PCE", get: (p: typeof sepData.projections[number]) => fmtPct(p.corePce, 1) },
                        ]).map((row) => (
                          <tr key={row.label} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                            <td className={cn(TTD, "text-left text-amber-200/60")}>{row.label}</td>
                            {sepData.projections.map((p) => (
                              <td key={p.year} className={cn(TTD, "text-right", row.bold && "font-semibold")}>{row.get(p)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Bank Research — 2 rows of 4 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-[#d4af37]/60" />
                    Bank Research
                  </h3>
                  {isAdmin && (
                    <button onClick={() => generateBankMutation.mutate()} disabled={generateBankMutation.isPending}
                      className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-zinc-950 hover:bg-[#d4af37] hover:text-black border border-[#d4af37]/25 text-amber-200/70 transition-colors disabled:opacity-50">
                      {generateBankMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      Refresh Stances
                    </button>
                  )}
                </div>
                {generateBankMutation.isPending && (
                  <div className="flex items-center gap-2 py-3 justify-center text-xs text-amber-200/40">
                    <Loader2 className="h-4 w-4 animate-spin" />Generating bank stances…
                  </div>
                )}
                {bankResearch && !generateBankMutation.isPending && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {bankResearch.map((bank) => <BankCard key={bank.name} bank={bank} />)}
                  </div>
                )}
              </div>

              {/* Fed Members — compact hawkish↔dovish scale */}
              <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-lg p-2.5 space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Fed Members</h3>
                <FedScaleStrip hawkish={fedByStance.hawkish} neutral={fedByStance.neutral} dovish={fedByStance.dovish} />
              </div>
            </>
          )}

          {/* ── Tab 4: Heatmap ────────────────────────────────────────────────── */}
          {activeTab === "heatmap" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide" title="Market-cap weighted, colored by daily % change">
                  S&P 500 Sector Heatmap
                </h3>
                <TradingViewHeatmap />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide" title="1D / 1W / 1M price performance by sector ETF">
                  Sector Money Flow
                </h3>
                <SectorHeatmapGrid data={sectorRotation} loading={activeTab === "heatmap" && !sectorRotation} />
              </div>
              {watchlistTickers.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Your Watchlist, by Sector</h3>
                    <Button size="sm" variant="outline" onClick={() => navigate("/options-scanner")}
                      className="bg-zinc-950 text-amber-200/70 border-[#d4af37]/25 hover:bg-[#d4af37] hover:text-black">
                      Open scanner
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {watchlistBySector.map(([sector, sTickers]) => (
                      <div key={sector} className="flex items-center gap-1.5 text-xs">
                        <span className="text-amber-200/40">{sector}:</span>
                        {sTickers.map((ticker) => (
                          <Badge
                            key={ticker}
                            variant="secondary"
                            className="text-xs font-mono cursor-pointer bg-zinc-950 text-amber-200/70 border border-[#d4af37]/20 hover:bg-[#d4af37]/20"
                            onClick={() => navigate(`/watchlist?ticker=${ticker}`)}
                          >
                            {ticker}
                          </Badge>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide" title="Indices, bonds, commodities & forex">
                  Market Overview
                </h3>
                <TradingViewMarketOverview />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide" title="Major currency pairs, USD strength context">
                  Forex Cross Rates
                </h3>
                <TradingViewForexCrossRates />
              </div>
            </div>
          )}

          {/* ── Tab 5: Catalyst Calendar ──────────────────────────────────────── */}
          {activeTab === "catalyst" && (
            <div className="space-y-2">
              {/* Your Week — curated macro releases, clickable through to Regime tab */}
              {events && events.length > 0 && (
                <div className="space-y-1.5">
                  <h3
                    className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5"
                    title="Curated high-signal releases — the TradingView calendar below is the global feed. High-importance releases jump to their indicator history on the Regime tab."
                  >
                    <Calendar className="h-3.5 w-3.5 text-[#d4af37]/60" />
                    Your Week
                  </h3>
                  {thisWeekEvents.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-amber-200/40 uppercase tracking-wide font-medium">This Week</p>
                      {thisWeekEvents.map((ev) => (
                        <EventRow
                          key={ev.date + ev.event}
                          event={ev}
                          todayStr={todayStr}
                          onJumpToIndicator={(key) => { setSelectedIndicatorKey(key); setActiveTab("regime"); }}
                        />
                      ))}
                    </div>
                  )}
                  {comingUpEvents.length > 0 && (
                    <div className="space-y-1.5 mt-1">
                      <p className="text-[10px] text-amber-200/40 uppercase tracking-wide font-medium">Coming Up</p>
                      {comingUpEvents.map((ev) => (
                        <EventRow
                          key={ev.date + ev.event}
                          event={ev}
                          todayStr={todayStr}
                          onJumpToIndicator={(key) => { setSelectedIndicatorKey(key); setActiveTab("regime"); }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <h3
                className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5"
                title="US high-importance macro releases, powered by TradingView"
              >
                <Calendar className="h-3.5 w-3.5 text-[#d4af37]/60" />
                Economic Calendar
              </h3>
              <TradingViewEconomicCalendar />
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

// ── Regime chips ────────────────────────────────────────────────────────────────
