import { useState } from "react";
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
  Area,
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
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FredSeries {
  value: number | null;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  yoy: number | null;
  date: string | null;
  unit: string;
}

interface MarketQuote {
  value: number | null;
  change: number | null;
  changePct: number | null;
}

interface YieldCurvePoint {
  maturity: string;
  months: number;
  current: number | null;
  monthAgo: number | null;
}

interface ChartPoint {
  date: string;
  value: number;
}

interface MacroData {
  fetchedAt: string;
  vix: MarketQuote & { level: "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" };
  yield10y: MarketQuote;
  yield2y: MarketQuote;
  yieldSpread: number | null;
  yieldCurve: YieldCurvePoint[];
  usDebt: number | null;
  skew: MarketQuote;
  vxn: MarketQuote;
  series: {
    cpi: FredSeries;
    coreCpi: FredSeries;
    corePce: FredSeries;
    unemployment: FredSeries;
    nonfarmPayrolls: FredSeries;
    jolts: FredSeries;
    gdp: FredSeries;
    ppi: FredSeries;
    retailSales: FredSeries;
    consumerSentiment: FredSeries;
    fedFundsRate: FredSeries;
  };
}

interface MacroCharts {
  fetchedAt: string;
  vixHistory: ChartPoint[];
  fedFundsHistory: ChartPoint[];
  tenYearHistory: ChartPoint[];
}

interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
  recentChange?: string;
}

interface MacroEvent {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

interface BankResearch {
  name: string;
  shortName: string;
  stance: "bullish" | "neutral" | "bearish";
  rateView: string;
  summary: string;
  lastUpdated: string;
}

interface SepData {
  projections: { year: number; fedRate: number | null; gdp: number | null; unemployment: number | null; corePce: number | null }[];
  asOf: string;
}

// ── Formatting ─────────────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, dec = 2) =>
  v != null ? v.toFixed(dec) : "—";

const fmtPct = (v: number | null, dec = 1) =>
  v != null ? `${v.toFixed(dec)}%` : "—";

const fmtK = (v: number | null) =>
  v != null ? v.toLocaleString() + "K" : "—";

const fmtB = (v: number | null) =>
  v != null ? `$${(v / 1000).toFixed(1)}B` : "—";

const fmtDate = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

const fmtTs = (s: string) =>
  new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const fmtMonthYear = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" });

const changeColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

// For CPI/PCE/inflation: rising = bad (red), cooling = good (green)
const inflColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-red-400" : v < 0 ? "text-green-400" : "text-muted-foreground";

// ── VIX helpers ────────────────────────────────────────────────────────────────

const VIX_LEVEL_LABELS: Record<MacroData["vix"]["level"], string> = {
  "very-low": "Very Low",
  low:        "Low",
  "low-mid":  "Low-Mid",
  mid:        "Mid",
  "mid-high": "Mid-High",
  high:       "High",
};

function vixBadgeClass(level: MacroData["vix"]["level"]) {
  switch (level) {
    case "very-low":
    case "low":      return "bg-green-900/50 text-green-300 border-green-700";
    case "low-mid":
    case "mid":      return "bg-yellow-900/50 text-yellow-300 border-yellow-700";
    case "mid-high":
    case "high":     return "bg-red-900/50 text-red-300 border-red-700";
  }
}

// ── Stance helpers ─────────────────────────────────────────────────────────────

function stanceBadgeClass(stance: FedMember["stance"] | BankResearch["stance"]) {
  if (stance === "hawkish" || stance === "bearish")
    return "bg-red-900/60 text-red-200";
  if (stance === "dovish" || stance === "bullish")
    return "bg-green-900/60 text-green-200";
  return "bg-yellow-900/60 text-yellow-200";
}

function stanceLabel(stance: FedMember["stance"] | BankResearch["stance"]) {
  return stance.charAt(0).toUpperCase() + stance.slice(1);
}

function InitialsAvatar({ name, stance }: { name: string; stance: FedMember["stance"] }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const cls =
    stance === "hawkish"
      ? "bg-red-900/70 text-red-200"
      : stance === "dovish"
      ? "bg-green-900/70 text-green-200"
      : "bg-yellow-900/70 text-yellow-200";
  return (
    <div
      className={cn(
        "w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
        cls
      )}
    >
      {initials}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MacroDashboard() {
  const qc = useQueryClient();
  const [highlightsOpen, setHighlightsOpen] = useState(true);
  const [fedSection, setFedSection] = useState<"voting" | "all">("voting");

  // ── Queries ───────────────────────────────────────────────────────────────────

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

  const { data: highlights } = useQuery<{ content: string; generatedAt: string } | { noData: true }>({
    queryKey: ["macro-highlights"],
    queryFn: () => fetch("/api/macro/highlights").then((r) => r.json()),
    staleTime: Infinity,
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

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const refreshMutation = useMutation({
    mutationFn: () => fetch("/api/macro/refresh", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data: MacroData) => { qc.setQueryData(["macro-data"], data); },
  });

  const generateHighlightsMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/highlights/generate", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data) => { qc.setQueryData(["macro-highlights"], data); },
  });

  const generateBankMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/bank-research/generate", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data) => { qc.setQueryData(["macro-bank-research"], data); },
  });

  // ── Derived ───────────────────────────────────────────────────────────────────

  const highlightsContent =
    highlights && !("noData" in highlights) ? highlights : null;

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

  const votingByStance = {
    hawkish: fedMembers?.filter((m) => m.voting && m.stance === "hawkish") ?? [],
    neutral: fedMembers?.filter((m) => m.voting && m.stance === "neutral") ?? [],
    dovish:  fedMembers?.filter((m) => m.voting && m.stance === "dovish")  ?? [],
  };
  const nonVotingByStance = {
    hawkish: fedMembers?.filter((m) => !m.voting && m.stance === "hawkish") ?? [],
    neutral: fedMembers?.filter((m) => !m.voting && m.stance === "neutral") ?? [],
    dovish:  fedMembers?.filter((m) => !m.voting && m.stance === "dovish")  ?? [],
  };

  // VIX chart: last 90 days
  const vixChartData = macroCharts?.vixHistory
    .filter((p) => {
      const d = new Date(p.date);
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      return d >= cutoff;
    })
    .map((p) => ({ ...p, label: fmtMonthYear(p.date) })) ?? [];

  // ── Loading / Error ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="ml-[220px] flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="ml-[220px] flex flex-1 flex-col items-center justify-center gap-4">
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

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />

      <main className="ml-[220px] p-6 flex-1 space-y-6 max-w-[1400px]">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Macro Dashboard</h1>
          <div className="flex items-center gap-3">
            {macroData && (
              <span className="text-xs text-muted-foreground">
                Updated {fmtTs(macroData.fetchedAt)}
              </span>
            )}
            <button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary transition-colors disabled:opacity-50"
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>
        </div>

        {/* ── Regime chips ────────────────────────────────────────────────────── */}
        <RegimeChips macroData={macroData!} />

        {/* ── Quick stats row ─────────────────────────────────────────────────── */}
        <QuickStats macroData={macroData!} />

        {/* ── AI Highlights ───────────────────────────────────────────────────── */}
        <div className="bg-secondary/30 rounded-lg p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Highlights
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => generateHighlightsMutation.mutate()}
                disabled={generateHighlightsMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary transition-colors disabled:opacity-50"
              >
                {generateHighlightsMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Generate
              </button>
              <button
                onClick={() => setHighlightsOpen((o) => !o)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {highlightsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {highlightsOpen && (
            <div className="space-y-2">
              {generateHighlightsMutation.isPending && (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Generating…</span>
                </div>
              )}
              {!generateHighlightsMutation.isPending && highlightsContent && (
                <>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {highlightsContent.content}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Generated {fmtTs(highlightsContent.generatedAt)}
                  </p>
                </>
              )}
              {!generateHighlightsMutation.isPending && !highlightsContent && (
                <p className="text-xs text-muted-foreground italic py-2">
                  No highlights yet. Click "Generate" for an AI macro summary.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Charts row: VIX + Yield Curve ────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* VIX History */}
          <div className="border border-border rounded-lg p-4 space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-yellow-400" />
              VIX — 90 Day
            </h3>
            {vixChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={vixChartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="vixGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#facc15" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#facc15" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9, fill: "#666" }}
                    tickFormatter={(d: string) =>
                      new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    }
                    interval={Math.floor(vixChartData.length / 5)}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "#666" }} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
                    formatter={(v: number) => [v.toFixed(2), "VIX"]}
                    labelFormatter={(d: string) =>
                      new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#facc15"
                    fill="url(#vixGrad)"
                    dot={false}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[150px] flex items-center justify-center text-xs text-muted-foreground">
                {macroCharts ? "No data" : <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            )}
          </div>

          {/* Yield Curve */}
          <YieldCurveChart yieldCurve={macroData!.yieldCurve} />
        </div>

        {/* ── Fed Funds + 10Y history ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RateHistoryChart
            title="Fed Funds Rate — 3M T-Bill (2Y History)"
            data={macroCharts?.fedFundsHistory ?? []}
            color="#60a5fa"
            loading={!macroCharts}
          />
          <RateHistoryChart
            title="10Y Treasury — 2 Year"
            data={macroCharts?.tenYearHistory ?? []}
            color="#a78bfa"
            loading={!macroCharts}
          />
        </div>

        {/* ── Macro Data Table ─────────────────────────────────────────────────── */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/20">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Economic Indicators</h2>
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
                <MacroRow label="CPI"              value={`${fmt(s.cpi.value, 1)} idx`}     mom={s.cpi.change}              yoy={s.cpi.yoy}              date={s.cpi.date}              inflSign />
                <MacroRow label="Core CPI"         value={`${fmt(s.coreCpi.value, 1)} idx`} mom={s.coreCpi.change}          yoy={s.coreCpi.yoy}          date={s.coreCpi.date}          inflSign />
                <MacroRow label="Core PCE (Fed ★)" value={`${fmt(s.corePce.value, 1)} idx`} mom={s.corePce.change}          yoy={s.corePce.yoy}          date={s.corePce.date}          inflSign />
                <MacroRow label="PPI"              value={`${fmt(s.ppi.value, 1)} idx`}     mom={s.ppi.change}              yoy={s.ppi.yoy}              date={s.ppi.date}              inflSign />
                <MacroRow label="Unemployment"     value={fmtPct(s.unemployment.value)}     mom={s.unemployment.change}     yoy={null}                   date={s.unemployment.date}     inflSign />
                <MacroRow label="Nonfarm Payrolls" value={fmtK(s.nonfarmPayrolls.value)}    momRaw={fmtK(s.nonfarmPayrolls.change)} mom={null} yoy={null} date={s.nonfarmPayrolls.date} />
                <MacroRow label="JOLTS Openings"   value={fmtK(s.jolts.value)}              momRaw={fmtK(s.jolts.change)}   mom={null} yoy={null}         date={s.jolts.date}            />
                <MacroRow label="GDP (annualized)" value={fmtPct(s.gdp.value)}              mom={s.gdp.change}              yoy={null}                   date={s.gdp.date}              />
                <MacroRow label="Retail Sales"     value={fmtB(s.retailSales.value)}        momRaw={s.retailSales.change != null ? `${s.retailSales.change > 0 ? "+" : ""}${fmtB(s.retailSales.change)}` : null} mom={null} yoy={s.retailSales.yoy} date={s.retailSales.date} />
                <MacroRow label="Consumer Sentiment" value={fmt(s.consumerSentiment.value, 1)} mom={s.consumerSentiment.change} yoy={s.consumerSentiment.yoy} date={s.consumerSentiment.date} />
                <MacroRow label="Fed Funds Rate"   value={fmtPct(s.fedFundsRate.value)}     mom={s.fedFundsRate.change}     yoy={null}                   date={s.fedFundsRate.date}     />
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Projections table (SEP + bank consensus) ─────────────────────────── */}
        {sepData && (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/20">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-purple-400" />
                Fed SEP Projections
              </h2>
              <span className="text-[10px] text-muted-foreground italic">
                FOMC SEP {sepData.asOf} — static, updated after each SEP release
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/10 text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Metric</th>
                    {sepData.projections.map((p) => (
                      <th key={p.year} className="text-right px-4 py-2 font-medium">{p.year}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  <tr>
                    <td className="px-4 py-2 text-muted-foreground">Fed Rate (median dot)</td>
                    {sepData.projections.map((p) => (
                      <td key={p.year} className="px-4 py-2 text-right font-medium">{fmtPct(p.fedRate, 3)}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-muted-foreground">GDP Growth</td>
                    {sepData.projections.map((p) => (
                      <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.gdp, 1)}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-muted-foreground">Unemployment</td>
                    {sepData.projections.map((p) => (
                      <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.unemployment, 1)}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-muted-foreground">Core PCE</td>
                    {sepData.projections.map((p) => (
                      <td key={p.year} className="px-4 py-2 text-right">{fmtPct(p.corePce, 1)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Bank Research ────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-400" />
              Bank Research
            </h2>
            <button
              onClick={() => generateBankMutation.mutate()}
              disabled={generateBankMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary transition-colors disabled:opacity-50"
            >
              {generateBankMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              Refresh Stances
            </button>
          </div>
          {generateBankMutation.isPending && (
            <div className="flex items-center gap-2 py-3 justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating bank stances…
            </div>
          )}
          {bankResearch && !generateBankMutation.isPending && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {bankResearch.map((bank) => (
                <BankCard key={bank.name} bank={bank} />
              ))}
            </div>
          )}
        </div>

        {/* ── Fed Members ──────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Fed Members</h2>
            <div className="flex rounded-md border border-border overflow-hidden text-[11px]">
              {(["voting", "all"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFedSection(tab)}
                  className={cn(
                    "px-2.5 py-1 transition-colors",
                    fedSection === tab
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-secondary"
                  )}
                >
                  {tab === "voting" ? "Voting" : "All"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FedStanceGroup
              title="Voting"
              hawkish={votingByStance.hawkish}
              neutral={votingByStance.neutral}
              dovish={votingByStance.dovish}
            />
            {fedSection === "all" && (
              <FedStanceGroup
                title="Non-Voting (Influential)"
                hawkish={nonVotingByStance.hawkish}
                neutral={nonVotingByStance.neutral}
                dovish={nonVotingByStance.dovish}
              />
            )}
          </div>
        </div>

        {/* ── Upcoming Events ──────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Upcoming Events</h2>
          </div>

          {thisWeekEvents.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                This Week
              </p>
              {thisWeekEvents.map((ev) => (
                <EventRow key={ev.date + ev.event} event={ev} todayStr={todayStr} />
              ))}
            </div>
          )}

          {comingUpEvents.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium mt-2">
                Coming Up
              </p>
              {comingUpEvents.map((ev) => (
                <EventRow key={ev.date + ev.event} event={ev} todayStr={todayStr} />
              ))}
            </div>
          )}

          {(!events || events.length === 0) && (
            <p className="text-xs text-muted-foreground italic">No upcoming events</p>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Regime chips ───────────────────────────────────────────────────────────────

function RegimeChips({ macroData }: { macroData: MacroData }) {
  const pct = macroData.series.corePce.yoy;
  const infl =
    pct == null
      ? { text: "Core PCE —", cls: "text-muted-foreground bg-secondary" }
      : pct > 2.5
      ? { text: `Core PCE ${fmt(pct, 1)}% ↑`, cls: "bg-red-900/50 text-red-300 border-red-700" }
      : pct < 2.0
      ? { text: `Core PCE ${fmt(pct, 1)}% ↓`, cls: "bg-green-900/50 text-green-300 border-green-700" }
      : { text: `Core PCE ${fmt(pct, 1)}% →`, cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" };

  const ch = macroData.series.unemployment.change;
  const labor =
    ch == null
      ? { text: "Labor —", cls: "text-muted-foreground bg-secondary" }
      : ch > 0.1
      ? { text: "UR Rising ↑", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" }
      : ch < -0.1
      ? { text: "UR Falling ↓", cls: "bg-green-900/50 text-green-300 border-green-700" }
      : { text: "Labor Stable", cls: "bg-green-900/50 text-green-300 border-green-700" };

  const spread = macroData.yieldSpread;
  const curve = spread == null
    ? { text: "Curve —", cls: "text-muted-foreground bg-secondary" }
    : spread < 0
    ? { text: `Inverted ${(spread).toFixed(0)}bps`, cls: "bg-red-900/50 text-red-300 border-red-700" }
    : { text: `Normal +${(spread).toFixed(0)}bps`, cls: "bg-green-900/50 text-green-300 border-green-700" };

  return (
    <div className="flex flex-wrap gap-2">
      {macroData.vix && (
        <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", vixBadgeClass(macroData.vix.level))}>
          VIX {fmt(macroData.vix.value, 1)} · {VIX_LEVEL_LABELS[macroData.vix.level]}
        </span>
      )}
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", infl.cls)}>{infl.text}</span>
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", labor.cls)}>{labor.text}</span>
      <span className={cn("text-xs px-3 py-1 rounded-full border font-medium", curve.cls)}>{curve.text}</span>
      <span className="text-xs px-3 py-1 rounded-full border font-medium bg-yellow-900/50 text-yellow-300 border-yellow-700">
        Fed On Hold
      </span>
    </div>
  );
}

// ── Quick stats ────────────────────────────────────────────────────────────────

function StatCell({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="border border-border rounded-md p-3 flex-1 min-w-[90px]">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
      <p className="text-lg font-semibold leading-tight">{value}</p>
      {sub && <p className={cn("text-[11px] mt-0.5", subColor)}>{sub}</p>}
    </div>
  );
}

function QuickStats({ macroData }: { macroData: MacroData }) {
  const debtT = macroData.usDebt != null
    ? `$${(macroData.usDebt / 1_000_000).toFixed(1)}T`
    : "—";

  return (
    <div className="flex flex-wrap gap-2">
      <StatCell
        label="VIX"
        value={fmt(macroData.vix.value, 1)}
        sub={macroData.vix.change != null ? `${macroData.vix.change > 0 ? "+" : ""}${fmt(macroData.vix.change, 2)}` : undefined}
        subColor={changeColor(macroData.vix.change ?? null)}
      />
      <StatCell
        label="SKEW"
        value={fmt(macroData.skew.value, 1)}
        sub={macroData.skew.change != null ? `${macroData.skew.change > 0 ? "+" : ""}${fmt(macroData.skew.change, 2)}` : undefined}
        subColor={changeColor(macroData.skew.change ?? null)}
      />
      <StatCell
        label="VXN (NDX)"
        value={fmt(macroData.vxn.value, 1)}
        sub={macroData.vxn.change != null ? `${macroData.vxn.change > 0 ? "+" : ""}${fmt(macroData.vxn.change, 2)}` : undefined}
        subColor={changeColor(macroData.vxn.change ?? null)}
      />
      <StatCell
        label="10Y Yield"
        value={`${fmt(macroData.yield10y.value, 3)}%`}
        sub={macroData.yield10y.change != null ? `${macroData.yield10y.change > 0 ? "+" : ""}${fmt(macroData.yield10y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield10y.change ?? null)}
      />
      <StatCell
        label="2Y Yield"
        value={`${fmt(macroData.yield2y.value, 3)}%`}
        sub={macroData.yield2y.change != null ? `${macroData.yield2y.change > 0 ? "+" : ""}${fmt(macroData.yield2y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield2y.change ?? null)}
      />
      <StatCell
        label="2s10s Spread"
        value={macroData.yieldSpread != null ? `${macroData.yieldSpread.toFixed(0)} bps` : "—"}
        sub={macroData.yieldSpread != null ? (macroData.yieldSpread < 0 ? "⚠ Inverted" : "Normal") : undefined}
        subColor={macroData.yieldSpread != null && macroData.yieldSpread < 0 ? "text-red-400" : "text-green-400"}
      />
      <StatCell label="Fed Funds" value={fmtPct(macroData.series.fedFundsRate.value)} />
      <StatCell label="US Debt" value={debtT} />
    </div>
  );
}

// ── Yield Curve Chart ──────────────────────────────────────────────────────────

function YieldCurveChart({ yieldCurve }: { yieldCurve: YieldCurvePoint[] }) {
  const data = yieldCurve.filter((p) => p.current != null || p.monthAgo != null);
  return (
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-blue-400" />
          Treasury Yield Curve
        </h3>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block" /> Current</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-orange-400 inline-block border-dashed" style={{ borderStyle: "dashed", borderWidth: "0 0 1px", borderColor: "#fb923c" }} /> 1Mo Ago</span>
        </div>
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="maturity" tick={{ fontSize: 10, fill: "#666" }} />
            <YAxis
              tick={{ fontSize: 9, fill: "#666" }}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
            />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: number) => [`${v.toFixed(3)}%`]}
            />
            <Line
              type="monotone"
              dataKey="current"
              stroke="#60a5fa"
              dot={{ r: 3, fill: "#60a5fa" }}
              strokeWidth={2}
              name="Current"
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="monthAgo"
              stroke="#fb923c"
              dot={{ r: 2, fill: "#fb923c" }}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              name="1Mo Ago"
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[150px] flex items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
    </div>
  );
}

// ── Rate History Chart ─────────────────────────────────────────────────────────

function RateHistoryChart({
  title,
  data,
  color,
  loading,
}: {
  title: string;
  data: ChartPoint[];
  color: string;
  loading: boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {loading ? (
        <div className="h-[130px] flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={130}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "#666" }}
              tickFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
              }
              interval={Math.floor(data.length / 6)}
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#666" }}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `${v.toFixed(2)}%`}
            />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
              formatter={(v: number) => [`${v.toFixed(2)}%`]}
              labelFormatter={(d: string) =>
                new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              }
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              fill={`url(#grad-${color.replace("#", "")})`}
              dot={false}
              strokeWidth={1.5}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[130px] flex items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      )}
    </div>
  );
}

// ── Macro data table row ────────────────────────────────────────────────────────

function MacroRow({
  label,
  value,
  mom,
  momRaw,
  yoy,
  date,
  inflSign,
}: {
  label: string;
  value: string;
  mom?: number | null;
  momRaw?: string | null;
  yoy?: number | null;
  date?: string | null;
  inflSign?: boolean;
}) {
  const momDisplay =
    momRaw != null
      ? momRaw
      : mom != null
      ? `${mom > 0 ? "+" : ""}${mom.toFixed(2)}`
      : "—";
  const momColor = inflSign
    ? inflColor(mom ?? null)
    : changeColor(mom ?? null);

  const yoyDisplay = yoy != null ? `${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%` : "—";
  const yoyColor = inflSign ? inflColor(yoy ?? null) : changeColor(yoy ?? null);

  return (
    <tr className="hover:bg-secondary/20">
      <td className="px-4 py-2 text-muted-foreground">{label}</td>
      <td className="px-3 py-2 text-right font-medium">{value}</td>
      <td className={cn("px-3 py-2 text-right", momColor)}>{momDisplay}</td>
      <td className={cn("px-3 py-2 text-right", yoyColor)}>{yoyDisplay}</td>
      <td className="px-4 py-2 text-right text-muted-foreground/70">
        {date ? fmtMonthYear(date) : "—"}
      </td>
    </tr>
  );
}

// ── Fed stance group ───────────────────────────────────────────────────────────

function FedStanceGroup({
  title,
  hawkish,
  neutral,
  dovish,
}: {
  title: string;
  hawkish: FedMember[];
  neutral: FedMember[];
  dovish: FedMember[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground font-medium">{title}</p>

      {hawkish.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-red-400 uppercase tracking-wider font-semibold">Hawkish ({hawkish.length})</p>
          {hawkish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {neutral.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-yellow-400 uppercase tracking-wider font-semibold">Neutral ({neutral.length})</p>
          {neutral.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {dovish.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-green-400 uppercase tracking-wider font-semibold">Dovish ({dovish.length})</p>
          {dovish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
    </div>
  );
}

function FedMemberCard({ member }: { member: FedMember }) {
  return (
    <div className="border border-border rounded-md p-2.5 flex items-start gap-2.5">
      <InitialsAvatar name={member.name} stance={member.stance} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold leading-tight">{member.name}</p>
          {member.recentChange && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700">
              Updated
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">{member.title}</p>
        {member.notes && (
          <p className="text-[11px] text-muted-foreground/80 italic mt-0.5 line-clamp-2">{member.notes}</p>
        )}
        {member.recentChange && (
          <p className="text-[10px] text-blue-300/80 mt-0.5">↳ {member.recentChange}</p>
        )}
      </div>
    </div>
  );
}

// ── Bank Research Card ─────────────────────────────────────────────────────────

function BankCard({ bank }: { bank: BankResearch }) {
  const bg =
    bank.stance === "bullish"
      ? "border-green-900/40 bg-green-900/5"
      : bank.stance === "bearish"
      ? "border-red-900/40 bg-red-900/5"
      : "border-border";

  return (
    <div className={cn("border rounded-lg p-3 space-y-2", bg)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold mb-1",
              stanceBadgeClass(bank.stance)
            )}
          >
            {bank.shortName.slice(0, 4)}
          </div>
          <p className="text-xs font-semibold leading-tight">{bank.name}</p>
        </div>
        <div className="text-right shrink-0">
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize",
              stanceBadgeClass(bank.stance)
            )}
          >
            {stanceLabel(bank.stance)}
          </span>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground font-medium">{bank.rateView}</p>
      <p className="text-[11px] text-muted-foreground/80 leading-relaxed line-clamp-3">{bank.summary}</p>
      <p className="text-[9px] text-muted-foreground/50">
        {new Date(bank.lastUpdated + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </p>
    </div>
  );
}

// ── Event row ──────────────────────────────────────────────────────────────────

function importanceBadgeClass(imp: MacroEvent["importance"]) {
  switch (imp) {
    case "high":   return "bg-amber-900/60 text-amber-200";
    case "medium": return "bg-blue-900/60 text-blue-200";
    case "low":    return "bg-secondary text-muted-foreground";
  }
}

function EventRow({ event, todayStr }: { event: MacroEvent; todayStr: string }) {
  const isToday = event.date === todayStr;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md border border-border text-sm",
        isToday && "border-l-2 border-l-primary bg-primary/5"
      )}
    >
      <span className="text-[11px] text-muted-foreground font-medium w-12 shrink-0">
        {fmtDate(event.date)}
      </span>
      <span className="flex-1 text-xs">{event.event}</span>
      <span
        className={cn(
          "text-[10px] px-2 py-0.5 rounded-full font-medium capitalize",
          importanceBadgeClass(event.importance)
        )}
      >
        {event.importance}
      </span>
    </div>
  );
}
