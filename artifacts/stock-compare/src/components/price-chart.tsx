import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGetStockHistoryQueryOptions, StockMetrics } from "@workspace/api-client-react";
import { Loader2, AlertCircle } from "lucide-react";
import { STOCK_COLORS } from "./stock-cards";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend
} from "recharts";
import { cn } from "@/lib/utils";

export type Period = "1D" | "1W" | "1M" | "3M" | "1Y";

interface PriceChartProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  selectedPeriod: Period;
  onPeriodChange: (period: Period) => void;
}

function assignYAxes(stocks: StockMetrics[]): Record<string, "left" | "right"> {
  if (stocks.length <= 1) return Object.fromEntries(stocks.map(s => [s.ticker, "left"]));
  const sorted = [...stocks].sort((a, b) => (a.currentPrice ?? 0) - (b.currentPrice ?? 0));
  const mid = Math.ceil(sorted.length / 2);
  const result: Record<string, "left" | "right"> = {};
  sorted.forEach((s, i) => { result[s.ticker] = i < mid ? "left" : "right"; });
  return result;
}

function mergeHistoryData(
  tickers: string[],
  historyByTicker: Record<string, { date: string; close: number }[]>
): Record<string, number | string>[] {
  const allDates = Array.from(
    new Set(tickers.flatMap(t => (historyByTicker[t] ?? []).map(p => p.date)))
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

export function PriceChart({ tickers, loadedStocks, selectedPeriod, onPeriodChange }: PriceChartProps) {
  const queries = useQueries({
    queries: tickers.map((ticker) => ({
      ...getGetStockHistoryQueryOptions({ ticker, period: selectedPeriod }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const isLoading = queries.some(q => q.isLoading);
  const isError = queries.some(q => q.isError);

  const { data, yAxes, hasRightAxis } = useMemo(() => {
    const historyByTicker: Record<string, { date: string; close: number }[]> = {};
    tickers.forEach((ticker, i) => {
      const qData = queries[i]?.data;
      if (qData) {
        historyByTicker[ticker] = qData;
      }
    });

    const merged = mergeHistoryData(tickers, historyByTicker);
    const validStocks = loadedStocks.filter(s => tickers.includes(s.ticker) && s.currentPrice !== undefined);
    const axes = assignYAxes(validStocks);
    const hasRight = Object.values(axes).includes("right");

    return { data: merged, yAxes: axes, hasRightAxis: hasRight };
  }, [tickers, queries, loadedStocks]);

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
        <div className="flex items-center bg-secondary/60 rounded-lg p-1 border border-border/50">
          {PERIODS.map(p => (
            <button
              key={p}
              onClick={() => onPeriodChange(p)}
              className={cn(
                "px-3 py-1.5 text-xs font-bold rounded-md transition-colors",
                selectedPeriod === p 
                  ? "bg-primary text-primary-foreground shadow-sm" 
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50"
              )}
            >
              {p}
            </button>
          ))}
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
              <XAxis 
                dataKey="date" 
                tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                tickMargin={12}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => {
                  const d = new Date(val);
                  if (selectedPeriod === "1D") return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  if (selectedPeriod === "1W" || selectedPeriod === "1M") return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                  return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
                }}
              />
              <YAxis 
                yAxisId="left" 
                orientation="left" 
                tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontFamily: 'monospace' }} 
                domain={['auto', 'auto']}
                tickFormatter={(val) => `$${val}`}
                width={60}
                axisLine={false}
                tickLine={false}
              />
              {hasRightAxis && (
                <YAxis 
                  yAxisId="right" 
                  orientation="right" 
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontFamily: 'monospace' }}
                  domain={['auto', 'auto']}
                  tickFormatter={(val) => `$${val}`}
                  width={60}
                  axisLine={false}
                  tickLine={false}
                />
              )}
              <Tooltip 
                contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: 8, color: 'hsl(var(--foreground))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' }}
                itemStyle={{ fontWeight: 'bold', fontFamily: 'monospace' }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: 6, fontSize: '13px' }}
                formatter={(val: number) => [`$${val.toFixed(2)}`, '']}
                labelFormatter={(label) => {
                  const d = new Date(label as string);
                  if (selectedPeriod === "1D") return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
    </div>
  );
}
