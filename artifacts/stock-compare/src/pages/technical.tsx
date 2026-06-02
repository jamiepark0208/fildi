import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { TickerShelf } from "@/components/ticker-shelf";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  rsi: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  atr: number | null;
  macdCross: "BULLISH_CROSS" | "BEARISH_CROSS" | "BULLISH" | "BEARISH" | null;
  stoch: number | null;
  return5d: number | null;
  position52w: number | null;
  vsSpy20d: number | null;
  earningsDate: string | null;
  stale?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SLOTS  = 5;
const SLOT_COLORS = ["#38bdf8", "#fb923c", "#34d399", "#a78bfa", "#f472b6"];

// ── Small helpers ─────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls =
    tier === 1 ? "bg-blue-500/15 text-blue-400 border-blue-500/20" :
    tier === 2 ? "bg-purple-500/15 text-purple-400 border-purple-500/20" :
                 "bg-orange-500/15 text-orange-400 border-orange-500/20";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-semibold", cls)}>
      T{tier}
    </Badge>
  );
}

function SignalBadge({ signal }: { signal: "GO" | "WATCH" | "NO" }) {
  const cls =
    signal === "GO"    ? "bg-green-500/15 text-green-400 border-green-500/30" :
    signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                         "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-bold", cls)}>
      {signal}
    </Badge>
  );
}

function IndicatorBar({ value, threshold, ok }: { value: number; threshold: number; ok: boolean }) {
  const pct   = Math.min(100, (value / threshold) * 100);
  const color = ok ? "bg-green-500" : value >= threshold - 5 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-1 w-full bg-secondary rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MacdBadge({ cross }: { cross: IndicatorResult["macdCross"] }) {
  if (!cross) return null;
  const isBull  = cross.startsWith("BULLISH");
  const isCross = cross.endsWith("_CROSS");
  const label   = isCross ? (isBull ? "MACD↑" : "MACD↓") : (isBull ? "MACD+" : "MACD−");
  const cls     = isBull
    ? "bg-green-500/10 text-green-400 border-green-500/20"
    : "bg-red-500/10 text-red-400 border-red-500/20";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4", isCross && "font-bold", cls)}>
      {label}
    </Badge>
  );
}

// ── 5-slot card row ───────────────────────────────────────────────────────────

interface TechnicalCardsProps {
  tickers: string[];
  data: Record<string, IndicatorResult | null>;
  loading: Record<string, boolean>;
  onAddClick: () => void;
  onRemove: (t: string) => void;
  onRefresh: (t: string) => void;
  refreshing: Set<string>;
}

function TechnicalCards({ tickers, data, loading, onAddClick, onRemove, onRefresh, refreshing }: TechnicalCardsProps) {
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => tickers[i] ?? null);

  return (
    <div className="grid grid-cols-5 gap-3">
      {slots.map((ticker, i) => {
        const color = SLOT_COLORS[i];

        if (!ticker) {
          return (
            <button
              key={`empty-${i}`}
              onClick={onAddClick}
              className="h-[200px] rounded-xl border border-dashed border-border/60 bg-card/30 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all group"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <div className="w-8 h-8 rounded-full border border-dashed border-current flex items-center justify-center group-hover:border-solid transition-all">
                <Plus className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium">Add Ticker</span>
            </button>
          );
        }

        if (loading[ticker]) {
          return (
            <div
              key={ticker}
              className="h-[200px] rounded-xl border border-border bg-card shadow-sm flex items-center justify-center"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          );
        }

        const d = data[ticker];
        if (!d) {
          return (
            <div
              key={ticker}
              className="h-[200px] rounded-xl border border-border bg-card shadow-sm p-3 flex flex-col justify-between"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-base tracking-tight" style={{ color }}>{ticker}</span>
                <button onClick={() => onRemove(ticker)} className="text-muted-foreground hover:text-foreground text-xs w-5 h-5 flex items-center justify-center">×</button>
              </div>
              <p className="text-xs text-muted-foreground">No data</p>
            </div>
          );
        }

        const earningsSoon = d.earningsDate
          ? (new Date(d.earningsDate + "T12:00:00").getTime() - Date.now()) / 86400000 < 14
          : false;

        return (
          <div
            key={ticker}
            className="rounded-xl border border-border bg-card shadow-sm p-3 flex flex-col gap-2.5"
            style={{ borderLeftColor: color, borderLeftWidth: 3 }}
          >
            {/* Header row */}
            <div className="flex items-start justify-between">
              <div>
                <span className="font-mono font-bold text-base tracking-tight" style={{ color }}>{ticker}</span>
                <div className="flex items-center gap-1 mt-0.5">
                  <TierBadge tier={d.tier} />
                  <SignalBadge signal={d.signal} />
                  {earningsSoon && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-orange-500/10 text-orange-400 border-orange-500/20">EARN</Badge>
                  )}
                </div>
              </div>
              <button onClick={() => onRemove(ticker)} className="text-muted-foreground hover:text-foreground text-xs w-5 h-5 flex items-center justify-center shrink-0">×</button>
            </div>

            {/* RSI */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">RSI 14</span>
                <span className={cn("font-mono font-semibold tabular-nums", d.rsiOk ? "text-green-400" : "text-red-400")}>
                  {d.rsi.toFixed(1)}<span className="text-muted-foreground font-normal"> /{d.rsiThreshold}</span>
                </span>
              </div>
              <IndicatorBar value={d.rsi} threshold={d.rsiThreshold} ok={d.rsiOk} />
            </div>

            {/* MFI */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">MFI 14</span>
                <span className={cn("font-mono font-semibold tabular-nums", d.mfiOk ? "text-green-400" : "text-red-400")}>
                  {d.mfi.toFixed(1)}<span className="text-muted-foreground font-normal"> /25</span>
                </span>
              </div>
              <IndicatorBar value={d.mfi} threshold={d.mfiThreshold} ok={d.mfiOk} />
            </div>

            <div className="h-px bg-border/30" />

            {/* Extended metrics */}
            <div className="space-y-1 text-[11px]">
              {d.return5d != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">5d return</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.return5d > 8 ? "text-red-400" : d.return5d > 3 ? "text-yellow-400" : d.return5d < 0 ? "text-green-400" : "text-foreground"
                  )}>
                    {d.return5d > 0 ? "+" : ""}{d.return5d.toFixed(1)}%
                  </span>
                </div>
              )}
              {d.position52w != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">52w pos</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.position52w < 30 ? "text-green-400" : d.position52w > 70 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.position52w.toFixed(0)}%
                  </span>
                </div>
              )}
              {d.vsSpy20d != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">vs SPY 20d</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.vsSpy20d < 0 ? "text-green-400" : d.vsSpy20d > 5 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.vsSpy20d > 0 ? "+" : ""}{d.vsSpy20d.toFixed(1)}%
                  </span>
                </div>
              )}
              {d.stoch != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stoch %K</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.stoch < 20 ? "text-green-400" : d.stoch > 80 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.stoch.toFixed(1)}
                  </span>
                </div>
              )}
            </div>

            {/* Footer: MACD badge + refresh */}
            <div className="flex items-center justify-between mt-auto">
              <MacdBadge cross={d.macdCross} />
              <button
                onClick={() => onRefresh(ticker)}
                disabled={refreshing.has(ticker)}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 ml-auto"
                title="Recompute from live data"
              >
                <RefreshCw className={cn("w-3 h-3", refreshing.has(ticker) && "animate-spin")} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Technical() {
  const [tickers,   setTickers]   = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());

  const handleAdd    = (t: string) => { if (!tickers.includes(t) && tickers.length < MAX_SLOTS) setTickers(p => [...p, t]); };
  const handleRemove = (t: string) => setTickers(p => p.filter(x => x !== t));
  const focusInput   = () => document.querySelector<HTMLInputElement>('input[placeholder="Add ticker..."]')?.focus();

  const queries = useQueries({
    queries: tickers.map(ticker => ({
      queryKey: ["indicators", ticker],
      queryFn: async (): Promise<IndicatorResult | null> => {
        const res = await fetch(`/api/indicators/${ticker}`);
        if (!res.ok) return null;
        return res.json();
      },
      staleTime: 4 * 60 * 1000,
      retry: 1,
    })),
  });

  const loadingMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    tickers.forEach((t, i) => { m[t] = queries[i]?.isLoading ?? false; });
    return m;
  }, [tickers, queries]);

  const dataMap = useMemo(() => {
    const m: Record<string, IndicatorResult | null> = {};
    tickers.forEach((t, i) => { m[t] = (queries[i]?.data as IndicatorResult | null | undefined) ?? null; });
    return m;
  }, [tickers, queries]);

  const handleRefresh = async (ticker: string) => {
    setRefreshing(s => new Set(s).add(ticker));
    try {
      const res = await fetch(`/api/technical/refresh/${ticker}`, { method: "POST" });
      if (res.ok) {
        const fresh: IndicatorResult = await res.json();
        // Update the cached query data directly
        queries[tickers.indexOf(ticker)]?.refetch?.();
      }
    } finally {
      setRefreshing(s => { const n = new Set(s); n.delete(ticker); return n; });
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        {/* Header — matches Fundamental layout */}
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Technical Scorecard</h1>
            <p className="text-xs text-muted-foreground mt-0.5">RSI · MFI · MACD · 5d return · 52w position · vs SPY</p>
          </div>
          <TickerShelf
            tickers={tickers}
            loadingTickers={loadingMap}
            onAdd={handleAdd}
            onRemove={handleRemove}
          />
        </div>

        <div className="p-5">
          <TechnicalCards
            tickers={tickers}
            data={dataMap}
            loading={loadingMap}
            onAddClick={focusInput}
            onRemove={handleRemove}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
        </div>
      </main>
    </div>
  );
}
