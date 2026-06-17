import { useMemo, useState, useCallback } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetStockHistoryQueryOptions, getGetStockHistoryQueryKey, StockMetrics } from "@workspace/api-client-react";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { STOCK_COLORS } from "./stock-cards";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceArea,
} from "recharts";
import { cn } from "@/lib/utils";
import { computeChartZones, zoneYBounds, type DbTechnicalLevels } from "@/lib/chart-levels";
import { toast } from "@/hooks/use-toast";

export type Period = "1D" | "1W" | "1M" | "3M" | "1Y";

interface PriceChartProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  selectedPeriod: Period;
  onPeriodChange: (period: Period) => void;
  showTechnicalZones?: boolean;
  tickerForTechnicals?: string;
}

function assignYAxes(stocks: StockMetrics[]): Record<string, "left" | "right"> {
  if (stocks.length <= 1) return Object.fromEntries(stocks.map(s => [s.ticker, "left"]));
  const sorted = [...stocks].sort((a, b) => (a.currentPrice ?? 0) - (b.currentPrice ?? 0));
  const mid = Math.ceil(sorted.length / 2);
  const result: Record<string, "left" | "right"> = {};
  sorted.forEach((s, i) => { result[s.ticker] = i < mid ? "left" : "right"; });
  return result;
}

type HistoryBar = { date: string; close: number; high?: number | null; low?: number | null };

function mergeHistoryData(
  tickers: string[],
  historyByTicker: Record<string, HistoryBar[]>,
): Record<string, number | string>[] {
  const allDates = Array.from(
    new Set(tickers.flatMap(t => (historyByTicker[t] ?? []).map(p => p.date))),
  ).sort();

  return allDates.map(date => {
    const row: Record<string, number | string> = { date };
    for (const ticker of tickers) {
      const point = (historyByTicker[ticker] ?? []).find(p => p.date === date);
      if (point) row[ticker] = point.close;
    }
    return row;
  });
}

const PERIODS: Period[] = ["1D", "1W", "1M", "3M", "1Y"];

async function fetchTechnicals(ticker: string): Promise<DbTechnicalLevels | null> {
  const res = await fetch(`/api/technicals/${encodeURIComponent(ticker)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load technical levels");
  return res.json();
}

export function PriceChart({
  tickers,
  loadedStocks,
  selectedPeriod,
  onPeriodChange,
  showTechnicalZones = false,
  tickerForTechnicals,
}: PriceChartProps) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const techTicker = showTechnicalZones ? tickerForTechnicals?.toUpperCase() : undefined;

  const queries = useQueries({
    queries: tickers.map((ticker) => ({
      ...getGetStockHistoryQueryOptions({ ticker, period: selectedPeriod }),
      staleTime: showTechnicalZones ? Infinity : 5 * 60 * 1000,
      refetchOnWindowFocus: !showTechnicalZones,
    })),
  });

  const technicalsQuery = useQuery({
    queryKey: ["technicals", techTicker],
    queryFn: () => fetchTechnicals(techTicker!),
    enabled: !!techTicker,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const isLoading = queries.some(q => q.isLoading);
  const isError = queries.some(q => q.isError);

  const { data, historyByTicker, yAxes, hasRightAxis } = useMemo(() => {
    const historyByTicker: Record<string, HistoryBar[]> = {};
    tickers.forEach((ticker, i) => {
      const qData = queries[i]?.data;
      if (qData) {
        historyByTicker[ticker] = qData.map(p => ({
          date: p.date,
          close: p.close,
          high: p.high,
          low: p.low,
        }));
      }
    });

    const merged = mergeHistoryData(tickers, historyByTicker);
    const validStocks = loadedStocks.filter(s => tickers.includes(s.ticker) && s.currentPrice !== undefined);
    const axes = assignYAxes(validStocks);
    const hasRight = Object.values(axes).includes("right");

    return { data: merged, historyByTicker, yAxes: axes, hasRightAxis: hasRight };
  }, [tickers, queries, loadedStocks]);

  const zones = useMemo(() => {
    if (!showTechnicalZones || !techTicker) return [];
    const bars = historyByTicker[techTicker] ?? historyByTicker[tickers[0]] ?? [];
    return computeChartZones(bars, selectedPeriod, technicalsQuery.data ?? null);
  }, [showTechnicalZones, techTicker, historyByTicker, tickers, selectedPeriod, technicalsQuery.data]);

  const zoneAxisId = techTicker ? (yAxes[techTicker] ?? yAxes[tickers[0]] ?? "left") : "left";

  const handleRefresh = useCallback(async () => {
    if (!techTicker) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/technicals/refresh/${encodeURIComponent(techTicker)}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Refresh failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["technicals", techTicker] });
      for (const ticker of tickers) {
        await queryClient.invalidateQueries({
          queryKey: getGetStockHistoryQueryKey({ ticker, period: selectedPeriod }),
        });
      }
      await queryClient.refetchQueries({ queryKey: ["technicals", techTicker] });
      toast({ title: "Chart levels refreshed" });
    } catch (e) {
      toast({
        title: "Refresh failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  }, [techTicker, tickers, selectedPeriod, queryClient]);

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm mb-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold tracking-tight">Price History</h2>
          {isError && (
            <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 px-2.5 py-1 rounded-full font-medium">
              <AlertCircle className="w-3.5 h-3.5" />
              Some data unavailable
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showTechnicalZones && techTicker && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh support/resistance levels"
              className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-50"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
              Levels
            </button>
          )}
          <div className="flex items-center bg-secondary/60 rounded-lg p-1 border border-border/50">
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "px-3 py-1.5 text-xs font-bold rounded-md transition-colors",
                  selectedPeriod === p
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-[320px] w-full relative">
        {isLoading && data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10 rounded-lg border border-border/50">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground border border-dashed border-border rounded-lg">
            No data available for this period.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: hasRightAxis ? 5 : 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} vertical={false} />
              {showTechnicalZones && zones.map(z => {
                const { y1, y2 } = zoneYBounds(z);
                return (
                  <ReferenceArea
                    key={`${z.kind}-${z.label}-${z.price}`}
                    yAxisId={zoneAxisId}
                    y1={y1}
                    y2={y2}
                    fill={z.kind === "support" ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)"}
                    stroke={z.kind === "support" ? "rgba(34, 197, 94, 0.35)" : "rgba(239, 68, 68, 0.35)"}
                    strokeOpacity={0.6}
                    ifOverflow="hidden"
                  />
                );
              })}
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: "rgba(255,255,255,0.8)" }}
                tickMargin={12}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => {
                  const d = new Date(val);
                  if (selectedPeriod === "1D") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                  if (selectedPeriod === "1W" || selectedPeriod === "1M") return d.toLocaleDateString([], { month: "short", day: "numeric" });
                  return d.toLocaleDateString([], { month: "short", year: "numeric" });
                }}
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                tick={{ fontSize: 12, fill: "rgba(255,255,255,0.8)", fontFamily: "monospace" }}
                domain={["auto", "auto"]}
                tickFormatter={(val) => `$${val}`}
                width={60}
                axisLine={false}
                tickLine={false}
              />
              {hasRightAxis && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 12, fill: "rgba(255,255,255,0.8)", fontFamily: "monospace" }}
                  domain={["auto", "auto"]}
                  tickFormatter={(val) => `$${val}`}
                  width={60}
                  axisLine={false}
                  tickLine={false}
                />
              )}
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8, color: "hsl(var(--foreground))", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)" }}
                itemStyle={{ fontWeight: "bold", fontFamily: "monospace" }}
                labelStyle={{ color: "hsl(var(--muted-foreground))", marginBottom: 6, fontSize: "13px" }}
                formatter={(val: number, name: string) => [`$${val.toFixed(2)}`, name]}
                labelFormatter={(label) => {
                  const d = new Date(label as string);
                  if (selectedPeriod === "1D") return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
                  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 20, fontWeight: 500 }}
                iconType="circle"
                iconSize={8}
              />
              {tickers.map((ticker, i) => (
                <Line
                  key={ticker}
                  yAxisId={yAxes[ticker] || "left"}
                  type="monotone"
                  dataKey={ticker}
                  stroke={STOCK_COLORS[i % STOCK_COLORS.length]}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 0, fill: STOCK_COLORS[i % STOCK_COLORS.length] }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {showTechnicalZones && zones.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-border/40">
          {zones.map(z => (
            <span
              key={`chip-${z.kind}-${z.label}-${z.price}`}
              className={cn(
                "text-[10px] font-mono px-2 py-0.5 rounded border",
                z.kind === "support"
                  ? "text-green-400/90 bg-green-500/10 border-green-500/20"
                  : "text-red-400/90 bg-red-500/10 border-red-500/20",
              )}
            >
              {z.label} ${z.price.toFixed(2)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
