import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
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


// Types and sub-components extracted for token-efficient editing
import type {
  FredSeries, MarketQuote, YieldCurvePoint, VixCurvePoint, FedFundsCurvePoint,
  ChartPoint, MacroData, MacroCharts, FedMember, MacroEvent, BankResearch,
  SepData, NewsArticle, IndicatorHistory, SepActuals, CurvePeriod, SepMetric,
  MacroTab, COTRecord, COTSummary,
} from "@/components/macro/macro-page-types";
import {
  fmt, fmtPct, fmtK, fmtB, fmtDate, fmtTs, fmtMonthYear,
  changeColor, inflColor, VIX_LEVEL_LABELS, vixBadgeClass,
  stanceBadgeClass, stanceLabel, getIndicatorHighlight, CurvePeriodButtons,
  RegimeChips, StatCell, QuickStats, VixCurveChart, YieldCurveChart,
  FedFundsCurveChart, RateHistoryChart, DualLineHistoryChart, MacroRow, IndicatorHistoryChart,
  SepDotsChart, FedStanceGroup, FedMemberCard, BankCard, EventRow,
  CotSection, TradingViewHeatmap, TradingViewEconomicCalendar,
  TradingViewMarketOverview, TradingViewForexCrossRates,
} from "@/components/macro/MacroComponents";

const MACRO_TABS: { id: MacroTab; label: string }[] = [
  { id: "regime",     label: "Macro & Regime Health" },
  { id: "volatility", label: "Volatility & Sentiment" },
  { id: "policy",     label: "Policy & Forward Guidance" },
  { id: "heatmap",    label: "Heatmap" },
  { id: "catalyst",   label: "Catalyst Calendar" },
];

const COT_MACRO_IDS = ["sp500", "nasdaq100", "tbonds"];

// ── Main component ─────────────────────────────────────────────────────────────

export default function MacroDashboard() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<MacroTab>("regime");
  const [fedSection, setFedSection] = useState<"voting" | "all">("voting");
  const [vixPeriod, setVixPeriod] = useState<CurvePeriod>("current");
  const [treasuryPeriod, setTreasuryPeriod] = useState<CurvePeriod>("current");
  const [ffPeriod, setFfPeriod] = useState<CurvePeriod>("current");
  const [selectedIndicatorKey, setSelectedIndicatorKey] = useState<string>("corePce");
  const [selectedSepMetric, setSelectedSepMetric] = useState<SepMetric>("fedRate");
  const [selectedMacroCotId, setSelectedMacroCotId] = useState("sp500");
  const [selectedSentCotId, setSelectedSentCotId] = useState("gold");

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: macroData, isLoading, isError, refetch: macroRefetch } = useQuery<MacroData>({
    queryKey: ["macro-data"],
    queryFn: () => fetch("/api/macro/data").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: macroCharts } = useQuery<MacroCharts>({
    queryKey: ["macro-charts"],
    queryFn: () => fetch("/api/macro/charts").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
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

  const votingByStance = {
    hawkish: sortByPriority(fedMembers?.filter((m) => m.voting && m.stance === "hawkish") ?? []),
    neutral: sortByPriority(fedMembers?.filter((m) => m.voting && m.stance === "neutral") ?? []),
    dovish:  sortByPriority(fedMembers?.filter((m) => m.voting && m.stance === "dovish")  ?? []),
  };
  const nonVotingByStance = {
    hawkish: sortByPriority(fedMembers?.filter((m) => !m.voting && m.stance === "hawkish") ?? []),
    neutral: sortByPriority(fedMembers?.filter((m) => !m.voting && m.stance === "neutral") ?? []),
    dovish:  sortByPriority(fedMembers?.filter((m) => !m.voting && m.stance === "dovish")  ?? []),
  };

  // ── Loading / Error ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex flex-1 items-center justify-center" style={{ marginLeft: 'var(--sidebar-w, 220px)', transition: 'margin-left 200ms ease' }}>
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex flex-1 flex-col items-center justify-center gap-4" style={{ marginLeft: 'var(--sidebar-w, 220px)', transition: 'margin-left 200ms ease' }}>
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
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />

      <main
        className="flex-1 flex flex-col overflow-hidden"
        style={{ marginLeft: "var(--sidebar-w, 220px)", transition: "margin-left 200ms ease" }}
      >
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
                "text-xs font-medium px-4 py-2.5 border-b-2 transition-colors -mb-px whitespace-nowrap",
                activeTab === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
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

          {/* ── Tab 2: Volatility & Sentiment ────────────────────────────────── */}
          {activeTab === "volatility" && (
            <>
              {/* Vol stats */}
              <div className="flex flex-wrap gap-2">
                <StatCell label="VIX" value={fmt(macroData!.vix.value, 1)}
                  sub={macroData!.vix.change != null ? `${macroData!.vix.change > 0 ? "+" : ""}${fmt(macroData!.vix.change, 2)}` : undefined}
                  subColor={changeColor(macroData!.vix.change ?? null)} />
                <StatCell label="SKEW" value={fmt(macroData!.skew.value, 1)}
                  sub={macroData!.skew.change != null ? `${macroData!.skew.change > 0 ? "+" : ""}${fmt(macroData!.skew.change, 2)}` : undefined}
                  subColor={changeColor(macroData!.skew.change ?? null)} />
                <StatCell label="VXN (NDX)" value={fmt(macroData!.vxn.value, 1)}
                  sub={macroData!.vxn.change != null ? `${macroData!.vxn.change > 0 ? "+" : ""}${fmt(macroData!.vxn.change, 2)}` : undefined}
                  subColor={changeColor(macroData!.vxn.change ?? null)} />
              </div>

              {/* VIX Curve + VIX History */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <VixCurveChart vixCurve={macroCharts?.vixCurve ?? []} loading={!macroCharts} period={vixPeriod} onPeriodChange={setVixPeriod} />
                <RateHistoryChart title="VIX History" data={macroCharts?.vixHistory ?? []} color="#facc15" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(1)} tooltipFormatter={(v: number) => [v.toFixed(2)]}
                  referenceLines={[{ y: 20, label: "Elevated", color: "#f59e0b" }, { y: 30, label: "Fear", color: "#ef4444" }]} />
              </div>

              {/* Fear & Greed + VVIX */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <RateHistoryChart title="Fear & Greed Index" data={macroCharts?.fearGreedHistory ?? []} color="#f472b6" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(0)} tooltipFormatter={(v: number) => [v.toFixed(1)]}
                  referenceLines={[{ y: 25, label: "Fear", color: "#ef4444" }, { y: 75, label: "Greed", color: "#22c55e" }]} />
                <RateHistoryChart title="CBOE VVIX (Vol of VIX)" data={macroCharts?.putCallHistory ?? []} color="#38bdf8" loading={!macroCharts}
                  yFormatter={(v: number) => v.toFixed(0)} tooltipFormatter={(v: number) => [v.toFixed(1)]}
                  referenceLines={[{ y: 100, label: "Elevated", color: "#f59e0b" }, { y: 120, label: "Panic", color: "#ef4444" }]} />
              </div>

              {/* CBOE Equity Put/Call Ratio */}
              <RateHistoryChart title="CBOE Equity Put/Call Ratio" data={macroCharts?.putCallRatioHistory ?? []} color="#a78bfa" loading={!macroCharts}
                yFormatter={(v: number) => v.toFixed(2)} tooltipFormatter={(v: number) => [v.toFixed(2)]}
                referenceLines={[{ y: 0.7, label: "Bullish", color: "#22c55e" }, { y: 1.0, label: "Bearish", color: "#ef4444" }]} />

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
              {/* Fed Funds Curve + history */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <FedFundsCurveChart data={macroCharts?.fedFundsCurve ?? []} loading={!macroCharts} period={ffPeriod} onPeriodChange={setFfPeriod} />
                <RateHistoryChart title="Fed Funds Rate (History)" data={macroCharts?.fedFundsHistory ?? []} color="#4ade80" loading={!macroCharts}
                  yFormatter={(v: number) => `${v.toFixed(2)}%`} tooltipFormatter={(v: number) => [`${v.toFixed(3)}%`]} />
              </div>

              {/* SEP Projections + Dots */}
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
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-secondary/10 text-muted-foreground">
                          <th className="text-left px-4 py-2 font-medium">Metric</th>
                          {sepData.projections.map((p) => <th key={p.year} className="text-right px-4 py-2 font-medium">{p.year}</th>)}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        <tr>
                          <td className="px-4 py-2 text-muted-foreground">Fed Rate (median dot)</td>
                          {sepData.projections.map((p) => <td key={p.year} className="px-4 py-2 text-right font-medium">{fmtPct(p.fedRate, 3)}</td>)}
                        </tr>
                        <tr>
                          <td className="px-4 py-2 text-muted-foreground">GDP Growth</td>
                          {sepData.projections.map((p) => <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.gdp, 1)}</td>)}
                        </tr>
                        <tr>
                          <td className="px-4 py-2 text-muted-foreground">Unemployment</td>
                          {sepData.projections.map((p) => <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.unemployment, 1)}</td>)}
                        </tr>
                        <tr>
                          <td className="px-4 py-2 text-muted-foreground">Core PCE</td>
                          {sepData.projections.map((p) => <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.corePce, 1)}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">Actuals vs SEP Projections</p>
                      <div className="flex rounded-md border border-border overflow-hidden text-[10px]">
                        {(["fedRate", "gdp", "unemployment", "corePce"] as SepMetric[]).map((m) => (
                          <button key={m} onClick={() => setSelectedSepMetric(m)}
                            className={cn("px-2 py-0.5 transition-colors", selectedSepMetric === m ? "bg-purple-600 text-white" : "hover:bg-secondary")}>
                            {m === "fedRate" ? "Fed Rate" : m === "gdp" ? "GDP" : m === "unemployment" ? "Unemp." : "Core PCE"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <SepDotsChart sepData={sepData} actuals={sepActuals} metric={selectedSepMetric} />
                  </div>
                </div>
              )}

              {/* Bank Research */}
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
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {bankResearch.map((bank) => <BankCard key={bank.name} bank={bank} />)}
                  </div>
                )}
              </div>

              {/* Fed Members */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold">Fed Members</h2>
                  <div className="flex rounded-md border border-border overflow-hidden text-[11px]">
                    {(["voting", "all"] as const).map((t) => (
                      <button key={t} onClick={() => setFedSection(t)}
                        className={cn("px-2.5 py-1 transition-colors", fedSection === t ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
                        {t === "voting" ? "Voting" : "All"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FedStanceGroup title="Voting" hawkish={votingByStance.hawkish} neutral={votingByStance.neutral} dovish={votingByStance.dovish} />
                  {fedSection === "all" && (
                    <FedStanceGroup title="Non-Voting (Influential)" hawkish={nonVotingByStance.hawkish} neutral={nonVotingByStance.neutral} dovish={nonVotingByStance.dovish} />
                  )}
                </div>
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
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  Economic Calendar
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">US high-importance macro releases · powered by TradingView</p>
              </div>
              <TradingViewEconomicCalendar />

              {/* Static tracked events */}
              {events && events.length > 0 && (
                <div className="space-y-3 pt-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tracked Events</h3>
                  {thisWeekEvents.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">This Week</p>
                      {thisWeekEvents.map((ev) => <EventRow key={ev.date + ev.event} event={ev} todayStr={todayStr} />)}
                    </div>
                  )}
                  {comingUpEvents.length > 0 && (
                    <div className="space-y-1.5 mt-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Coming Up</p>
                      {comingUpEvents.map((ev) => <EventRow key={ev.date + ev.event} event={ev} todayStr={todayStr} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

// ── Regime chips ────────────────────────────────────────────────────────────────
