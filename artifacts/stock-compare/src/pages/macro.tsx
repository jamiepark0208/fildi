import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWatchlist } from "@/hooks/use-watchlist";
import { cn } from "@/lib/utils";
import { guideSubTabClass } from "@/lib/sub-tabs";
import { Loader2, TrendingUp, Sparkles, Calendar, AlertTriangle, Activity, Building2 } from "lucide-react";
import { RegimeBanner } from "@/components/macro/RegimeBanner";
import { useAuth } from "@/context/AuthContext";
import { useSessionState } from "@/hooks/use-session-state";


// Types and sub-components extracted for token-efficient editing
import type {
  MacroData, MacroCharts, FedMember, MacroEvent, BankResearch, SepData, IndicatorHistory, SepActuals, CurvePeriod, SepMetric,
  MacroTab, COTRecord, COTSummary, SectorRotationPoint,
} from "@/components/macro/macro-page-types";
import { MACRO_TABS } from "@/components/macro/macro-page-types";
import { fmt, fmtPct, fmtK, fmtB, changeColor, getIndicatorHighlight } from "@/components/macro/macro-format";
import { VixCurveChart, YieldCurveChart, FedFundsCurveChart } from "@/components/macro/macro-curve-charts";
import { RegimeChips, CrossTabReadRow, CompactStat, VolStrip } from "@/components/macro/macro-regime-overview";
import { RegimeAccuracyStrip } from "@/components/macro/regime-accuracy-strip";
import { RateHistoryChart, DualLineHistoryChart, IndicatorHistoryChart, SepDotsChart, BalanceSheetCard } from "@/components/macro/macro-history-charts";
import { MacroRow } from "@/components/macro/macro-indicator-row";
import { LiquidityFlowDiagram, LiquidityImplicationsCard } from "@/components/macro/macro-liquidity-section";
import { SectorRotationBubbles, SectorHeatmapGrid, SectorFundFlowBars, EtfBidStrip } from "@/components/macro/macro-sector-rotation";
import { SectorRevisionBreadth } from "@/components/macro/sector-revision-breadth";
import { ExpandableChartFrame } from "@/components/macro/expandable-chart-frame";
import { VolatilityImplicationsCard, PolicyCspSummary } from "@/components/macro/macro-volatility-policy";
import { FedScaleStrip, BankCard } from "@/components/macro/macro-fed-section";
import { VoicesPanel } from "@/components/macro/voices-panel";
import { StreetGapsPanel } from "@/components/macro/street-gaps-panel";
import { EventRow, CotSection } from "@/components/macro/macro-events-cot";
import { ScenarioExposurePanel } from "@/components/macro/scenario-exposure-panel";
import { KeyThemesTab } from "@/components/macro/key-themes-tab";
import {
  TradingViewHeatmap, TradingViewEconomicCalendar, TradingViewMarketOverview, TradingViewForexCrossRates,
} from "@/components/macro/macro-tradingview-embeds";

const COT_MACRO_IDS = ["sp500", "nasdaq100", "tbonds"];

const TTH = "text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5 text-[#d4af37]";
const TTD = "px-3 py-1.5 text-sm font-mono text-white";

// ── Main component ─────────────────────────────────────────────────────────────

/** `embedded` — render inside Live (no TopNav / full-page chrome). */
export default function MacroDashboard({ embedded = false }: { embedded?: boolean } = {}) {
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
  const [showTvCalendar, setShowTvCalendar] = useState(false);

  // Migrate old "catalyst" session tab → "calendar"
  useEffect(() => {
    if ((activeTab as string) === "catalyst") setActiveTab("calendar");
  }, [activeTab, setActiveTab]);

  // ?tab= overrides session tab (e.g. /live?page=macro&tab=volatility)
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("tab");
    const tab = raw === "catalyst" ? "calendar" : raw;
    if (tab && MACRO_TABS.some((t) => t.id === tab)) {
      setActiveTab(tab as MacroTab);
    }
  }, []);

  const shell = (body: ReactNode, opts?: { center?: boolean }) => {
    if (embedded) {
      return (
        <div className={cn(
          "flex flex-col bg-zinc-900",
          opts?.center ? "min-h-[50vh] items-center justify-center" : "h-[calc(100dvh-3.5rem-2.5rem)] overflow-hidden",
        )}>
          {body}
        </div>
      );
    }
    return (
      <div className="h-[100dvh] overflow-hidden bg-zinc-900">
        <TopNav />
        <div className={cn(
          opts?.center
            ? "flex items-center justify-center mt-14 h-[calc(100dvh-3.5rem)]"
            : "flex flex-col mt-14 h-[calc(100dvh-3.5rem)] overflow-hidden",
        )}>
          {body}
        </div>
      </div>
    );
  };

  // ── Queries ──────────────────────────────────────────────────────────────────

  // Tab-gated fetches — cold /charts is ~20 upstream series; don't pull policy/COT until needed.
  // Heatmap / Scenario / Calendar don't need /macro/data — skip so those tabs paint fast.
  const needsMacroData = activeTab === "regime" || activeTab === "liquidity"
    || activeTab === "volatility" || activeTab === "policy";
  const needsCharts = activeTab === "regime" || activeTab === "liquidity" || activeTab === "volatility";
  const needsRegimeExtras = activeTab === "regime";
  const needsPolicy = activeTab === "policy";
  const needsCalendar = activeTab === "calendar";
  // Defer /macro/charts until idle so Regime shell isn't blocked by ~800KB JSON.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => {
    if (!needsCharts) { setChartsReady(false); return; }
    let cancelled = false;
    const arm = () => { if (!cancelled) setChartsReady(true); };
    const ric = typeof window !== "undefined" && "requestIdleCallback" in window
      ? window.requestIdleCallback(arm, { timeout: 900 })
      : null;
    const t = window.setTimeout(arm, ric == null ? 50 : 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      if (ric != null && "cancelIdleCallback" in window) window.cancelIdleCallback(ric);
    };
  }, [needsCharts]);

  const { data: macroData, isLoading, isError, refetch: macroRefetch } = useQuery<MacroData>({
    queryKey: ["macro-data"],
    queryFn: async () => {
      const r = await fetch("/api/macro/data");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<MacroData>;
    },
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsMacroData,
  });

  const { data: macroCharts } = useQuery<MacroCharts>({
    queryKey: ["macro-charts"],
    queryFn: () => fetch("/api/macro/charts").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsCharts && chartsReady,
  });

  const { data: sectorRotation } = useQuery<SectorRotationPoint[]>({
    queryKey: ["macro-sector-rotation"],
    queryFn: () => fetch("/api/macro/sector-rotation").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: activeTab === "liquidity" || activeTab === "heatmap",
  });

  // Heatmap "watchlist by sector" — one DB meta call (lite skips street-gap SQL), not N× quotes.
  type WlMeta = Record<string, { sector: string | null }>;
  const { data: wlMeta } = useQuery<WlMeta>({
    queryKey: ["watchlist-meta-lite"],
    queryFn: async () => {
      const r = await fetch("/api/watchlist/meta?lite=1", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: activeTab === "heatmap" && watchlistTickers.length > 0,
  });

  const watchlistBySector = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const ticker of watchlistTickers) {
      const sector = wlMeta?.[ticker]?.sector || "Unknown";
      (groups[sector] ??= []).push(ticker);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [watchlistTickers, wlMeta]);

  const { data: fedMembers } = useQuery<FedMember[]>({
    queryKey: ["macro-fed-members"],
    queryFn: () => fetch("/api/macro/fed-members").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needsPolicy,
  });

  const { data: events } = useQuery<MacroEvent[]>({
    queryKey: ["macro-events"],
    queryFn: () => fetch("/api/macro/events").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras || needsCalendar || needsPolicy,
  });

  const { data: wlEarnings } = useQuery<{ earnings: { ticker: string; date: string }[] }>({
    queryKey: ["macro-watchlist-earnings"],
    queryFn: () => fetch("/api/macro/watchlist-earnings", { credentials: "include" }).then((r) => r.json()),
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    enabled: needsCalendar,
  });

  const { data: bankResearch } = useQuery<BankResearch[]>({
    queryKey: ["macro-bank-research"],
    queryFn: () => fetch("/api/macro/bank-research").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needsPolicy,
  });

  const { data: sepData } = useQuery<SepData>({
    queryKey: ["macro-sep"],
    queryFn: () => fetch("/api/macro/sep-projections").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needsPolicy || needsRegimeExtras,
  });

  const { data: indicatorHistory, isLoading: indicatorLoading } = useQuery<IndicatorHistory>({
    queryKey: ["macro-indicator-history", selectedIndicatorKey],
    queryFn: () =>
      fetch(`/api/macro/indicator-history?key=${selectedIndicatorKey}`).then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras,
  });

  const { data: sepActuals } = useQuery<SepActuals>({
    queryKey: ["macro-sep-actuals"],
    queryFn: () => fetch("/api/macro/sep-actuals").then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsPolicy,
  });

  const { data: breadthHist } = useQuery<{ points: { date: string; pctAbove50: number | null; pctAbove200: number | null; advanceDecline: number | null }[]; note?: string }>({
    queryKey: ["macro-breadth"],
    queryFn: () => fetch("/api/macro/breadth").then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras,
  });

  const { data: cotSummaries } = useQuery<COTSummary[]>({
    queryKey: ["cot-summary"],
    queryFn: () => fetch("/api/cot/summary").then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras,
  });

  const { data: macroCotHistory } = useQuery<COTRecord[]>({
    queryKey: ["cot-history", selectedMacroCotId],
    queryFn: () => fetch(`/api/cot/history?instrument=${selectedMacroCotId}&weeks=52`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras && !!selectedMacroCotId,
  });

  const { data: sentCotHistory } = useQuery<COTRecord[]>({
    queryKey: ["cot-history", selectedSentCotId],
    queryFn: () => fetch(`/api/cot/history?instrument=${selectedSentCotId}&weeks=52`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needsRegimeExtras && !!selectedSentCotId,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────

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

  // Prefer high-importance for "Your Week"; fall back to all if feed is thin.
  const highEvents = (events ?? []).filter((e) => e.importance === "high");
  const calendarPool = highEvents.length >= 3 ? highEvents : (events ?? []);
  const thisWeekEvents = calendarPool.filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d >= today && d <= oneWeekOut;
  });
  const comingUpEvents = calendarPool.filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d > oneWeekOut;
  }).slice(0, 12);
  const earningsSoon = (wlEarnings?.earnings ?? []).filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d >= today && d <= oneWeekOut;
  });
  const earningsLater = (wlEarnings?.earnings ?? []).filter((e) => {
    const d = new Date(e.date + "T12:00:00");
    return d > oneWeekOut;
  }).slice(0, 20);

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

  // ── Loading / Error (only tabs that need /macro/data) ─────────────────────────

  if (needsMacroData && isLoading) {
    return shell(<Loader2 className="h-8 w-8 animate-spin text-amber-100" />, { center: true });
  }

  if (needsMacroData && (isError || (!isLoading && !macroData))) {
    return shell(
      <div className="flex flex-col items-center justify-center gap-4">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm text-amber-100">Failed to load macro data.</p>
        <button
          onClick={() => macroRefetch()}
          className="text-xs px-3 py-1.5 rounded-md bg-zinc-950 text-amber-200/70 border border-[#d4af37]/25 hover:bg-[#d4af37] hover:text-black transition-colors"
        >
          Retry
        </button>
      </div>,
      { center: true },
    );
  }

  const s = macroData?.series;
  const macroCoTs = cotSummaries?.filter((c) => COT_MACRO_IDS.includes(c.instrument)) ?? [];
  const sentCoTs  = cotSummaries?.filter((c) => !COT_MACRO_IDS.includes(c.instrument)) ?? [];

  // ── Render ────────────────────────────────────────────────────────────────────

  return shell(
      <>
        {/* ── Sub-tabs — same chrome as Live Market / Macro / News strip ─────── */}
        <div className="shrink-0 px-6 py-1.5 overflow-x-auto">
          <div className="inline-flex items-center gap-0.5 flex-wrap shrink-0">
            {MACRO_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={guideSubTabClass(activeTab === t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2" data-lenis-prevent>

          {/* ── Key Themes (Jamie 10-28): themes, scenarios, unified read, money flows ── */}
          {activeTab === "themes" && <KeyThemesTab onJump={setActiveTab} />}

          {/* ── Tab 1: Macro & Regime Health ─────────────────────────────────── */}
          {activeTab === "regime" && macroData && s && (
            <>
              {/* Regime header — same compact mono stack as Vol/Liquidity/Policy strips */}
              <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-md px-2 py-1.5 space-y-1">
                <RegimeBanner />
                <RegimeChips macroData={macroData} />
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
                <div className="flex flex-wrap items-center divide-x divide-[#d4af37]/10 border-t border-[#d4af37]/10 pt-1">
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
              </div>

              {/* Regime history charts — 3 per row; click to expand */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <ExpandableChartFrame title="Yield Curve">
                  <YieldCurveChart yieldCurve={macroData.yieldCurve} period={treasuryPeriod} onPeriodChange={setTreasuryPeriod} />
                </ExpandableChartFrame>
                <ExpandableChartFrame title="10Y Treasury">
                  <RateHistoryChart title="10Y Treasury" data={macroCharts?.tenYearHistory ?? []} color="#a78bfa" loading={!macroCharts} />
                </ExpandableChartFrame>
                <ExpandableChartFrame title="Credit Spreads — IG & HY OAS %">
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
                </ExpandableChartFrame>
                <ExpandableChartFrame title="Market breadth (A/D) — not a signal">
                  <DualLineHistoryChart
                    title="Market breadth — advance/decline"
                    data1={(breadthHist?.points ?? []).filter((p) => p.advanceDecline != null).map((p) => ({ date: p.date, value: p.advanceDecline! }))}
                    data2={(breadthHist?.points ?? []).filter((p) => p.pctAbove50 != null).map((p) => ({ date: p.date, value: p.pctAbove50! * 100 }))}
                    color1="#94a3b8"
                    color2="#38e1ff"
                    label1="A/D ratio"
                    label2="% > 50d MA"
                    loading={needsRegimeExtras && !breadthHist}
                    yFormatter={(v: number) => v.toFixed(2)}
                    tooltipFormatter={(v: number, name: string) => [v.toFixed(2), name]}
                  />
                  <p className="text-[9px] text-white/35 px-1 -mt-1">Display only (S027). Backfill fills history overnight.</p>
                </ExpandableChartFrame>
                <ExpandableChartFrame title="Copper / Gold Ratio">
                  <RateHistoryChart
                    title="Copper / Gold Ratio"
                    data={macroCharts?.copperGoldHistory ?? []}
                    color="#f59e0b" loading={!macroCharts}
                    yFormatter={(v: number) => v.toFixed(4)}
                    tooltipFormatter={(v: number) => [v.toFixed(5)]}
                  />
                </ExpandableChartFrame>
                <ExpandableChartFrame title="GSCPI — Global Supply Chain Pressure">
                  <RateHistoryChart
                    title="GSCPI — Global Supply Chain Pressure"
                    data={macroCharts?.gscpiHistory ?? []}
                    color="#34d399" loading={!macroCharts}
                    yFormatter={(v: number) => v.toFixed(2)}
                    tooltipFormatter={(v: number) => [v.toFixed(2)]}
                    referenceLines={[{ y: 0, label: "Neutral", color: "#94a3b8" }, { y: 1.5, label: "Elevated", color: "#f59e0b" }, { y: -1, label: "Easing", color: "#22c55e" }]}
                  />
                </ExpandableChartFrame>
                <ExpandableChartFrame title="Money Market Fund AUM ($B)">
                  <RateHistoryChart
                    title="Money Market Fund AUM ($B)"
                    data={macroCharts?.moneyMarketHistory ?? []}
                    color="#60a5fa" loading={!macroCharts}
                    yFormatter={(v: number) => `$${(v / 1000).toFixed(1)}T`}
                    tooltipFormatter={(v: number) => [`$${v.toFixed(0)}B`]}
                  />
                </ExpandableChartFrame>
                <ExpandableChartFrame title="Chicago Fed NFCI — Financial Conditions">
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
                </ExpandableChartFrame>
                <ExpandableChartFrame title="DXY — US Dollar Index">
                  <RateHistoryChart
                    title="DXY — US Dollar Index"
                    data={macroCharts?.dxyHistory ?? []}
                    color="#38bdf8" loading={!macroCharts}
                    yFormatter={(v: number) => v.toFixed(1)}
                    tooltipFormatter={(v: number) => [v.toFixed(2)]}
                  />
                </ExpandableChartFrame>
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

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <VoicesPanel />
                <StreetGapsPanel />
              </div>

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
                <SectorFundFlowBars enabled={activeTab === "heatmap"} />
              </div>
              <div className="space-y-1.5">
                <EtfBidStrip enabled={activeTab === "heatmap"} tickers={watchlistTickers} />
              </div>
              <div className="space-y-1.5">
                <SectorRevisionBreadth enabled={activeTab === "heatmap"} watchlistTickers={watchlistTickers} />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide" title="1D / 1W / 1M price performance by sector ETF — not fund creations">
                  Sector Price Performance
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

          {/* ── Calendar (ours first; TradingView optional / slow) ───────────── */}
          {activeTab === "calendar" && (
            <div className="space-y-3">
              <p className="text-[10px] text-amber-200/45 leading-snug">
                Fildi calendar = Finnhub US macro (high-tier: FOMC, CPI, NFP…) + static Fed dates + your watchlist earnings.
                Display only — S026 found no put-seller edge from event weeks. TradingView embed is optional (slow).
              </p>

              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-[#d4af37]/60" />
                  Macro (high importance)
                </h3>
                {thisWeekEvents.length === 0 && comingUpEvents.length === 0 ? (
                  <p className="text-[11px] text-amber-200/40">No macro events in the feed window.</p>
                ) : (
                  <>
                    {thisWeekEvents.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-amber-200/40 uppercase tracking-wide font-medium">This week</p>
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
                        <p className="text-[10px] text-amber-200/40 uppercase tracking-wide font-medium">Coming up</p>
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
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
                  Watchlist earnings
                </h3>
                {earningsSoon.length === 0 && earningsLater.length === 0 ? (
                  <p className="text-[11px] text-amber-200/40">No upcoming report dates on the watchlist.</p>
                ) : (
                  <ul className="space-y-0.5 text-[12px] font-mono">
                    {[...earningsSoon, ...earningsLater].map((e) => (
                      <li key={`${e.ticker}-${e.date}`} className="flex items-baseline gap-2">
                        <span className="w-16 text-amber-200/45 tabular-nums">{e.date.slice(5)}</span>
                        <button
                          type="button"
                          className="text-[#d4af37] hover:underline font-semibold"
                          onClick={() => navigate(`/watchlist?ticker=${e.ticker}`)}
                        >
                          {e.ticker}
                        </button>
                        {earningsSoon.some((x) => x.ticker === e.ticker && x.date === e.date) && (
                          <span className="text-[9px] uppercase text-sky-300/70">this week</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-1.5 border-t border-[#d4af37]/15 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTvCalendar((v) => !v)}
                  className="text-[11px] font-semibold text-amber-200/55 hover:text-[#d4af37]"
                >
                  {showTvCalendar ? "Hide" : "Show"} TradingView economic calendar (slow)
                </button>
                {showTvCalendar && <TradingViewEconomicCalendar />}
              </div>
            </div>
          )}

          {/* ── Scenario exposure (was always above Macro on Live) ───────────── */}
          {activeTab === "scenario" && (
            <ScenarioExposurePanel />
          )}

        </div>
      </>
  );
}

// ── Regime chips ────────────────────────────────────────────────────────────────
