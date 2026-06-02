import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface IndicatorResult {
  ticker: string;
  rsi: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  scoredDate: string;
}

type BatchResponse = Record<string, IndicatorResult | { error: string }>;

function isError(v: IndicatorResult | { error: string }): v is { error: string } {
  return "error" in v;
}

// ── Sort ──────────────────────────────────────────────────────────────────────

type SortKey = "signal" | "rsi" | "mfi" | "tier";

const SIGNAL_ORDER: Record<string, number> = { GO: 0, WATCH: 1, NO: 2 };

function sortResults(rows: IndicatorResult[], key: SortKey): IndicatorResult[] {
  return [...rows].sort((a, b) => {
    if (key === "signal") {
      const sd = SIGNAL_ORDER[a.signal] - SIGNAL_ORDER[b.signal];
      return sd !== 0 ? sd : a.rsi - b.rsi;
    }
    if (key === "rsi") return a.rsi - b.rsi;
    if (key === "mfi") return a.mfi - b.mfi;
    // tier
    const td = a.tier - b.tier;
    return td !== 0 ? td : SIGNAL_ORDER[a.signal] - SIGNAL_ORDER[b.signal];
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function IndicatorBar({ value, threshold, ok }: { value: number; threshold: number; ok: boolean }) {
  const pct = Math.min(100, (value / threshold) * 100);
  const color = ok
    ? "bg-green-500"
    : value >= threshold - 5
    ? "bg-yellow-500"
    : "bg-red-500";
  return (
    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls =
    tier === 1 ? "bg-blue-500/15 text-blue-400 border-blue-500/20" :
    tier === 2 ? "bg-purple-500/15 text-purple-400 border-purple-500/20" :
                 "bg-orange-500/15 text-orange-400 border-orange-500/20";
  return <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-semibold", cls)}>T{tier}</Badge>;
}

function SignalBadge({ signal }: { signal: "GO" | "WATCH" | "NO" }) {
  const cls =
    signal === "GO"    ? "bg-green-500/15 text-green-400 border-green-500/30" :
    signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                         "bg-muted text-muted-foreground border-border";
  return <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-bold", cls)}>{signal}</Badge>;
}

function TickerCard({
  result,
  onRefresh,
  refreshing,
}: {
  result: IndicatorResult;
  onRefresh: (ticker: string) => void;
  refreshing: boolean;
}) {
  const borderColor =
    result.signal === "GO"    ? "border-l-green-500" :
    result.signal === "WATCH" ? "border-l-yellow-500" :
                                "border-l-border/40";

  const dateLabel = result.scoredDate
    ? new Date(result.scoredDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

  return (
    <Card className={cn("border-l-2 transition-all hover:shadow-md", borderColor, result.signal === "NO" && "opacity-60")}>
      <CardContent className="p-3 space-y-2.5">
        {/* Top row */}
        <div className="flex items-center justify-between">
          <TierBadge tier={result.tier} />
          <SignalBadge signal={result.signal} />
        </div>

        {/* Ticker */}
        <div className="text-xl font-mono font-bold tracking-tight leading-none">{result.ticker}</div>

        {/* Divider */}
        <div className="h-px bg-border/40" />

        {/* RSI */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground font-medium">RSI</span>
            <span className={cn("font-mono tabular-nums font-semibold", result.rsiOk ? "text-green-400" : "text-red-400")}>
              {result.rsi.toFixed(1)}<span className="text-muted-foreground font-normal"> / {result.rsiThreshold}</span>
            </span>
          </div>
          <IndicatorBar value={result.rsi} threshold={result.rsiThreshold} ok={result.rsiOk} />
        </div>

        {/* MFI */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground font-medium">MFI</span>
            <span className={cn("font-mono tabular-nums font-semibold", result.mfiOk ? "text-green-400" : "text-red-400")}>
              {result.mfi.toFixed(1)}<span className="text-muted-foreground font-normal"> / 25</span>
            </span>
          </div>
          <IndicatorBar value={result.mfi} threshold={result.mfiThreshold} ok={result.mfiOk} />
        </div>

        {/* Divider */}
        <div className="h-px bg-border/40" />

        {/* Footer */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => onRefresh(result.ticker)}
            disabled={refreshing}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            title="Refresh this ticker"
          >
            <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          </button>
          <span className="text-[10px] text-muted-foreground/60">{dateLabel}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card className="border-l-2 border-l-border/40">
      <CardContent className="p-3 space-y-2.5">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="h-6 w-16" />
        <div className="h-px bg-border/40" />
        <div className="space-y-1">
          <div className="flex justify-between">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-1.5 w-full" />
        </div>
        <div className="space-y-1">
          <div className="flex justify-between">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-1.5 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const SORT_LABELS: { key: SortKey; label: string }[] = [
  { key: "signal", label: "Signal" },
  { key: "rsi",    label: "RSI" },
  { key: "mfi",    label: "MFI" },
  { key: "tier",   label: "Tier" },
];

export default function Technical() {
  const [sortKey, setSortKey] = useState<SortKey>("signal");
  const [refreshingTickers, setRefreshingTickers] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch, isFetching } = useQuery<BatchResponse>({
    queryKey: ["indicators", "batch"],
    queryFn: async () => {
      const res = await fetch("/api/indicators/batch");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    },
    staleTime: 4 * 60 * 1000,
    retry: 1,
  });

  const handleRefreshTicker = async (ticker: string) => {
    setRefreshingTickers(s => new Set(s).add(ticker));
    try {
      await fetch(`/api/indicators/${ticker}?refresh=true`);
      await queryClient.invalidateQueries({ queryKey: ["indicators", "batch"] });
    } finally {
      setRefreshingTickers(s => { const n = new Set(s); n.delete(ticker); return n; });
    }
  };

  const results: IndicatorResult[] = data
    ? sortResults(
        Object.values(data).filter((v): v is IndicatorResult => !isError(v)),
        sortKey,
      )
    : [];

  const errorCount = data ? Object.values(data).filter(isError).length : 0;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        {/* Header */}
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Technical Scorecard</h1>
            <p className="text-xs text-muted-foreground mt-0.5">RSI + MFI signal status — {results.length} tickers</p>
          </div>

          <div className="flex items-center gap-3">
            {/* Sort controls */}
            <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-0.5">
              {SORT_LABELS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setSortKey(key)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                    sortKey === key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-8 gap-1.5"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
              Refresh All
            </Button>
          </div>
        </div>

        {/* Info banner */}
        <div className="px-5 py-2 bg-secondary/20 border-b border-border/30 text-[11px] text-muted-foreground flex items-center gap-2">
          <span>Signals computed once daily from 90-day OHLCV.</span>
          <span>Use ↻ on any card to force recalculate from live data.</span>
          {errorCount > 0 && (
            <span className="ml-auto flex items-center gap-1 text-yellow-500">
              <AlertCircle className="w-3 h-3" />{errorCount} tickers failed
            </span>
          )}
        </div>

        {/* Content */}
        <div className="p-5">
          {error ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
              <AlertCircle className="w-10 h-10 text-red-400" />
              <p className="text-sm text-muted-foreground">Failed to load indicators.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {Array.from({ length: 31 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {results.map(r => (
                <TickerCard
                  key={r.ticker}
                  result={r}
                  onRefresh={handleRefreshTicker}
                  refreshing={refreshingTickers.has(r.ticker)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
