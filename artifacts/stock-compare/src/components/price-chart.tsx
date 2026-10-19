import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetStockHistoryQueryOptions, getGetStockHistoryQueryKey, StockMetrics } from "@workspace/api-client-react";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { STOCK_COLORS } from "./stock-cards";
import {
  createChart, createSeriesMarkers, LineSeries, CandlestickSeries, HistogramSeries,
  ColorType, LineStyle, CrosshairMode,
  type AutoscaleInfo, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type IPriceLine, type UTCTimestamp, type Time,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { computeChartZones, pfNum, type DbTechnicalLevels } from "@/lib/chart-levels";
import { detectBos, detectFvg, detectSupplyDemand, detectSweeps } from "@/lib/ict-detectors";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function LegendItem({ swatch, label, explanation }: { swatch: React.ReactNode; label: string; explanation: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-help decoration-dotted underline-offset-4 hover:underline">
          {swatch}
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-xs bg-card text-foreground border border-border p-2">
        {explanation}
      </TooltipContent>
    </Tooltip>
  );
}

export type Period = "1D" | "1W" | "1M" | "3M" | "1Y";

interface PriceChartProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  selectedPeriod: Period;
  onPeriodChange: (period: Period) => void;
  showTechnicalZones?: boolean;
  tickerForTechnicals?: string;
  /** Compact black/gold styling with no legend and short chart labels — used in the stock breakdown view. */
  compact?: boolean;
}

function assignYAxes(stocks: StockMetrics[]): Record<string, "left" | "right"> {
  if (stocks.length <= 1) return Object.fromEntries(stocks.map(s => [s.ticker, "left"]));
  const sorted = [...stocks].sort((a, b) => (a.currentPrice ?? 0) - (b.currentPrice ?? 0));
  const mid = Math.ceil(sorted.length / 2);
  const result: Record<string, "left" | "right"> = {};
  sorted.forEach((s, i) => { result[s.ticker] = i < mid ? "left" : "right"; });
  return result;
}

type HistoryBar = {
  date: string;
  close: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
};

type LWCandle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };
type LWVolume = { time: UTCTimestamp; value: number; color: string };

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
    ema = values[i]! * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function computeRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function computeMACD(closes: number[]): {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
} {
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const macd: (number | null)[] = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null,
  );
  const macdVals = macd.map((v) => v ?? 0);
  // Seed signal EMA only once MACD is defined — approximate with full-series EMA9 on macd vals.
  const signalRaw = computeEMA(
    macd.map((v, i) => (v != null ? v : macdVals[i]!)),
    9,
  );
  const signal: (number | null)[] = macd.map((v, i) => (v != null && signalRaw[i] != null ? signalRaw[i] : null));
  const hist: (number | null)[] = macd.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i]! : null,
  );
  return { macd, signal, hist };
}

type IndicatorId = "em" | "ema" | "rsi" | "macd" | "session" | "ict";

const INDICATOR_META: { id: IndicatorId; label: string; title: string; on: string }[] = [
  { id: "em", label: "EM", title: "±1σ expected-move bands from ATM IV (follow price)", on: "border-sky-400/50 bg-sky-400/15 text-sky-200" },
  { id: "ema", label: "EMA", title: "EMA 50 / 200 on price", on: "border-yellow-400/50 bg-yellow-400/15 text-yellow-200" },
  { id: "rsi", label: "RSI", title: "RSI(14) sub-pane", on: "border-violet-400/50 bg-violet-400/15 text-violet-200" },
  { id: "macd", label: "MACD", title: "MACD(12,26,9) sub-pane", on: "border-emerald-400/50 bg-emerald-400/15 text-emerald-200" },
  { id: "session", label: "Session", title: "Yahoo 5m session VWAP + POC/VAH/VAL", on: "border-pink-400/50 bg-pink-400/15 text-pink-200" },
  { id: "ict", label: "ICT", title: "FVG, sweeps, BOS, S&D (display only)", on: "border-cyan-400/50 bg-cyan-400/15 text-cyan-200" },
];

async function fetchTechnicals(ticker: string): Promise<DbTechnicalLevels | null> {
  const res = await fetch(`/api/technicals/${encodeURIComponent(ticker)}`, { credentials: "include" });
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
  /** Default true. False = TradingView-style bare line (no axis chip). */
  axisLabelVisible?: boolean;
}

interface LightweightPriceChartProps {
  series: LWSeriesSpec[];
  hasRightAxis: boolean;
  period: Period;
  emaSeries?: { ema50: LWPoint[]; ema200: LWPoint[] } | null;
  markers?: LWMarker[];
  priceLines?: LWPriceLine[];
  /** Extra line overlays (IV expected-move bands following price — A93). */
  overlays?: LWSeriesSpec[];
  /** A93/A126 — single-ticker candles + volume (+ optional session VWAP). */
  candles?: LWCandle[] | null;
  volumes?: LWVolume[] | null;
  vwap?: LWPoint[] | null;
  rsi?: LWPoint[] | null;
  macd?: { macd: LWPoint[]; signal: LWPoint[]; hist: LWVolume[] } | null;
}

function formatTickTime(time: Time, period: Period): string {
  const ms = (time as number) * 1000;
  const d = new Date(ms);
  if (period === "1D") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // 1W/1M use hourly bars — day label is enough on the axis
  if (period === "1W" || period === "1M") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${yy}`;
}

function formatTooltipTime(time: Time, period: Period): string {
  const ms = (time as number) * 1000;
  const d = new Date(ms);
  if (period === "1D" || period === "1W" || period === "1M") {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Imperative lightweight-charts canvas — created once and updated in place, rather than re-mounted on every render. */
function LightweightPriceChart({ series, hasRightAxis, period, emaSeries, markers, priceLines, overlays, candles, volumes, vwap, rsi, macd }: LightweightPriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const overlayMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSeriesRef = useRef<{ ema50: ISeriesApi<"Line"> | null; ema200: ISeriesApi<"Line"> | null }>({ ema50: null, ema200: null });
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdRefs = useRef<{
    line: ISeriesApi<"Line"> | null;
    signal: ISeriesApi<"Line"> | null;
    hist: ISeriesApi<"Histogram"> | null;
    paneIndex: number | null;
  }>({ line: null, signal: null, hist: null, paneIndex: null });
  const rsiPaneIndexRef = useRef<number | null>(null);
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineHandlesRef = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<LWCandle[] | null>(null);
  candlesRef.current = candles ?? null;
  /** Fit zoom only when tickers or period change — refetches must not wipe the user's pan/zoom (A93). */
  const viewKeyRef = useRef<string>("");
  const primarySeries = (): ISeriesApi<"Line"> | ISeriesApi<"Candlestick"> | null =>
    candleRef.current ?? seriesMapRef.current.get(series[0]?.ticker ?? "") ?? null;

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
      overlayMapRef.current.clear();
      candleRef.current = null;
      volumeRef.current = null;
      vwapRef.current = null;
      emaSeriesRef.current = { ema50: null, ema200: null };
      rsiRef.current = null;
      rsiPaneIndexRef.current = null;
      macdRefs.current = { line: null, signal: null, hist: null, paneIndex: null };
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
    const useCandles = !!(candles && candles.length > 0);
    const viewKey = `${useCandles ? "c" : "l"}|${series.map(s => s.ticker).join(",")}|${period}`;
    const viewChanged = viewKeyRef.current !== viewKey;
    viewKeyRef.current = viewKey;
    const ts = chart.timeScale();
    const savedRange = viewChanged ? null : ts.getVisibleLogicalRange();

    if (useCandles) {
      seriesMapRef.current.forEach((s) => { chart.removeSeries(s); });
      seriesMapRef.current.clear();
      if (!candleRef.current) {
        candleRef.current = chart.addSeries(CandlestickSeries, {
          upColor: "#22c55e",
          downColor: "#ef4444",
          borderUpColor: "#22c55e",
          borderDownColor: "#ef4444",
          wickUpColor: "#22c55e",
          wickDownColor: "#ef4444",
          lastValueVisible: true,
          priceLineVisible: true,
          // Scale to candle OHLC only — overlays / EM bands must not squash the range.
          autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
            const res = original();
            const bars = candlesRef.current;
            if (!res?.priceRange || !bars?.length) return res;
            let min = Infinity;
            let max = -Infinity;
            for (const c of bars) {
              if (c.low < min) min = c.low;
              if (c.high > max) max = c.high;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max)) return res;
            const pad = Math.max((max - min) * 0.06, max * 0.002);
            return {
              priceRange: { minValue: min - pad, maxValue: max + pad },
              margins: res.margins,
            };
          },
        });
      }
      candleRef.current.setData(candles!);
      chart.priceScale("left").applyOptions({
        autoScale: true,
        scaleMargins: { top: 0.05, bottom: volumes?.length ? 0.22 : 0.05 },
      });
    } else {
      if (candleRef.current) {
        chart.removeSeries(candleRef.current);
        candleRef.current = null;
      }
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
      chart.priceScale("left").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
    }

    if (volumes && volumes.length > 0) {
      if (!volumeRef.current) {
        volumeRef.current = chart.addSeries(HistogramSeries, {
          priceScaleId: "vol",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        chart.priceScale("vol").applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
          borderVisible: false,
        });
      }
      volumeRef.current.setData(volumes);
    } else if (volumeRef.current) {
      chart.removeSeries(volumeRef.current);
      volumeRef.current = null;
    }

    if (vwap && vwap.length > 0) {
      if (!vwapRef.current) {
        vwapRef.current = chart.addSeries(LineSeries, {
          color: "#f472b6",
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
      }
      vwapRef.current.setData(vwap);
    } else if (vwapRef.current) {
      chart.removeSeries(vwapRef.current);
      vwapRef.current = null;
    }

    if (viewChanged || savedRange == null) {
      ts.fitContent();
      // Re-enable Y auto-scale after period change (user drag locks the scale otherwise).
      chart.priceScale("left").applyOptions({ autoScale: true });
    } else {
      ts.setVisibleLogicalRange(savedRange);
    }
  }, [series, period, candles, volumes, vwap]);

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
    const primary = primarySeries();
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
  }, [markers, series, candles]);

  useEffect(() => {
    const primary = primarySeries();
    priceLineHandlesRef.current.forEach(h => primary?.removePriceLine(h));
    priceLineHandlesRef.current = [];
    if (!primary || !priceLines) return;
    priceLineHandlesRef.current = priceLines.map(pl => primary.createPriceLine({
      price: pl.price,
      color: pl.color,
      lineWidth: 1,
      lineStyle: pl.dashed ? LineStyle.Dashed : LineStyle.Solid,
      axisLabelVisible: pl.axisLabelVisible !== false,
      title: pl.title,
    }));
  }, [priceLines, series, candles]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wanted = new Set((overlays ?? []).map(o => o.ticker));
    overlayMapRef.current.forEach((s, id) => {
      if (!wanted.has(id)) {
        chart.removeSeries(s);
        overlayMapRef.current.delete(id);
      }
    });
    for (const spec of overlays ?? []) {
      let s = overlayMapRef.current.get(spec.ticker);
      if (!s) {
        s = chart.addSeries(LineSeries, {
          color: spec.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          priceScaleId: "left",
          // Don't let EM bands expand the Y scale.
          autoscaleInfoProvider: () => ({ priceRange: null }),
        });
        overlayMapRef.current.set(spec.ticker, s);
      }
      s.setData(spec.data);
    }
  }, [overlays]);

  // RSI + MACD sub-panes — rebuild together so pane indexes stay consistent.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const clearRsi = () => {
      if (rsiRef.current) {
        chart.removeSeries(rsiRef.current);
        rsiRef.current = null;
      }
      if (rsiPaneIndexRef.current != null) {
        try { chart.removePane(rsiPaneIndexRef.current); } catch { /* gone */ }
        rsiPaneIndexRef.current = null;
      }
    };
    const clearMacd = () => {
      const m = macdRefs.current;
      if (m.line) { chart.removeSeries(m.line); m.line = null; }
      if (m.signal) { chart.removeSeries(m.signal); m.signal = null; }
      if (m.hist) { chart.removeSeries(m.hist); m.hist = null; }
      if (m.paneIndex != null) {
        try { chart.removePane(m.paneIndex); } catch { /* gone */ }
        m.paneIndex = null;
      }
    };

    // Tear down then rebuild in order (RSI pane, then MACD pane).
    clearMacd();
    clearRsi();

    if (rsi && rsi.length > 0) {
      const pane = chart.addPane(true);
      rsiPaneIndexRef.current = pane.paneIndex();
      pane.setHeight(72);
      rsiRef.current = chart.addSeries(LineSeries, {
        color: "#a78bfa",
        lineWidth: 1,
        lastValueVisible: true,
        priceLineVisible: false,
        priceFormat: { type: "price", precision: 1, minMove: 0.1 },
      }, rsiPaneIndexRef.current);
      try {
        chart.priceScale("right", rsiPaneIndexRef.current).applyOptions({
          scaleMargins: { top: 0.1, bottom: 0.1 },
          borderVisible: false,
        });
      } catch { /* scale id varies by pane */ }
      rsiRef.current.setData(rsi);
    }

    if (macd && macd.macd.length > 0) {
      const pane = chart.addPane(true);
      const idx = pane.paneIndex();
      pane.setHeight(80);
      macdRefs.current.paneIndex = idx;
      macdRefs.current.hist = chart.addSeries(HistogramSeries, {
        priceScaleId: "macd",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: { type: "price", precision: 3, minMove: 0.001 },
      }, idx);
      macdRefs.current.line = chart.addSeries(LineSeries, {
        color: "#38bdf8",
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        priceScaleId: "macd",
      }, idx);
      macdRefs.current.signal = chart.addSeries(LineSeries, {
        color: "#fbbf24",
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        priceScaleId: "macd",
      }, idx);
      try {
        chart.priceScale("macd", idx).applyOptions({
          scaleMargins: { top: 0.1, bottom: 0.05 },
          borderVisible: false,
        });
      } catch { /* ok */ }
      macdRefs.current.hist!.setData(macd.hist);
      macdRefs.current.line!.setData(macd.macd);
      macdRefs.current.signal!.setData(macd.signal);
    }
  }, [rsi, macd]);

  return (
    <div className="relative w-full h-full" data-lenis-prevent>
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
  compact = false,
}: PriceChartProps) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  /** Clickable indicator tags — EM/EMA on by default for technical chart. */
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorId>>(
    () => new Set<IndicatorId>(["em", "ema"]),
  );
  const toggleIndicator = useCallback((id: IndicatorId) => {
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const showSessionFlow = activeIndicators.has("session");
  const showIct = activeIndicators.has("ict");
  const showEm = activeIndicators.has("em");
  const showEma = activeIndicators.has("ema");
  const showRsi = activeIndicators.has("rsi");
  const showMacd = activeIndicators.has("macd");
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

  /** Open short puts for this ticker — strike lines next to IV band (A93). */
  const sessionFlowQuery = useQuery({
    queryKey: ["session-flow", techTicker],
    queryFn: async () => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(techTicker!)}/session-flow`, { credentials: "include" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`session-flow ${r.status}`);
      return r.json() as Promise<{
        sessionDate: string;
        vwap: { time: number; value: number }[];
        poc: number | null;
        vah: number | null;
        val: number | null;
        note: string;
      }>;
    },
    enabled: !!techTicker && showTechnicalZones && showSessionFlow && tickers.length === 1,
    staleTime: 5 * 60_000,
  });

  const shortPutsQuery = useQuery({
    queryKey: ["pm-odds"],
    queryFn: async (): Promise<{ positions: { ticker: string; strike: number; expiry: string; account: string }[] }> => {
      const r = await fetch("/api/pm/odds", { credentials: "include" });
      if (!r.ok) return { positions: [] };
      return r.json();
    },
    enabled: !!isAdmin && !!techTicker && tickers.length === 1,
    staleTime: 5 * 60_000,
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
          open: p.open,
          high: p.high,
          low: p.low,
          volume: p.volume,
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
      { time: toUnixTime(lowBar.date), price: lowBar.low ?? lowBar.close, color: "#ef4444", text: compact ? "L" : "Period Low" },
      { time: toUnixTime(highBar.date), price: highBar.high ?? highBar.close, color: "#22c55e", text: compact ? "H" : "Period High" },
    ];
  }, [tickers, historyByTicker, compact]);

  const zoneMarkers = useMemo((): LWMarker[] => zones
    .filter(z => z.renderAs === "marker" && z.date)
    .map(z => {
      let text: string;
      if (z.label.startsWith("Pivot")) {
        text = compact ? (z.label.includes("S1") ? "S1" : z.label.includes("R1") ? "R1" : "P") : z.label;
      } else if (z.kind === "support") {
        text = compact ? "SL" : "Swing Low";
      } else {
        text = compact ? "SH" : "Swing High";
      }
      const color = z.label.startsWith("Pivot")
        ? (z.kind === "support" ? "#22c55e" : "#ef4444")
        : (z.kind === "support" ? "#f59e0b" : "#a78bfa");
      return { time: toUnixTime(z.date!), price: z.price, color, text };
    }), [zones, compact]);

  const zonePriceLines = useMemo((): LWPriceLine[] => zones
    .filter(z => z.renderAs === "line")
    .map(z => ({
      price: z.price,
      color: z.kind === "support" ? "#22c55e" : "#ef4444",
      title: z.label,
      dashed: z.label.startsWith("MA") || z.label.startsWith("BB"),
    })), [zones]);

  /** A93 — ±1σ expected-move bands from ATM IV, tracked along each bar (wavy, not flat). */
  const ivBand = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    if (bars.length === 0) return null;
    const spot = bars[bars.length - 1]!.close;
    const tech = technicalsQuery.data;
    const ivPct = pfNum(tech?.atmPutIv);
    const weekFrac = pfNum(tech?.impliedMoveWeekly);
    const emWeek = weekFrac != null && weekFrac > 0
      ? spot * weekFrac
      : ivPct != null && ivPct > 0
        ? spot * (ivPct / 100) * Math.sqrt(7 / 365)
        : null;
    const em30 = ivPct != null && ivPct > 0
      ? spot * (ivPct / 100) * Math.sqrt(30 / 365)
      : null;
    if (emWeek == null && em30 == null) return null;
    const overlays: LWSeriesSpec[] = [];
    const band = (half: number, id: string, color: string) => {
      const up: LWPoint[] = [];
      const dn: LWPoint[] = [];
      for (const b of bars) {
        const t = toUnixTime(b.date);
        up.push({ time: t, value: b.close + half });
        dn.push({ time: t, value: b.close - half });
      }
      overlays.push(
        { ticker: `${id}+`, color, scaleId: "left", data: up },
        { ticker: `${id}-`, color, scaleId: "left", data: dn },
      );
    };
    if (emWeek != null) band(emWeek, "_em_w", "rgba(56,189,248,0.65)");
    if (em30 != null) band(em30, "_em_30", "rgba(167,139,250,0.5)");
    return { overlays, emWeek, em30 };
  }, [showTechnicalZones, tickers, historyByTicker, technicalsQuery.data]);

  const shortStrikeLines = useMemo((): LWPriceLine[] => {
    if (!techTicker || !shortPutsQuery.data?.positions) return [];
    return shortPutsQuery.data.positions
      .filter(p => p.ticker.toUpperCase() === techTicker)
      .map(p => ({
        price: p.strike,
        color: "#d4af37",
        title: `${p.strike}P ${p.expiry.slice(5)}`,
        dashed: false,
      }));
  }, [techTicker, shortPutsQuery.data]);

  const sessionFlowLines = useMemo((): LWPriceLine[] => {
    if (!showSessionFlow || !sessionFlowQuery.data) return [];
    const d = sessionFlowQuery.data;
    const lines: LWPriceLine[] = [];
    const lastVwap = d.vwap.length ? d.vwap[d.vwap.length - 1]!.value : null;
    if (lastVwap != null) lines.push({ price: lastVwap, color: "#f472b6", title: `VWAP ${d.sessionDate.slice(5)}`, dashed: false });
    if (d.poc != null) lines.push({ price: d.poc, color: "#fbbf24", title: "POC", dashed: true });
    if (d.vah != null) lines.push({ price: d.vah, color: "#a78bfa", title: "VAH", dashed: true });
    if (d.val != null) lines.push({ price: d.val, color: "#a78bfa", title: "VAL", dashed: true });
    return lines;
  }, [showSessionFlow, sessionFlowQuery.data]);


  const ictMarkers = useMemo((): LWMarker[] => {
    if (!showIct || !showTechnicalZones || tickers.length !== 1) return [];
    const bars = historyByTicker[tickers[0]] ?? [];
    const sweeps = detectSweeps(bars).map((s) => ({
      time: toUnixTime(s.date),
      price: s.price,
      color: s.side === "bull" ? "#38bdf8" : "#fb7185",
      text: s.side === "bull" ? "Sw↑" : "Sw↓",
    }));
    const bos = detectBos(bars).map((b) => ({
      time: toUnixTime(b.date),
      price: b.price,
      color: b.side === "bull" ? "#4ade80" : "#f87171",
      text: b.side === "bull" ? "BOS↑" : "BOS↓",
    }));
    return [...sweeps, ...bos];
  }, [showIct, showTechnicalZones, tickers, historyByTicker]);

  const ictPriceLines = useMemo((): LWPriceLine[] => {
    if (!showIct || !showTechnicalZones || tickers.length !== 1) return [];
    const bars = historyByTicker[tickers[0]] ?? [];
    const fvg = detectFvg(bars).slice(-6).map((f) => ({
      price: (f.top + f.bottom) / 2,
      color: f.side === "bull" ? "#22d3ee88" : "#f472b688",
      title: f.side === "bull" ? `FVGb ${f.date.slice(5)}` : `FVGs ${f.date.slice(5)}`,
      dashed: true,
    }));
    const zones = detectSupplyDemand(bars).map((z) => ({
      price: (z.top + z.bottom) / 2,
      color: z.side === "demand" ? "#86efac99" : "#fda4af99",
      title: z.side === "demand" ? `Dem ${z.date.slice(5)}` : `Sup ${z.date.slice(5)}`,
      dashed: true,
    }));
    return [...fvg, ...zones];
  }, [showIct, showTechnicalZones, tickers, historyByTicker]);

  
  // A139 — log overlay fire counts (≥5/month expected; under = decoration).
  useEffect(() => {
    if (!showIct || !showTechnicalZones || tickers.length !== 1) return;
    const bars = historyByTicker[tickers[0]] ?? [];
    const fvg = detectFvg(bars).length;
    const sweeps = detectSweeps(bars).length;
    const bos = detectBos(bars).length;
    const sd = detectSupplyDemand(bars).length;
    console.info("[ict-fire-count]", { ticker: tickers[0], fvg, sweeps, bos, supplyDemand: sd, bars: bars.length });
  }, [showIct, showTechnicalZones, tickers, historyByTicker]);

  const allPriceLines = useMemo((): LWPriceLine[] => {
    if (!showTechnicalZones || tickers.length !== 1) return [];
    // EM is wavy overlays only — never priceLines (those expand Y and flatten candles).
    return [...zonePriceLines, ...shortStrikeLines, ...sessionFlowLines, ...ictPriceLines];
  }, [showTechnicalZones, tickers.length, zonePriceLines, shortStrikeLines, sessionFlowLines, ictPriceLines]);

  const solidZoneLines = useMemo(() => zonePriceLines.filter(z => !z.dashed), [zonePriceLines]);
  const dashedZoneLines = useMemo(() => zonePriceLines.filter(z => z.dashed), [zonePriceLines]);

  const allMarkers = useMemo(
    () => [...periodExtremaMarkers, ...zoneMarkers, ...ictMarkers].sort((a, b) => a.time - b.time),
    [periodExtremaMarkers, zoneMarkers, ictMarkers],
  );

  const emaSeries = useMemo(() => {
    if (!showTechnicalZones || !showEma || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    const closes = bars.map(b => b.close);
    const ema50 = computeEMA(closes, 50);
    const ema200 = computeEMA(closes, 200);
    const toPoints = (values: (number | null)[]): LWPoint[] => values
      .map((v, i) => (v != null ? { time: toUnixTime(bars[i]!.date), value: v } : null))
      .filter((p): p is LWPoint => p !== null);
    const e50 = toPoints(ema50);
    const e200 = toPoints(ema200);
    if (e50.length === 0 && e200.length === 0) return null;
    return { ema50: e50, ema200: e200 };
  }, [showTechnicalZones, showEma, tickers, historyByTicker]);

  const rsiSeries = useMemo((): LWPoint[] | null => {
    if (!showTechnicalZones || !showRsi || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    if (bars.length < 16) return null;
    const vals = computeRSI(bars.map((b) => b.close), 14);
    const pts: LWPoint[] = [];
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] != null) pts.push({ time: toUnixTime(bars[i]!.date), value: vals[i]! });
    }
    return pts.length > 0 ? pts : null;
  }, [showTechnicalZones, showRsi, tickers, historyByTicker]);

  const macdSeries = useMemo(() => {
    if (!showTechnicalZones || !showMacd || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    if (bars.length < 35) return null;
    const { macd, signal, hist } = computeMACD(bars.map((b) => b.close));
    const macdPts: LWPoint[] = [];
    const signalPts: LWPoint[] = [];
    const histPts: LWVolume[] = [];
    for (let i = 0; i < bars.length; i++) {
      const t = toUnixTime(bars[i]!.date);
      if (macd[i] != null) macdPts.push({ time: t, value: macd[i]! });
      if (signal[i] != null) signalPts.push({ time: t, value: signal[i]! });
      if (hist[i] != null) {
        histPts.push({
          time: t,
          value: hist[i]!,
          color: hist[i]! >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
        });
      }
    }
    if (macdPts.length === 0) return null;
    return { macd: macdPts, signal: signalPts, hist: histPts };
  }, [showTechnicalZones, showMacd, tickers, historyByTicker]);

  const chartSeries = useMemo((): LWSeriesSpec[] => tickers.map((ticker, i) => ({
    ticker,
    color: compact ? "#d4af37" : STOCK_COLORS[i % STOCK_COLORS.length],
    scaleId: yAxes[ticker] || "left",
    data: (historyByTicker[ticker] ?? []).map(b => ({ time: toUnixTime(b.date), value: b.close })),
  })).filter(s => s.data.length > 0), [tickers, historyByTicker, yAxes, compact]);

  /** A93 candles + A126 volume histogram; session VWAP on 1D when volume present. */
  const ohlcv = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) {
      return { candles: null as LWCandle[] | null, volumes: null as LWVolume[] | null, vwap: null as LWPoint[] | null };
    }
    const bars = historyByTicker[tickers[0]] ?? [];
    const candles: LWCandle[] = [];
    const volumes: LWVolume[] = [];
    let cumPV = 0;
    let cumV = 0;
    const vwapPts: LWPoint[] = [];
    for (const b of bars) {
      const t = toUnixTime(b.date);
      const o = b.open ?? b.close;
      const h = b.high ?? Math.max(o, b.close);
      const l = b.low ?? Math.min(o, b.close);
      candles.push({ time: t, open: o, high: h, low: l, close: b.close });
      if (b.volume != null && b.volume > 0) {
        volumes.push({
          time: t,
          value: b.volume,
          color: b.close >= o ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
        });
        if (selectedPeriod === "1D") {
          const typical = (h + l + b.close) / 3;
          cumPV += typical * b.volume;
          cumV += b.volume;
          if (cumV > 0) vwapPts.push({ time: t, value: cumPV / cumV });
        }
      }
    }
    return {
      candles: candles.length > 0 ? candles : null,
      volumes: volumes.length > 0 ? volumes : null,
      vwap: vwapPts.length > 1 ? vwapPts : null,
    };
  }, [showTechnicalZones, tickers, historyByTicker, selectedPeriod]);

  const handleRefresh = useCallback(async () => {
    if (!techTicker) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/technicals/refresh/${encodeURIComponent(techTicker)}`, { method: "POST", credentials: "include" });
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
    <div
      data-lenis-prevent
      className={compact
      ? "bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-3 h-full flex flex-col"
      : "bg-card border border-border rounded-xl p-4 shadow-sm mb-4"}
    >
      <div className={cn("flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4", compact ? "mb-2" : "mb-6")}>
        <div className="flex items-center gap-3">
          <h2 className={compact ? "text-[11px] font-bold tracking-tight text-[#d4af37]" : "text-lg font-bold tracking-tight"}>
            Price History
          </h2>
          {isError && (
            <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 px-2.5 py-1 rounded-full font-medium">
              <AlertCircle className="w-3.5 h-3.5" />
              Some data unavailable
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showTechnicalZones && techTicker && tickers.length === 1 && (
            <div className="flex flex-wrap items-center gap-1">
              {INDICATOR_META.map((ind) => {
                const on = activeIndicators.has(ind.id);
                const busy = ind.id === "session" && sessionFlowQuery.isFetching;
                return (
                  <button
                    key={ind.id}
                    type="button"
                    onClick={() => toggleIndicator(ind.id)}
                    className={cn(
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded border transition-colors",
                      on ? ind.on : "border-[#d4af37]/25 text-amber-200/70 hover:text-amber-100",
                    )}
                    title={ind.title}
                  >
                    {ind.label}{busy ? "…" : ""}
                  </button>
                );
              })}
            </div>
          )}
          {isAdmin && showTechnicalZones && techTicker && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh support/resistance levels"
              className={cn(
                "flex items-center gap-1 rounded-md border font-medium disabled:opacity-50",
                compact
                  ? "px-1.5 py-1 text-[10px] border-[#d4af37]/20 text-amber-200/60 hover:text-[#d4af37] hover:bg-[#d4af37]/10"
                  : "px-2 py-1.5 text-xs border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/60",
              )}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
              Levels
            </button>
          )}
          <div className={cn("flex items-center rounded-lg", compact ? "bg-black border border-[#d4af37]/20 p-0.5" : "bg-secondary/60 p-1 border border-border/50")}>
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "font-bold rounded-md transition-colors",
                  compact ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-xs",
                  selectedPeriod === p
                    ? compact ? "bg-[#d4af37] text-black shadow-sm" : "bg-primary text-primary-foreground shadow-sm"
                    : compact ? "text-amber-200/50 hover:text-[#d4af37] hover:bg-[#d4af37]/10" : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {compact && showEm && ivBand && (
        <div className="mb-1.5 flex items-center gap-3 text-[9px] font-medium text-amber-200/70">
          {ivBand.emWeek != null && (
            <span className="inline-flex items-center gap-1">
              <span className="h-px w-3 border-t border-dashed border-sky-400" />
              1w EM
            </span>
          )}
          {ivBand.em30 != null && (
            <span className="inline-flex items-center gap-1">
              <span className="h-px w-3 border-t border-dashed border-violet-400" />
              30d EM
            </span>
          )}
        </div>
      )}

      {!compact && <div className="flex items-center gap-4 mb-3 flex-wrap">
        {tickers.length > 1 ? (
          chartSeries.map(s => (
            <div key={s.ticker} className="flex items-center gap-1.5 text-xs font-medium">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.ticker}
            </div>
          ))
        ) : (
          <>
            <LegendItem
              swatch={<span className="w-2 h-2 rounded-full bg-[#ef4444]" />}
              label="Period low"
              explanation="The lowest traded price within the selected time window."
            />
            <LegendItem
              swatch={<span className="w-2 h-2 rounded-full bg-[#22c55e]" />}
              label="Period high"
              explanation="The highest traded price within the selected time window."
            />
            {showTechnicalZones && zoneMarkers.length > 0 && (
              <>
                <LegendItem
                  swatch={<span className="w-2 h-2 rounded-full bg-[#f59e0b]" />}
                  label="Swing low"
                  explanation="A local reversal low the price bounced from — used to derive support levels below the current price."
                />
                <LegendItem
                  swatch={<span className="w-2 h-2 rounded-full bg-[#a78bfa]" />}
                  label="Swing high"
                  explanation="A local reversal high the price pulled back from — used to derive resistance levels above the current price."
                />
              </>
            )}
            {emaSeries && (
              <>
                <LegendItem
                  swatch={<span className="w-2.5 h-0.5 bg-[#eab308]" />}
                  label="EMA 50"
                  explanation="50-period exponential moving average — a fast trend line; price crossing it often signals a short-term trend shift."
                />
                <LegendItem
                  swatch={<span className="w-2.5 h-0.5 bg-[#f59e0b]" />}
                  label="EMA 200"
                  explanation="200-period exponential moving average — the long-term trend line; price above it is broadly bullish, below is broadly bearish."
                />
              </>
            )}
            {showTechnicalZones && solidZoneLines.length > 0 && (
              <>
                {solidZoneLines.some(z => z.color === "#22c55e") && (
                  <LegendItem
                    swatch={<span className="w-2.5 h-0.5 bg-[#22c55e]" />}
                    label="Support level"
                    explanation="A horizontal price zone where buying has previously stepped in — a level the price has bounced off before."
                  />
                )}
                {solidZoneLines.some(z => z.color === "#ef4444") && (
                  <LegendItem
                    swatch={<span className="w-2.5 h-0.5 bg-[#ef4444]" />}
                    label="Resistance level"
                    explanation="A horizontal price zone where selling has previously capped gains — a level the price has pulled back from before."
                  />
                )}
              </>
            )}
            {showTechnicalZones && dashedZoneLines.length > 0 && (
              <LegendItem
                swatch={<span className="w-2.5 h-0.5 border-t-2 border-dashed border-[#a78bfa]" />}
                label="MA / Bollinger Band"
                explanation="Dashed lines are moving-average or Bollinger Band levels the price is testing — these act as dynamic (moving) support/resistance rather than a fixed price."
              />
            )}
            {ivBand && (
              <LegendItem
                swatch={<span className="w-2.5 h-0.5 border-t-2 border-dashed border-sky-400" />}
                label="IV expected move"
                explanation="±1σ band from ATM put IV: 1-week (cyan) and ~30-day (violet). Market-implied range to those horizons — not a forecast."
              />
            )}
            {shortStrikeLines.length > 0 && (
              <LegendItem
                swatch={<span className="w-2.5 h-0.5 bg-[#d4af37]" />}
                label="Your short put"
                explanation="Open short-put strikes from your book — compare them to the IV band."
              />
            )}
            {ohlcv.volumes && (
              <LegendItem
                swatch={<span className="w-2 h-2 rounded-sm bg-emerald-500/50" />}
                label="Volume"
                explanation="Per-bar volume under the price pane (green up / red down)."
              />
            )}
            {ohlcv.vwap && (
              <LegendItem
                swatch={<span className="w-2.5 h-0.5 bg-pink-400" />}
                label="Session VWAP"
                explanation="Volume-weighted average price for the current 1D session (typical price × volume)."
              />
            )}
            {showSessionFlow && sessionFlowLines.length > 0 && (
              <LegendItem
                swatch={<span className="w-2.5 h-0.5 bg-pink-400" />}
                label="Session flow (5m)"
                explanation={sessionFlowQuery.data?.note
                  ?? "Yahoo 5m RTH: last VWAP + POC/VAH/VAL from volume profile. Not true order-flow footprint."}
              />
            )}
          </>
        )}
      </div>}

      <div className={cn(
        "w-full relative",
        compact
          ? (showRsi || showMacd ? "flex-1 min-h-[320px]" : "flex-1 min-h-[220px]")
          : (showRsi || showMacd ? "h-[420px]" : "h-[320px]"),
      )}>
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
            series={ohlcv.candles ? [] : chartSeries}
            hasRightAxis={ohlcv.candles ? false : hasRightAxis}
            period={selectedPeriod}
            emaSeries={emaSeries}
            markers={tickers.length === 1 ? allMarkers : undefined}
            priceLines={tickers.length === 1 && showTechnicalZones ? allPriceLines : undefined}
            overlays={tickers.length === 1 && showTechnicalZones && showEm ? ivBand?.overlays : undefined}
            candles={ohlcv.candles}
            volumes={ohlcv.volumes}
            vwap={ohlcv.vwap}
            rsi={rsiSeries}
            macd={macdSeries}
          />
        )}
      </div>
    </div>
  );
}
