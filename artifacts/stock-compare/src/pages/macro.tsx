import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Sparkles,
  Calendar,
  Users,
  AlertTriangle,
  Activity,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FredSeries {
  value: number | null;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  date: string | null;
  unit: string;
}

interface MarketQuote {
  value: number | null;
  change: number | null;
  changePct: number | null;
}

interface MacroData {
  fetchedAt: string;
  vix: MarketQuote & { level: "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" };
  yield10y: MarketQuote;
  yield2y: MarketQuote;
  yieldSpread: number | null;
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

interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
}

interface MacroEvent {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, dec = 2) =>
  v != null ? v.toFixed(dec) : "—";

const fmtK = (v: number | null) =>
  v != null ? v.toLocaleString() + "K" : "—";

const fmtDate = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

const fmtTs = (s: string) =>
  new Date(s).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

const changeColor = (v: number | null) =>
  v == null
    ? ""
    : v > 0
    ? "text-green-400"
    : v < 0
    ? "text-red-400"
    : "text-muted-foreground";

// ── Sub-components ─────────────────────────────────────────────────────────────

interface MetricRowProps {
  label: string;
  value: string;
  sub?: string | null;
  subColor?: string;
}

function MetricRow({ label, value, sub, subColor }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="text-right">
        <span className="text-sm font-medium">{value}</span>
        {sub && (
          <div className={cn("text-[10px] text-muted-foreground", subColor)}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

interface MetricCardProps {
  title: string;
  icon?: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}

function MetricCard({ title, icon, note, children }: MetricCardProps) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 pb-1 border-b border-border">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
      {note && (
        <p className="text-[10px] text-muted-foreground italic pt-1 border-t border-border">
          {note}
        </p>
      )}
    </div>
  );
}

// ── VIX level helpers ──────────────────────────────────────────────────────────

const VIX_LEVEL_LABELS: Record<MacroData["vix"]["level"], string> = {
  "very-low": "Very Low",
  low: "Low",
  "low-mid": "Low-Mid",
  mid: "Mid",
  "mid-high": "Mid-High",
  high: "High",
};

function vixBadgeClass(level: MacroData["vix"]["level"]) {
  switch (level) {
    case "very-low":
    case "low":
      return "bg-green-900/50 text-green-300 border-green-700";
    case "low-mid":
    case "mid":
      return "bg-yellow-900/50 text-yellow-300 border-yellow-700";
    case "mid-high":
    case "high":
      return "bg-red-900/50 text-red-300 border-red-700";
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MacroDashboard() {
  const qc = useQueryClient();
  const [highlightsOpen, setHighlightsOpen] = useState(true);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const {
    data: macroData,
    isLoading: macroLoading,
    isError: macroError,
    refetch: macroRefetch,
  } = useQuery<MacroData>({
    queryKey: ["macro-data"],
    queryFn: () => fetch("/api/macro/data").then((r) => r.json()),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: highlights } = useQuery<
    { content: string; generatedAt: string } | { noData: true }
  >({
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

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const refreshMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/refresh", { method: "POST" }).then((r) => r.json()),
    onSuccess: (data: MacroData) => {
      qc.setQueryData(["macro-data"], data);
    },
  });

  const generateHighlightsMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/highlights/generate", { method: "POST" }).then((r) =>
        r.json()
      ),
    onSuccess: (data) => {
      qc.setQueryData(["macro-highlights"], data);
    },
  });

  // ── Derived values ────────────────────────────────────────────────────────────

  const highlightsContent =
    highlights && !("noData" in highlights) ? highlights : null;

  const votingMembers = fedMembers?.filter((m) => m.voting) ?? [];
  const nonVotingMembers = fedMembers?.filter((m) => !m.voting) ?? [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const oneWeekOut = new Date(today);
  oneWeekOut.setDate(today.getDate() + 7);

  const thisWeekEvents =
    events?.filter((e) => {
      const d = new Date(e.date + "T12:00:00");
      return d >= today && d <= oneWeekOut;
    }) ?? [];

  const comingUpEvents =
    events?.filter((e) => {
      const d = new Date(e.date + "T12:00:00");
      return d > oneWeekOut;
    }) ?? [];

  const todayStr = today.toISOString().slice(0, 10);

  // ── Regime chip helpers ───────────────────────────────────────────────────────

  function inflationChip() {
    const pct = macroData?.series.corePce.changePct;
    if (pct == null) return { text: "Core PCE —", cls: "text-muted-foreground bg-secondary" };
    if (pct > 0.1)
      return { text: "Core PCE Rising ↑", cls: "bg-red-900/50 text-red-300 border-red-700" };
    if (pct < -0.1)
      return { text: "Core PCE Cooling ↓", cls: "bg-green-900/50 text-green-300 border-green-700" };
    return { text: "Core PCE Stable →", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" };
  }

  function laborChip() {
    const ch = macroData?.series.unemployment.change;
    if (ch == null) return { text: "Labor —", cls: "text-muted-foreground bg-secondary" };
    if (ch > 0.1)
      return { text: "Unemployment Rising ↑", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" };
    if (ch < -0.1)
      return { text: "Unemployment Falling ↓", cls: "bg-green-900/50 text-green-300 border-green-700" };
    return { text: "Labor Stable", cls: "bg-green-900/50 text-green-300 border-green-700" };
  }

  const infl = inflationChip();
  const labor = laborChip();

  // ── Loading / Error ───────────────────────────────────────────────────────────

  if (macroLoading) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="ml-[220px] flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (macroError) {
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

      <main className="ml-[220px] p-6 flex-1 space-y-6">
        {/* Header */}
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

        {/* Highlights */}
        <div className="bg-secondary/30 rounded-lg p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">AI Highlights</h2>
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
                Generate Highlights
              </button>
              <button
                onClick={() => setHighlightsOpen((o) => !o)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {highlightsOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
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
                  No highlights yet. Click "Generate Highlights" to create an AI summary.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Regime chips */}
        <div className="flex flex-wrap gap-2">
          {/* VIX chip */}
          {macroData?.vix && (
            <span
              className={cn(
                "text-xs px-3 py-1 rounded-full border font-medium",
                vixBadgeClass(macroData.vix.level)
              )}
            >
              VIX {fmt(macroData.vix.value, 1)} · {VIX_LEVEL_LABELS[macroData.vix.level]}
            </span>
          )}

          {/* Inflation chip */}
          <span
            className={cn(
              "text-xs px-3 py-1 rounded-full border font-medium",
              infl.cls
            )}
          >
            {infl.text}
          </span>

          {/* Labor chip */}
          <span
            className={cn(
              "text-xs px-3 py-1 rounded-full border font-medium",
              labor.cls
            )}
          >
            {labor.text}
          </span>

          {/* Policy chip */}
          <span className="text-xs px-3 py-1 rounded-full border font-medium bg-yellow-900/50 text-yellow-300 border-yellow-700">
            Fed On Hold
          </span>
        </div>

        {/* Market quick stats */}
        <div className="flex gap-3">
          {/* VIX */}
          <div className="border border-border rounded-md p-3 flex-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">VIX</p>
            <p className="text-xl font-semibold">{fmt(macroData?.vix.value, 1)}</p>
            <p className={cn("text-[11px] mt-0.5", changeColor(macroData?.vix.change ?? null))}>
              {macroData?.vix.change != null
                ? `${macroData.vix.change > 0 ? "+" : ""}${fmt(macroData.vix.change, 2)}`
                : ""}
            </p>
          </div>

          {/* 10Y Yield */}
          <div className="border border-border rounded-md p-3 flex-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">10Y Yield</p>
            <p className="text-xl font-semibold">{fmt(macroData?.yield10y.value, 3)}%</p>
            <p className={cn("text-[11px] mt-0.5", changeColor(macroData?.yield10y.change ?? null))}>
              {macroData?.yield10y.change != null
                ? `${macroData.yield10y.change > 0 ? "+" : ""}${fmt(macroData.yield10y.change, 3)}`
                : ""}
            </p>
          </div>

          {/* 2Y Yield */}
          <div className="border border-border rounded-md p-3 flex-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">2Y Yield</p>
            <p className="text-xl font-semibold">{fmt(macroData?.yield2y.value, 3)}%</p>
            <p className={cn("text-[11px] mt-0.5", changeColor(macroData?.yield2y.change ?? null))}>
              {macroData?.yield2y.change != null
                ? `${macroData.yield2y.change > 0 ? "+" : ""}${fmt(macroData.yield2y.change, 3)}`
                : ""}
            </p>
          </div>

          {/* Yield Spread */}
          <div className="border border-border rounded-md p-3 flex-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Yield Spread</p>
            <p className="text-xl font-semibold">
              {macroData?.yieldSpread != null
                ? `${(macroData.yieldSpread * 100).toFixed(0)} bps`
                : "—"}
            </p>
            <p
              className={cn(
                "text-[11px] mt-0.5",
                macroData?.yieldSpread != null && macroData.yieldSpread < 0
                  ? "text-red-400"
                  : "text-green-400"
              )}
            >
              {macroData?.yieldSpread != null
                ? macroData.yieldSpread < 0
                  ? "Inverted"
                  : "Normal"
                : ""}
            </p>
          </div>
        </div>

        {/* Main metric grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Inflation */}
          <MetricCard
            title="Inflation"
            icon={<TrendingUp className="h-4 w-4 text-red-400" />}
            note="Sticky inflation is the primary factor delaying rate cuts"
          >
            <MetricRow
              label="CPI (CPIAUCSL)"
              value={s.cpi.value != null ? `${fmt(s.cpi.value, 1)}%` : "—"}
              sub={
                s.cpi.change != null
                  ? `${s.cpi.change > 0 ? "+" : ""}${fmt(s.cpi.change, 2)} mo/mo`
                  : null
              }
              subColor={changeColor(s.cpi.change)}
            />
            <MetricRow
              label="Core CPI"
              value={s.coreCpi.value != null ? `${fmt(s.coreCpi.value, 1)}%` : "—"}
              sub={
                s.coreCpi.change != null
                  ? `${s.coreCpi.change > 0 ? "+" : ""}${fmt(s.coreCpi.change, 2)} mo/mo`
                  : null
              }
              subColor={changeColor(s.coreCpi.change)}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Core PCE{" "}
                <span className="text-xs font-medium text-foreground/70">(Fed preferred)</span>
              </span>
              <div className="text-right">
                <span className="text-sm font-medium">
                  {s.corePce.value != null ? `${fmt(s.corePce.value, 1)}%` : "—"}
                </span>
                {s.corePce.change != null && (
                  <div className={cn("text-[10px] text-muted-foreground", changeColor(s.corePce.change))}>
                    {s.corePce.change > 0 ? "+" : ""}
                    {fmt(s.corePce.change, 2)} mo/mo
                  </div>
                )}
              </div>
            </div>
          </MetricCard>

          {/* Labor Market */}
          <MetricCard
            title="Labor Market"
            icon={<Users className="h-4 w-4 text-blue-400" />}
            note="AI-driven displacement may bias unemployment higher — good for cuts, but signals economic stress"
          >
            <MetricRow
              label="Unemployment Rate"
              value={s.unemployment.value != null ? `${fmt(s.unemployment.value, 1)}%` : "—"}
              sub={
                s.unemployment.change != null
                  ? `${s.unemployment.change > 0 ? "+" : ""}${fmt(s.unemployment.change, 2)} mo/mo`
                  : null
              }
              subColor={changeColor(s.unemployment.change)}
            />
            <MetricRow
              label="Nonfarm Payrolls"
              value={fmtK(s.nonfarmPayrolls.value)}
              sub={
                s.nonfarmPayrolls.change != null
                  ? `${s.nonfarmPayrolls.change > 0 ? "+" : ""}${fmtK(s.nonfarmPayrolls.change)} mo/mo`
                  : null
              }
              subColor={changeColor(s.nonfarmPayrolls.change)}
            />
            <MetricRow
              label="JOLTS (Job Openings)"
              value={fmtK(s.jolts.value)}
              sub={
                s.jolts.change != null
                  ? `${s.jolts.change > 0 ? "+" : ""}${fmtK(s.jolts.change)} mo/mo`
                  : null
              }
              subColor={changeColor(s.jolts.change)}
            />
          </MetricCard>

          {/* Growth */}
          <MetricCard
            title="Growth"
            icon={<Activity className="h-4 w-4 text-purple-400" />}
            note="Prefer institutional bank GDP forecasts over Fed projections"
          >
            <MetricRow
              label="Real GDP Growth"
              value={s.gdp.value != null ? `${fmt(s.gdp.value, 1)}%` : "—"}
              sub={
                s.gdp.change != null
                  ? `${s.gdp.change > 0 ? "+" : ""}${fmt(s.gdp.change, 2)} qtr/qtr`
                  : null
              }
              subColor={changeColor(s.gdp.change)}
            />
            <MetricRow
              label="PPI"
              value={s.ppi.value != null ? `${fmt(s.ppi.value, 1)}%` : "—"}
              sub={
                s.ppi.change != null
                  ? `${s.ppi.change > 0 ? "+" : ""}${fmt(s.ppi.change, 2)} mo/mo`
                  : null
              }
              subColor={changeColor(s.ppi.change)}
            />
          </MetricCard>

          {/* Consumer */}
          <MetricCard
            title="Consumer"
            icon={<TrendingDown className="h-4 w-4 text-orange-400" />}
            note="Higher unemployment → lower retail spending → consumer weakness"
          >
            <MetricRow
              label="Retail Sales"
              value={s.retailSales.value != null ? `${fmt(s.retailSales.value, 1)}%` : "—"}
              sub={
                s.retailSales.change != null
                  ? `${s.retailSales.change > 0 ? "+" : ""}${fmt(s.retailSales.change, 2)} mo/mo`
                  : null
              }
              subColor={changeColor(s.retailSales.change)}
            />
            <MetricRow
              label="Consumer Sentiment"
              value={s.consumerSentiment.value != null ? fmt(s.consumerSentiment.value, 1) : "—"}
              sub={
                s.consumerSentiment.change != null
                  ? `${s.consumerSentiment.change > 0 ? "+" : ""}${fmt(s.consumerSentiment.change, 1)} mo/mo`
                  : null
              }
              subColor={changeColor(s.consumerSentiment.change)}
            />
          </MetricCard>

          {/* Rates & Policy */}
          <MetricCard
            title="Rates & Policy"
            icon={<AlertTriangle className="h-4 w-4 text-yellow-400" />}
            note="Cuts need both cooling labor AND inflation progress — currently inflation is the binding constraint"
          >
            <MetricRow
              label="Fed Funds Rate"
              value={s.fedFundsRate.value != null ? `${fmt(s.fedFundsRate.value, 2)}%` : "—"}
              sub={
                s.fedFundsRate.change != null
                  ? `${s.fedFundsRate.change > 0 ? "+" : ""}${fmt(s.fedFundsRate.change, 2)} chg`
                  : null
              }
              subColor={changeColor(s.fedFundsRate.change)}
            />
            <MetricRow
              label="10Y Treasury"
              value={macroData?.yield10y.value != null ? `${fmt(macroData.yield10y.value, 3)}%` : "—"}
              sub={
                macroData?.yield10y.changePct != null
                  ? `${macroData.yield10y.changePct > 0 ? "+" : ""}${fmt(macroData.yield10y.changePct, 2)}%`
                  : null
              }
              subColor={changeColor(macroData?.yield10y.changePct ?? null)}
            />
            <MetricRow
              label="2Y Treasury"
              value={macroData?.yield2y.value != null ? `${fmt(macroData.yield2y.value, 3)}%` : "—"}
              sub={
                macroData?.yield2y.changePct != null
                  ? `${macroData.yield2y.changePct > 0 ? "+" : ""}${fmt(macroData.yield2y.changePct, 2)}%`
                  : null
              }
              subColor={changeColor(macroData?.yield2y.changePct ?? null)}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Yield Curve</span>
              <div className="text-right">
                <span className="text-sm font-medium">
                  {macroData?.yieldSpread != null
                    ? `${(macroData.yieldSpread * 100).toFixed(0)} bps`
                    : "—"}
                </span>
                {macroData?.yieldSpread != null && macroData.yieldSpread < 0 && (
                  <div className="text-[10px] text-red-400">⚠ Inverted</div>
                )}
              </div>
            </div>
          </MetricCard>

          {/* PMI / Manufacturing (placeholder) */}
          <MetricCard
            title="PMI / Manufacturing"
            icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          >
            <div className="flex flex-col items-center justify-center py-6 gap-2">
              <Activity className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground italic">
                ISM Manufacturing PMI data coming soon
              </p>
            </div>
          </MetricCard>
        </div>

        {/* Fed Members */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Fed Members</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Voting */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Voting</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {votingMembers.length}
                </Badge>
              </div>
              <div className="space-y-2">
                {votingMembers.map((m) => (
                  <FedMemberCard key={m.name} member={m} />
                ))}
                {votingMembers.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">No data</p>
                )}
              </div>
            </div>

            {/* Non-Voting */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Non-Voting</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {nonVotingMembers.length}
                </Badge>
              </div>
              <div className="space-y-2">
                {nonVotingMembers.map((m) => (
                  <FedMemberCard key={m.name} member={m} />
                ))}
                {nonVotingMembers.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">No data</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Upcoming Events */}
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

// ── Fed member card ────────────────────────────────────────────────────────────

function stanceBadgeClass(stance: FedMember["stance"]) {
  switch (stance) {
    case "hawkish":
      return "bg-red-900/60 text-red-200";
    case "neutral":
      return "bg-yellow-900/60 text-yellow-200";
    case "dovish":
      return "bg-green-900/60 text-green-200";
  }
}

function FedMemberCard({ member }: { member: FedMember }) {
  return (
    <div className="border border-border rounded-md p-3 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold leading-tight">{member.name}</p>
          <p className="text-[10px] text-muted-foreground">{member.title}</p>
        </div>
        <span
          className={cn(
            "text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap capitalize",
            stanceBadgeClass(member.stance)
          )}
        >
          {member.stance}
        </span>
      </div>
      {member.notes && (
        <p className="text-[11px] text-muted-foreground italic line-clamp-2">{member.notes}</p>
      )}
    </div>
  );
}

// ── Event row ─────────────────────────────────────────────────────────────────

function importanceBadgeClass(imp: MacroEvent["importance"]) {
  switch (imp) {
    case "high":
      return "bg-amber-900/60 text-amber-200";
    case "medium":
      return "bg-blue-900/60 text-blue-200";
    case "low":
      return "bg-secondary text-muted-foreground";
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
