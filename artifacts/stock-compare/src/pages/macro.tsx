import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
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
  stanceBadgeClass, stanceLabel, getIndicatorHighlight, CurvePeriodButtons,
  RegimeChips, CrossTabReadRow, StatCell, VolStrip, QuickStats, VixCurveChart, YieldCurveChart,
  FedFundsCurveChart, RateHistoryChart, DualLineHistoryChart, MacroRow, IndicatorHistoryChart,
  LiquidityFlowDiagram, SectorRotationBubbles, LiquidityImplicationsCard, VolatilityImplicationsCard,
  BalanceSheetCard,
  PolicyCspSummary,
  SepDotsChart, FedScaleStrip, BankCard, EventRow,
  CotSection, TradingViewHeatmap, TradingViewEconomicCalendar,
  TradingViewMarketOverview, TradingViewForexCrossRates,
} from "@/components/macro/MacroComponents";

const MACRO_TABS: { id: MacroTab; label: string }[] = [
  { id: "regime",     label: "Macro & Regime Health" },
  { id: "liquidity",  label: "Liquidity" },
  { id: "volatility", label: "Volatility & Sentiment" },
  { id: "policy",     label: "Policy & Forward Guidance" },
  { id: "heatmap",    label: "Heatmap" },
  { id: "catalyst",   label: "Catalyst Calendar" },
];

const COT_MACRO_IDS = ["sp500", "nasdaq100", "tbonds"];

const TTH = "py-2 px-3 font-medium text-[10px] uppercase tracking-widest text-muted-foreground";
const TTD = "py-2 px-3 text-xs tabular-nums";

// ── Main component ─────────────────────────────────────────────────────────────

export default function MacroDashboard() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
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
    enabled: activeTab === "liquidity",
  });

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
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary transition-colors"
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
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="flex flex-col mt-14 h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="shrink-0 border-b border-border bg-background px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Macro Dashboard</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Holistic financial markets monitor</p>
          </div>
          <div className="flex items-center gap-3">
            {macroData && (
              <span className="text-xs text-muted-foreground">Updated {fmtTs(macroData.fetchedAt)}</span>
            )}
            {isAdmin && (
              <button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary transition-colors disabled:opacity-50"
              >
                {refreshMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </button>
            )}
          </div>
        </div>

        {/* ── Sub-tabs ────────────────────────────────────────────────────────── */}
        <div className="shrink-0 flex border-b border-border px-6 bg-background overflow-x-auto">
          {MACRO_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                "text-xs font-medium px-4 py-2.5 border-b-2 transition-colors -mb-px whitespace-nowrap rounded-t-md",
                activeTab === t.id
                  ? "border-primary text-foreground bg-primary/10"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* ── Tab 1: Macro & Regime Health ─────────────────────────────────── */}
          {activeTab === "regime" && (
            <>
              <RegimeBanner />
              <MacroHighlightsPanel />
              <RegimeChips macroData={macroData!} />
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
              <div className="flex flex-wrap gap-2">
                <StatCell label="10Y Yield" value={`${fmt(macroData!.yield10y.value, 3)}%`}
                  sub={macroData!.yield10y.change != null ? `${macroData!.yield10y.change > 0 ? "+" : ""}${fmt(macroData!.yield10y.change, 3)}` : undefined}
                  subColor={changeColor(macroData!.yield10y.change)} />
                <StatCell label="2Y Yield" value={`${fmt(macroData!.yield2y.value, 3)}%`}
                  sub={macroData!.yield2y.change != null ? `${macroData!.yield2y.change > 0 ? "+" : ""}${fmt(macroData!.yield2y.change, 3)}` : undefined}
                  subColor={changeColor(macroData!.yield2y.change)} />
                <StatCell label="2s10s Spread"
                  value={macroData!.yieldSpread != null ? `${macroData!.yieldSpread.toFixed(0)} bps` : "—"}
                  sub={macroData!.yieldSpread != null ? (macroData!.yieldSpread < 0 ? "⚠ Inverted" : "Normal") : undefined}
                  subColor={macroData!.yieldSpread != null && macroData!.yieldSpread < 0 ? "text-red-400" : "text-green-400"} />
                <StatCell label="Fed Funds" value={fmtPct(s.fedFundsRate.value)} />
                <StatCell label="US Debt" value={macroData!.usDebt != null ? `$${(macroData!.usDebt / 1_000_000).toFixed(1)}T` : "—"} />
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
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/20">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">Economic Indicators</h2>
                  <span className="text-[10px] text-muted-foreground italic ml-auto">Click a row to view history</span>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500/70 inline-block" />Recently released</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500/70 inline-block" />Upcoming this week</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-secondary/10 text-muted-foreground">
                        <th className="text-left px-4 py-2 font-medium">Indicator</th>
                        <th className="text-right px-3 py-2 font-medium">Value</th>
                        <th className="text-right px-3 py-2 font-medium">MoM / QoQ</th>
                        <th className="text-right px-3 py-2 font-medium">YoY</th>
                        <th className="text-right px-4 py-2 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
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
                <div className="border-t border-border p-4">
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
              <p className="text-[10px] text-muted-foreground/60 -mt-2" title="MOVE tracks bond-market (rates) implied volatility, not equity vol">
                MOVE = bond-market vol, not equity vol — it often leads VIX during rate-shock-driven stress.
              </p>

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
                <div className="border border-border rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-purple-400" />
                      SEP Projections
                    </h3>
                    <div className="flex rounded-md border border-border overflow-hidden text-[9px]">
                      {(["fedRate", "gdp", "unemployment", "corePce"] as SepMetric[]).map((m) => (
                        <button key={m} onClick={() => setSelectedSepMetric(m)}
                          className={cn("px-1.5 py-0.5 transition-colors", selectedSepMetric === m ? "bg-purple-600 text-white" : "hover:bg-secondary")}>
                          {m === "fedRate" ? "Rate" : m === "gdp" ? "GDP" : m === "unemployment" ? "Unemp." : "PCE"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sepData ? (
                    <SepDotsChart sepData={sepData} actuals={sepActuals} metric={selectedSepMetric} compact />
                  ) : (
                    <div style={{ height: 120 }} className="flex items-center justify-center text-xs text-muted-foreground">
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
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/20">
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-purple-400" />
                      Fed SEP Projections
                    </h2>
                    <span className="text-[10px] text-muted-foreground italic">FOMC SEP {sepData.asOf} — updated after each SEP release</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-y border-border/40 bg-secondary/20">
                          <th className={cn(TTH, "text-left")}>Metric</th>
                          {sepData.projections.map((p) => <th key={p.year} className={cn(TTH, "text-right")}>{p.year}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          { label: "Fed Rate (median dot)", get: (p: typeof sepData.projections[number]) => fmtPct(p.fedRate, 3), bold: true },
                          { label: "GDP Growth", get: (p: typeof sepData.projections[number]) => fmtPct(p.gdp, 1) },
                          { label: "Unemployment", get: (p: typeof sepData.projections[number]) => fmtPct(p.unemployment, 1) },
                          { label: "Core PCE", get: (p: typeof sepData.projections[number]) => fmtPct(p.corePce, 1) },
                        ]).map((row, i) => (
                          <tr key={row.label} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                            <td className={cn(TTD, "text-left text-muted-foreground")}>{row.label}</td>
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
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-blue-400" />
                    Bank Research
                  </h2>
                  {isAdmin && (
                    <button onClick={() => generateBankMutation.mutate()} disabled={generateBankMutation.isPending}
                      className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary transition-colors disabled:opacity-50">
                      {generateBankMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      Refresh Stances
                    </button>
                  )}
                </div>
                {generateBankMutation.isPending && (
                  <div className="flex items-center gap-2 py-3 justify-center text-xs text-muted-foreground">
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
              <div className="border border-border rounded-lg p-4 space-y-3">
                <h2 className="text-sm font-semibold">Fed Members</h2>
                <FedScaleStrip hawkish={fedByStance.hawkish} neutral={fedByStance.neutral} dovish={fedByStance.dovish} />
              </div>
            </>
          )}

          {/* ── Tab 4: Heatmap ────────────────────────────────────────────────── */}
          {activeTab === "heatmap" && (
            <div className="space-y-8">
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">S&P 500 Sector Heatmap</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Market-cap weighted · colored by daily % change · powered by TradingView</p>
                </div>
                <TradingViewHeatmap />
              </div>
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">Market Overview</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Indices, bonds, commodities & forex · powered by TradingView</p>
                </div>
                <TradingViewMarketOverview />
              </div>
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">Forex Cross Rates</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Major currency pairs · USD strength context · powered by TradingView</p>
                </div>
                <TradingViewForexCrossRates />
              </div>
            </div>
          )}

          {/* ── Tab 5: Catalyst Calendar ──────────────────────────────────────── */}
          {activeTab === "catalyst" && (
            <div className="space-y-4">
              {/* Your Week — curated macro releases, clickable through to Regime tab */}
              {events && events.length > 0 && (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      Your Week
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Curated high-signal releases only — the TradingView calendar below is the global feed and can't be
                      filtered to your book. High-importance releases jump to their indicator history on the Regime tab.
                    </p>
                  </div>
                  {thisWeekEvents.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">This Week</p>
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
                    <div className="space-y-1.5 mt-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Coming Up</p>
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

              <div className="pt-2">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  Economic Calendar
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">US high-importance macro releases · powered by TradingView</p>
              </div>
              <TradingViewEconomicCalendar />
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

// ── Regime chips ────────────────────────────────────────────────────────────────
