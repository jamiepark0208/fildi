import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetStockHistoryQueryOptions, getGetStockHistoryQueryKey, StockMetrics } from "@workspace/api-client-react";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { STOCK_COLORS } from "./stock-cards";
import {
  createChart, createSeriesMarkers, LineSeries, ColorType, LineStyle, CrosshairMode,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type IPriceLine, type UTCTimestamp, type Time,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { computeChartZones, type DbTechnicalLevels } from "@/lib/chart-levels";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";

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

const PERIODS: Period[] = ["1D", "1W", "1M", "3M", "1Y"];

function toUnixTime(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

function computeEMA(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

async function fetchTechnicals(ticker: string): Promise<DbTechnicalLevels | null> {
  const res = await fetch(`/api/technicals/${encodeURIComponent(ticker)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load technical levels");
  return res.json();
}

type LWPoint = { time: UTCTimestamp; value: number };

interface LWSeriesSpec {
  ticker: string;
  color: string;
  scaleId: "left" | "right";
  data: LWPoint[];
}

interface LWMarker {
  time: UTCTimestamp;
  price: number;
  color: string;
  text?: string;
}

interface LWPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

interface LightweightPriceChartProps {
  series: LWSeriesSpec[];
  hasRightAxis: boolean;
  period: Period;
  emaSeries?: { ema50: LWPoint[]; ema200: LWPoint[] } | null;
  markers?: LWMarker[];
  priceLines?: LWPriceLine[];
}

function formatTickTime(time: Time, period: Period): string {
  const ms = (time as number) * 1000;
  const d = new Date(ms);
  if (period === "1D") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (period === "1W") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${yy}`;
}

function formatTooltipTime(time: Time, period: Period): string {
  const ms = (time as number) * 1000;
  const d = new Date(ms);
  if (period === "1D") return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Imperative lightweight-charts canvas — created once and updated in place, rather than re-mounted on every render. */
function LightweightPriceChart({ series, hasRightAxis, period, emaSeries, markers, priceLines }: LightweightPriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const emaSeriesRef = useRef<{ ema50: ISeriesApi<"Line"> | null; ema200: ISeriesApi<"Line"> | null }>({ ema50: null, ema200: null });
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineHandlesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.8)",
        fontSize: 11,
        fontFamily: "monospace",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale: { visible: true, borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    chart.subscribeCrosshairMove(param => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param.time || !param.point) {
        tooltip.style.opacity = "0";
        return;
      }
      const lines: string[] = [`<div class="font-bold mb-1">${formatTooltipTime(param.time, period)}</div>`];
      seriesMapRef.current.forEach((s, ticker) => {
        const d = param.seriesData.get(s) as LWPoint | undefined;
        if (d?.value != null) {
          lines.push(`<div style="color:${s.options().color}">${ticker}: $${d.value.toFixed(2)}</div>`);
        }
      });
      if (lines.length <= 1) {
        tooltip.style.opacity = "0";
        return;
      }
      tooltip.innerHTML = lines.join("");
      tooltip.style.opacity = "1";
      tooltip.style.left = `${Math.min(param.point.x + 12, container.clientWidth - 140)}px`;
      tooltip.style.top = "8px";
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesMapRef.current.clear();
      emaSeriesRef.current = { ema50: null, ema200: null };
      markersApiRef.current = null;
      priceLineHandlesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      rightPriceScale: { visible: hasRightAxis },
      timeScale: { tickMarkFormatter: (time: Time) => formatTickTime(time, period) },
    });
  }, [hasRightAxis, period]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const seen = new Set(series.map(s => s.ticker));
    seriesMapRef.current.forEach((s, ticker) => {
      if (!seen.has(ticker)) {
        chart.removeSeries(s);
        seriesMapRef.current.delete(ticker);
      }
    });
    series.forEach(spec => {
      let s = seriesMapRef.current.get(spec.ticker);
      if (!s) {
        s = chart.addSeries(LineSeries, {
          color: spec.color,
          lineWidth: 2,
          priceScaleId: spec.scaleId === "left" ? "left" : "right",
          lastValueVisible: series.length === 1,
          priceLineVisible: series.length === 1,
        });
        seriesMapRef.current.set(spec.ticker, s);
      } else {
        s.applyOptions({ priceScaleId: spec.scaleId === "left" ? "left" : "right" });
      }
      s.setData(spec.data);
    });
    chart.timeScale().fitContent();
  }, [series]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const { ema50, ema200 } = emaSeriesRef.current;
    if (!emaSeries) {
      if (ema50) { chart.removeSeries(ema50); emaSeriesRef.current.ema50 = null; }
      if (ema200) { chart.removeSeries(ema200); emaSeriesRef.current.ema200 = null; }
      return;
    }
    if (!ema50) {
      emaSeriesRef.current.ema50 = chart.addSeries(LineSeries, {
        color: "#eab308", lineWidth: 1, lineStyle: LineStyle.Dashed,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
    }
    if (!ema200) {
      emaSeriesRef.current.ema200 = chart.addSeries(LineSeries, {
        color: "#f59e0b", lineWidth: 2,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
    }
    emaSeriesRef.current.ema50!.setData(emaSeries.ema50);
    emaSeriesRef.current.ema200!.setData(emaSeries.ema200);
  }, [emaSeries]);

  useEffect(() => {
    const primary = seriesMapRef.current.get(series[0]?.ticker ?? "");
    if (!primary) return;
    const marks = (markers ?? []).map(m => ({
      time: m.time,
      position: "atPriceMiddle" as const,
      price: m.price,
      color: m.color,
      shape: "circle" as const,
      size: 1,
      text: m.text,
    }));
    if (!markersApiRef.current) {
      markersApiRef.current = createSeriesMarkers(primary, marks);
    } else {
      markersApiRef.current.setMarkers(marks);
    }
  }, [markers, series]);

  useEffect(() => {
    const primary = seriesMapRef.current.get(series[0]?.ticker ?? "");
    priceLineHandlesRef.current.forEach(h => primary?.removePriceLine(h));
    priceLineHandlesRef.current = [];
    if (!primary || !priceLines) return;
    priceLineHandlesRef.current = priceLines.map(pl => primary.createPriceLine({
      price: pl.price,
      color: pl.color,
      lineWidth: 1,
      lineStyle: pl.dashed ? LineStyle.Dashed : LineStyle.Solid,
      axisLabelVisible: true,
      title: pl.title,
    }));
  }, [priceLines, series]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute z-10 rounded-md border border-border/50 bg-card/95 px-2.5 py-1.5 text-xs shadow-lg transition-opacity"
        style={{ opacity: 0 }}
      />
    </div>
  );
}

export function PriceChart({
  tickers,
  loadedStocks,
  selectedPeriod,
  onPeriodChange,
  showTechnicalZones = false,
  tickerForTechnicals,
}: PriceChartProps) {
  const { isAdmin } = useAuth();
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

  const { historyByTicker, yAxes, hasRightAxis, hasAnyData } = useMemo(() => {
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

    const validStocks = loadedStocks.filter(s => tickers.includes(s.ticker) && s.currentPrice !== undefined);
    const axes = assignYAxes(validStocks);
    const hasRight = Object.values(axes).includes("right");
    const hasAny = tickers.some(t => (historyByTicker[t]?.length ?? 0) > 0);

    return { historyByTicker, yAxes: axes, hasRightAxis: hasRight, hasAnyData: hasAny };
  }, [tickers, queries, loadedStocks]);

  const zones = useMemo(() => {
    if (!showTechnicalZones || !techTicker) return [];
    const bars = historyByTicker[techTicker] ?? historyByTicker[tickers[0]] ?? [];
    return computeChartZones(bars, selectedPeriod, technicalsQuery.data ?? null);
  }, [showTechnicalZones, techTicker, historyByTicker, tickers, selectedPeriod, technicalsQuery.data]);

  /** Exact period low/high bar — always shown for the single-ticker view, independent of the technical-zones overlay. */
  const periodExtremaMarkers = useMemo((): LWMarker[] => {
    if (tickers.length !== 1) return [];
    const bars = historyByTicker[tickers[0]] ?? [];
    if (bars.length === 0) return [];
    let lowBar = bars[0];
    let highBar = bars[0];
    for (const b of bars) {
      if ((b.low ?? b.close) < (lowBar.low ?? lowBar.close)) lowBar = b;
      if ((b.high ?? b.close) > (highBar.high ?? highBar.close)) highBar = b;
    }
    return [
      { time: toUnixTime(lowBar.date), price: lowBar.low ?? lowBar.close, color: "#ef4444", text: "L" },
      { time: toUnixTime(highBar.date), price: highBar.high ?? highBar.close, color: "#22c55e", text: "H" },
    ];
  }, [tickers, historyByTicker]);

  const zoneMarkers = useMemo((): LWMarker[] => zones
    .filter(z => z.renderAs === "marker" && z.date)
    .map(z => ({
      time: toUnixTime(z.date!),
      price: z.price,
      color: z.kind === "support" ? "#f59e0b" : "#a78bfa",
      text: z.kind === "support" ? "SL" : "SH",
    })), [zones]);

  const zonePriceLines = useMemo((): LWPriceLine[] => zones
    .filter(z => z.renderAs === "line")
    .map(z => ({
      price: z.price,
      color: z.kind === "support" ? "#22c55e" : "#ef4444",
      title: z.label,
      dashed: z.label.startsWith("MA") || z.label.startsWith("BB"),
    })), [zones]);

  const allMarkers = useMemo(
    () => [...periodExtremaMarkers, ...zoneMarkers].sort((a, b) => a.time - b.time),
    [periodExtremaMarkers, zoneMarkers],
  );

  const emaSeries = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    const closes = bars.map(b => b.close);
    const ema50 = computeEMA(closes, 50);
    const ema200 = computeEMA(closes, 200);
    const toPoints = (values: (number | null)[]): LWPoint[] => values
      .map((v, i) => (v != null ? { time: toUnixTime(bars[i].date), value: v } : null))
      .filter((p): p is LWPoint => p !== null);
    const e50 = toPoints(ema50);
    const e200 = toPoints(ema200);
    if (e50.length === 0 && e200.length === 0) return null;
    return { ema50: e50, ema200: e200 };
  }, [showTechnicalZones, tickers, historyByTicker]);

  const chartSeries = useMemo((): LWSeriesSpec[] => tickers.map((ticker, i) => ({
    ticker,
    color: STOCK_COLORS[i % STOCK_COLORS.length],
    scaleId: yAxes[ticker] || "left",
    data: (historyByTicker[ticker] ?? []).map(b => ({ time: toUnixTime(b.date), value: b.close })),
  })).filter(s => s.data.length > 0), [tickers, historyByTicker, yAxes]);

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
          {isAdmin && showTechnicalZones && techTicker && (
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

      <div className="flex items-center gap-4 mb-3 flex-wrap">
        {tickers.length > 1 ? (
          chartSeries.map(s => (
            <div key={s.ticker} className="flex items-center gap-1.5 text-xs font-medium">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.ticker}
            </div>
          ))
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-[#ef4444]" /> Period low
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-[#22c55e]" /> Period high
            </div>
            {showTechnicalZones && zoneMarkers.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2 h-2 rounded-full bg-[#f59e0b]" /> Swing low
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2 h-2 rounded-full bg-[#a78bfa]" /> Swing high
                </div>
              </>
            )}
            {emaSeries && (
              <>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2.5 h-0.5 bg-[#eab308]" /> EMA 50
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2.5 h-0.5 bg-[#f59e0b]" /> EMA 200
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="h-[320px] w-full relative">
        {isLoading && !hasAnyData ? (
          <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10 rounded-lg border border-border/50">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !hasAnyData ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground border border-dashed border-border rounded-lg">
            No data available for this period.
          </div>
        ) : (
          <LightweightPriceChart
            series={chartSeries}
            hasRightAxis={hasRightAxis}
            period={selectedPeriod}
            emaSeries={emaSeries}
            markers={tickers.length === 1 ? allMarkers : undefined}
            priceLines={tickers.length === 1 && showTechnicalZones ? zonePriceLines : undefined}
          />
        )}
      </div>
    </div>
  );
}
