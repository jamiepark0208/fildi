import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { StockMetrics } from "@workspace/api-client-react";
import { Loader2, AlertCircle, RefreshCw, Settings } from "lucide-react";
import { sessionOpenMs } from "@/components/live/regime-session-chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STOCK_COLORS } from "./stock-cards";
import { IndicatorMenu } from "@/components/charts/indicator-menu";
import { getDefaultIndicators } from "@/lib/indicator-defaults";
import { TvIndicatorLayer, type LayerItem } from "@/components/charts/tv-indicator-layer";
import { TV_INDICATORS, type TvBar, type TvIndicatorId } from "@workspace/indicators";
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
        <div className="flex items-center gap-1.5 text-xs text-amber-100 cursor-help decoration-dotted underline-offset-4 hover:underline">
          {swatch}
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs bg-zinc-950 text-amber-50 border border-[#d4af37]/40 p-2 leading-snug">
        {explanation}
      </TooltipContent>
    </Tooltip>
  );
}

export type Period = "1D" | "1W" | "1M" | "3M" | "1Y";

/** A331 Backtest Lab — extra markers on trade/signal dates (merged after zone markers). */
export type ChartMarkerInput = {
  date: string;
  price?: number;
  text?: string;
  detail?: string;
  color?: string;
};

interface PriceChartProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  selectedPeriod: Period;
  onPeriodChange: (period: Period) => void;
  showTechnicalZones?: boolean;
  tickerForTechnicals?: string;
  /** Compact black/gold styling with no legend and short chart labels — used in the stock breakdown view. */
  compact?: boolean;
  extraMarkers?: ChartMarkerInput[];
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

const BAR_CHOICES: Record<Period, string[]> = {
  "1D": ["1m", "5m", "15m"],
  "1W": ["15m", "30m", "1h"],
  "1M": ["1h", "1d"],
  "3M": ["1d"],
  "1Y": ["1d"],
};

function defaultBar(period: Period): string {
  if (period === "1D") return "5m";
  if (period === "1W" || period === "1M") return "1h";
  return "1d";
}

function toUnixTime(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr).getTime() / 1000) as UTCTimestamp;
}

/** US equity session clock — never browser-local (UTC/PT machines misread as “future ET”). */
const ET = "America/New_York";
const PT = "America/Los_Angeles";

function formatEtTime(d: Date, withDate: boolean): string {
  const time = d.toLocaleTimeString("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
  });
  if (!withDate) return `${time} ET`;
  const md = d.toLocaleDateString("en-US", { timeZone: ET, month: "numeric", day: "numeric" });
  return `${md} ${time} ET`;
}

/** Drop bars stamped after “now” (forming Yahoo bar / clock skew). */
function notFutureBar(dateStr: string, slackMs = 120_000): boolean {
  const t = new Date(dateStr).getTime();
  return Number.isFinite(t) && t <= Date.now() + slackMs;
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

/** RSI / MACD keep this chart's own sub-pane code; the rest come from the shared TradingView ports. */
type TvExtraId = Exclude<TvIndicatorId, "rsi" | "macd">;
type IndicatorId = "em" | "ema" | "rsi" | "macd" | "session" | "ict" | TvExtraId;

const INDICATOR_META: { id: IndicatorId; label: string; title: string; on: string }[] = [
  { id: "em", label: "EM", title: "IV expected move: ±1σ corridor around each close (1-week sky, 30-day violet). Width from today’s ATM put IV — not a moving average.", on: "border-sky-400/70 bg-zinc-900 text-white" },
  { id: "ema", label: "EMA", title: "EMA 50 (yellow dash) + EMA 200 (orange). Trend filters — not expected move.", on: "border-yellow-400/70 bg-zinc-900 text-white" },
  { id: "rsi", label: "RSI", title: "RSI(14) momentum in a sub-pane (0–100).", on: "border-violet-400/70 bg-zinc-900 text-white" },
  { id: "macd", label: "MACD", title: "MACD(12,26,9) line / signal / histogram sub-pane.", on: "border-emerald-400/70 bg-zinc-900 text-white" },
  { id: "session", label: "Session", title: "Today’s VWAP + volume-profile POC / VAH / VAL (5m).", on: "border-pink-400/70 bg-zinc-900 text-white" },
  { id: "ict", label: "ICT", title: "Fair-value gaps, liquidity sweeps, BOS, supply/demand (display only).", on: "border-cyan-400/70 bg-zinc-900 text-white" },
  ...TV_INDICATORS.filter((x) => x.id !== "rsi" && x.id !== "macd")
    .map((x) => ({ id: x.id as IndicatorId, label: x.label, title: x.title, on: "border-[#d4af37]/70 bg-zinc-900 text-white" })),
];

/** Marker abbreviations → hover copy */
const MARKER_HELP: Record<string, string> = {
  L: "Period low — lowest low in this timeframe window",
  H: "Period high — highest high in this timeframe window",
  SL: "Swing low — local reversal low (support candidate)",
  SH: "Swing high — local reversal high (resistance candidate)",
  S1: "Pivot S1 — classic floor-trader support from prior H/L/C",
  R1: "Pivot R1 — classic floor-trader resistance from prior H/L/C",
  P: "Pivot point — (H+L+C)/3 of prior session/bar set",
};

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
  /** Longer hover description (compact charts use short `text`). */
  detail?: string;
}

interface LWPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  /** Default true. False = TradingView-style bare line (no axis chip). */
  axisLabelVisible?: boolean;
}

/** Live readout for the legend row (no floating tooltip). */
export type ChartHover = {
  timeLabel: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  chgPct?: number;
  vol?: string;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  mark?: string;
};

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
  /** Shared TradingView indicator results (UT/SuperTrend/Ichimoku/LSH/Squeeze/MSO), aligned to the candle times. */
  tvInd?: { items: LayerItem[]; times: number[]; stepSec: number } | null;
  onHover?: (h: ChartHover | null) => void;
}

function formatTickTime(time: Time, period: Period): string {
  const d = new Date((time as number) * 1000);
  if (period === "1D") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PT, hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(d);
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    if (minute !== "00" && minute !== "30") return "";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "";
    const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
    return `${hour}:${minute} ${dayPeriod}`.trim();
  }
  if (period === "1Y") {
    return d.toLocaleDateString("en-US", { timeZone: ET, month: "numeric", year: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { timeZone: ET, month: "numeric", day: "numeric" });
}

function formatHoverTime(time: Time, period: Period): string {
  const d = new Date((time as number) * 1000);
  if (period === "1D") {
    const time = d.toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" });
    return `${time} PT`;
  }
  if (period === "1W" || period === "1M") return formatEtTime(d, true);
  return d.toLocaleDateString("en-US", { timeZone: ET, month: "numeric", day: "numeric" });
}

/** Imperative lightweight-charts canvas — created once and updated in place, rather than re-mounted on every render. */
function LightweightPriceChart({ series, hasRightAxis, period, emaSeries, markers, priceLines, overlays, candles, volumes, vwap, rsi, macd, tvInd, onHover }: LightweightPriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
  const tvLayerRef = useRef<{ layer: TvIndicatorLayer; candle: ISeriesApi<"Candlestick"> } | null>(null);
  /** Skip pane rebuild when RSI/MACD data is the same array with a new identity. */
  const paneSigRef = useRef("");
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineHandlesRef = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<LWCandle[] | null>(null);
  candlesRef.current = candles ?? null;
  const periodRef = useRef(period);
  periodRef.current = period;
  const markersTipRef = useRef(markers ?? []);
  markersTipRef.current = markers ?? [];
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
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
        textColor: "rgba(255,255,255,0.95)",
        fontSize: 12,
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale: { visible: true, borderVisible: false, minimumWidth: 32 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      // Explicit — nested overflow parents + Lenis otherwise steal wheel/drag.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    chartRef.current = chart;

    // After the canvas handles zoom, block parent overflow-y / Lenis from scrolling the page.
    const stopParentScroll = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener("wheel", stopParentScroll, { passive: false });
    const cleanupWheel = () => container.removeEventListener("wheel", stopParentScroll);

    chart.subscribeCrosshairMove(param => {
      const emit = onHoverRef.current;
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        emit?.(null);
        return;
      }
      const per = periodRef.current;
      const h: ChartHover = { timeLabel: formatHoverTime(param.time, per) };
      const candleApi = candleRef.current;
      if (candleApi) {
        const c = param.seriesData.get(candleApi) as LWCandle | undefined;
        if (c?.open != null) {
          h.o = c.open;
          h.h = c.high;
          h.l = c.low;
          h.c = c.close;
          h.chgPct = c.open ? ((c.close - c.open) / c.open) * 100 : undefined;
        }
      } else {
        seriesMapRef.current.forEach((s) => {
          const d = param.seriesData.get(s) as LWPoint | undefined;
          if (d?.value != null) h.c = d.value;
        });
      }
      const volApi = volumeRef.current;
      if (volApi) {
        const v = param.seriesData.get(volApi) as { value?: number } | undefined;
        if (v?.value != null) {
          const n = v.value;
          h.vol = n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
        }
      }
      const { ema50, ema200 } = emaSeriesRef.current;
      if (ema50) {
        const d = param.seriesData.get(ema50) as LWPoint | undefined;
        if (d?.value != null) h.ema50 = d.value;
      }
      if (ema200) {
        const d = param.seriesData.get(ema200) as LWPoint | undefined;
        if (d?.value != null) h.ema200 = d.value;
      }
      if (rsiRef.current) {
        const d = param.seriesData.get(rsiRef.current) as LWPoint | undefined;
        if (d?.value != null) h.rsi = d.value;
      }
      const tSec = param.time as number;
      for (const m of markersTipRef.current) {
        if (Math.abs((m.time as number) - tSec) < 1 && m.text) {
          h.mark = m.text;
          break;
        }
      }
      if (!h.mark) {
        const facts = tvLayerRef.current?.layer.noteAt(tSec);
        if (facts?.length) h.mark = facts.join(" · ");
      }
      if (h.c == null && h.o == null && h.ema50 == null && !h.mark) {
        emit?.(null);
        return;
      }
      emit?.(h);
    });

    return () => {
      cleanupWheel();
      onHoverRef.current?.(null);
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
      paneSigRef.current = "";
      macdRefs.current = { line: null, signal: null, hist: null, paneIndex: null };
      tvLayerRef.current = null;
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
    // Rapid ticker/period swaps: LWC setData/fitContent/setVisibleLogicalRange can throw
    // "Value is null" (same class as Live session chart). Never take down the route.
    try {
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
        // Leave bottom ~28% of the price pane for volume overlay (TradingView-style).
        chart.priceScale("left").applyOptions({
          autoScale: true,
          scaleMargins: { top: 0.04, bottom: volumes?.length ? 0.28 : 0.04 },
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
        chart.priceScale("left").applyOptions({
          scaleMargins: { top: 0.04, bottom: volumes?.length ? 0.28 : 0.04 },
        });
      }

      if (volumes && volumes.length > 0) {
        if (!volumeRef.current) {
          volumeRef.current = chart.addSeries(HistogramSeries, {
            priceScaleId: "vol",
            priceFormat: { type: "volume" },
            lastValueVisible: false,
            priceLineVisible: false,
          });
        }
        // Overlay in lower band; small bottom pad so bars clear the time axis (was bottom:0 → clipped).
        chart.priceScale("vol").applyOptions({
          scaleMargins: { top: 0.72, bottom: 0.04 },
          borderVisible: false,
          visible: false,
        });
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
        try {
          if (period === "1D") {
            const open = Math.floor(sessionOpenMs() / 1000);
            const last = (candlesRef.current ?? []).reduce((m, c) => Math.max(m, c.time as number), 0);
            if (last >= open - 3600) {
              ts.setVisibleRange({ from: open as UTCTimestamp, to: (open + 390 * 60) as UTCTimestamp });
            } else {
              ts.fitContent();
            }
          } else {
            ts.fitContent();
          }
        } catch { try { ts.fitContent(); } catch { /* empty scale mid-swap */ } }
        // Re-enable Y auto-scale after period change (user drag locks the scale otherwise).
        chart.priceScale("left").applyOptions({ autoScale: true });
      } else {
        try { ts.setVisibleLogicalRange(savedRange); } catch { try { ts.fitContent(); } catch { /* ignore */ } }
      }
    } catch {
      // Leave prior frame — better than RouteErrorBoundary on Breakdown/Home ticker swaps.
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

    const rsiSig = rsi?.length
      ? `${rsi.length}|${rsi[0]!.time}|${rsi[rsi.length - 1]!.time}|${rsi[rsi.length - 1]!.value}`
      : "";
    const macdSig = macd?.macd.length
      ? `${macd.macd.length}|${macd.macd[macd.macd.length - 1]!.time}|${macd.hist.length}`
      : "";
    const paneSig = `${rsiSig}#${macdSig}`;
    const panesLive = (!rsiSig || rsiRef.current != null) && (!macdSig || macdRefs.current.line != null);
    if (paneSig === paneSigRef.current && panesLive) return;
    paneSigRef.current = paneSig;

    const clearOsc = () => {
      // Pane indexes shift when the shared TradingView sub-panes come and go — read the live one.
      let liveIdx: number | null = null;
      try { liveIdx = (rsiRef.current ?? macdRefs.current.line)?.getPane().paneIndex() ?? null; } catch { /* gone */ }
      if (rsiRef.current) {
        chart.removeSeries(rsiRef.current);
        rsiRef.current = null;
      }
      const m = macdRefs.current;
      if (m.line) { chart.removeSeries(m.line); m.line = null; }
      if (m.signal) { chart.removeSeries(m.signal); m.signal = null; }
      if (m.hist) { chart.removeSeries(m.hist); m.hist = null; }
      const idx = liveIdx;
      if (idx != null) {
        try { chart.removePane(idx); } catch { /* gone */ }
      }
      rsiPaneIndexRef.current = null;
      m.paneIndex = null;
    };

    // One shared sub-pane so RSI and MACD don't each steal a candle row.
    clearOsc();

    const wantRsi = !!(rsi && rsi.length > 0);
    const wantMacd = !!(macd && macd.macd.length > 0);
    if (wantRsi || wantMacd) {
      const pane = chart.addPane(true);
      const idx = pane.paneIndex();
      pane.setHeight(76);
      rsiPaneIndexRef.current = idx;
      macdRefs.current.paneIndex = idx;
      if (wantRsi) {
        rsiRef.current = chart.addSeries(LineSeries, {
          color: "#a78bfa",
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          priceScaleId: "rsi",
          priceFormat: { type: "price", precision: 0, minMove: 1 },
        }, idx);
        rsiRef.current.setData(rsi!);
        try {
          chart.priceScale("rsi", idx).applyOptions({
            visible: false,
            scaleMargins: { top: 0.12, bottom: 0.12 },
            borderVisible: false,
          });
        } catch { /* ok */ }
      }
      if (wantMacd) {
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
            visible: false,
            scaleMargins: { top: 0.12, bottom: 0.12 },
            borderVisible: false,
          });
        } catch { /* ok */ }
        macdRefs.current.hist!.setData(macd!.hist);
        macdRefs.current.line!.setData(macd!.macd);
        macdRefs.current.signal!.setData(macd!.signal);
      }
    }
  }, [rsi, macd]);

  // Shared TradingView indicators: overlays + markers on the candle series, sub-panes of their own.
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart) return;
    try {
      if (tvLayerRef.current && tvLayerRef.current.candle !== candle) {
        tvLayerRef.current.layer.destroy();
        tvLayerRef.current = null;
      }
      if (!candle || !tvInd?.items.length) {
        tvLayerRef.current?.layer.render([], [], { stepSec: 300 });
        return;
      }
      tvLayerRef.current ??= { layer: new TvIndicatorLayer(chart, candle, "left"), candle };
      tvLayerRef.current.layer.render(tvInd.items, tvInd.times, { stepSec: tvInd.stepSec });
    } catch {
      /* overlay only — never break the candles */
    }
  }, [tvInd, candles]);

  return (
    <div
      className="relative w-full h-full overscroll-none"
      data-lenis-prevent
      data-lenis-prevent-wheel
      data-lenis-prevent-touch
    >
      {/* touch-none: browser must not claim the gesture as page scroll */}
      <div ref={containerRef} className="w-full h-full touch-none" />
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
  extraMarkers,
}: PriceChartProps) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [barInterval, setBarInterval] = useState<string | null>(null);
  useEffect(() => { setBarInterval(null); }, [selectedPeriod]);
  const barChoices = BAR_CHOICES[selectedPeriod];
  const activeBar = barInterval ?? defaultBar(selectedPeriod);
  const [hover, setHover] = useState<ChartHover | null>(null);
  const hoverKey = useRef("");
  const onChartHover = useCallback((h: ChartHover | null) => {
    const key = h ? `${h.timeLabel}|${h.c ?? ""}|${h.rsi ?? ""}|${h.o ?? ""}|${h.ema50 ?? ""}|${h.mark ?? ""}` : "";
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    setHover(h);
  }, []);
  /** Clickable indicator tags — EM/EMA on by default for technical chart. */
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorId>>(
    () => new Set<IndicatorId>(getDefaultIndicators().filter((id) => INDICATOR_META.some((m) => m.id === id)) as IndicatorId[]),
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
      queryKey: ["stock-history", ticker, selectedPeriod, barInterval ?? "auto"],
      queryFn: async () => {
        const q = new URLSearchParams({ ticker, period: selectedPeriod });
        if (barInterval) q.set("interval", barInterval);
        const r = await fetch(`/api/stocks/history?${q}`, { credentials: "include" });
        if (!r.ok) throw new Error("history failed");
        return r.json() as Promise<Array<{ date: string; close: number; open: number | null; high: number | null; low: number | null; volume: number | null }>>;
      },
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
        historyByTicker[ticker] = qData
          .filter((p) => notFutureBar(p.date))
          .map(p => ({
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
      {
        time: toUnixTime(lowBar.date),
        price: lowBar.low ?? lowBar.close,
        color: "#ef4444",
        text: compact ? "L" : "Period Low",
        detail: MARKER_HELP.L,
      },
      {
        time: toUnixTime(highBar.date),
        price: highBar.high ?? highBar.close,
        color: "#22c55e",
        text: compact ? "H" : "Period High",
        detail: MARKER_HELP.H,
      },
    ];
  }, [tickers, historyByTicker, compact]);

  const zoneMarkers = useMemo((): LWMarker[] => zones
    .filter(z => z.renderAs === "marker" && z.date)
    .map(z => {
      let text: string;
      let detail: string;
      if (z.label.startsWith("Pivot")) {
        text = compact ? (z.label.includes("S1") ? "S1" : z.label.includes("R1") ? "R1" : "P") : z.label;
        detail = MARKER_HELP[text] ?? z.label;
      } else if (z.kind === "support") {
        text = compact ? "SL" : "Swing Low";
        detail = MARKER_HELP.SL;
      } else {
        text = compact ? "SH" : "Swing High";
        detail = MARKER_HELP.SH;
      }
      const color = z.label.startsWith("Pivot")
        ? (z.kind === "support" ? "#22c55e" : "#ef4444")
        : (z.kind === "support" ? "#f59e0b" : "#a78bfa");
      return { time: toUnixTime(z.date!), price: z.price, color, text, detail };
    }), [zones, compact]);

  const zonePriceLines = useMemo((): LWPriceLine[] => zones
    .filter(z => z.renderAs === "line")
    .map(z => ({
      price: z.price,
      color: z.kind === "support" ? "#22c55e" : "#ef4444",
      title: z.label,
      dashed: z.label.startsWith("MA") || z.label.startsWith("BB"),
    })), [zones]);

  /**
   * A93 — ±1σ IV expected-move corridor around each bar’s close (not a moving average).
   * Width = today’s ATM put IV scaled to 1w / 30d; applied as a % of that bar’s close
   * (fixed $ from last spot made history look like parallel rails).
   */
  const ivBand = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) return null;
    const bars = historyByTicker[tickers[0]] ?? [];
    if (bars.length === 0) return null;
    const spot = bars[bars.length - 1]!.close;
    const tech = technicalsQuery.data;
    const ivPct = pfNum(tech?.atmPutIv);
    const weekFracRaw = pfNum(tech?.impliedMoveWeekly);
    const weekFrac = weekFracRaw != null && weekFracRaw > 0
      ? weekFracRaw
      : ivPct != null && ivPct > 0
        ? (ivPct / 100) * Math.sqrt(7 / 365)
        : null;
    const monthFrac = ivPct != null && ivPct > 0
      ? (ivPct / 100) * Math.sqrt(30 / 365)
      : null;
    if (weekFrac == null && monthFrac == null) return null;
    const overlays: LWSeriesSpec[] = [];
    const band = (frac: number, id: string, color: string) => {
      const up: LWPoint[] = [];
      const dn: LWPoint[] = [];
      for (const b of bars) {
        const t = toUnixTime(b.date);
        up.push({ time: t, value: b.close * (1 + frac) });
        dn.push({ time: t, value: b.close * (1 - frac) });
      }
      overlays.push(
        { ticker: `${id}+`, color, scaleId: "left", data: up },
        { ticker: `${id}-`, color, scaleId: "left", data: dn },
      );
    };
    if (weekFrac != null) band(weekFrac, "_em_w", "rgba(56,189,248,0.65)");
    if (monthFrac != null) band(monthFrac, "_em_30", "rgba(167,139,250,0.5)");
    return {
      overlays,
      weekFrac,
      monthFrac,
      emWeek$: weekFrac != null ? spot * weekFrac : null,
      em30$: monthFrac != null ? spot * monthFrac : null,
    };
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

  const tradeMarkers = useMemo((): LWMarker[] => {
    if (!extraMarkers?.length || tickers.length !== 1) return [];
    const bars = historyByTicker[tickers[0]!] ?? [];
    const closeByDate = new Map(bars.map((b) => [b.date.slice(0, 10), b.close]));
    const out: LWMarker[] = [];
    for (const m of extraMarkers) {
      const day = m.date.slice(0, 10);
      const price = m.price ?? closeByDate.get(day);
      if (price == null) continue;
      out.push({
        time: toUnixTime(day),
        price,
        color: m.color ?? "#d4af37",
        text: m.text ?? "▲",
        detail: m.detail,
      });
    }
    return out;
  }, [extraMarkers, tickers, historyByTicker]);

  const allMarkers = useMemo(
    () => [...periodExtremaMarkers, ...zoneMarkers, ...ictMarkers, ...tradeMarkers].sort((a, b) => a.time - b.time),
    [periodExtremaMarkers, zoneMarkers, ictMarkers, tradeMarkers],
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

  /** Shared TradingView ports run on the chart's own bars (only the enabled ones compute). */
  const tvInd = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) return null;
    const ids = TV_INDICATORS.filter((x) => x.id !== "rsi" && x.id !== "macd" && activeIndicators.has(x.id as IndicatorId));
    if (!ids.length) return null;
    const bars: TvBar[] = (historyByTicker[tickers[0]!] ?? []).filter((b) => notFutureBar(b.date)).map((b) => {
      const o = b.open ?? b.close;
      return { time: toUnixTime(b.date), open: o, high: b.high ?? Math.max(o, b.close), low: b.low ?? Math.min(o, b.close), close: b.close, volume: b.volume ?? 0 };
    });
    if (bars.length < 2) return null;
    const times = bars.map((b) => b.time);
    const diffs = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
    return { items: ids.map((ind) => ({ ind, res: ind.compute(bars) })), times, stepSec: diffs[Math.floor(diffs.length / 2)] || 300 };
  }, [showTechnicalZones, tickers, historyByTicker, activeIndicators]);

  const chartSeries = useMemo((): LWSeriesSpec[] => tickers.map((ticker, i) => ({
    ticker,
    color: compact ? "#d4af37" : STOCK_COLORS[i % STOCK_COLORS.length],
    scaleId: yAxes[ticker] || "left",
    data: (historyByTicker[ticker] ?? [])
      .filter((b) => notFutureBar(b.date))
      .map(b => ({ time: toUnixTime(b.date), value: b.close })),
  })).filter(s => s.data.length > 0), [tickers, historyByTicker, yAxes, compact]);

  /** A93 candles + A126 volume histogram; session VWAP on 1D when volume present. */
  const ohlcv = useMemo(() => {
    if (!showTechnicalZones || tickers.length !== 1) {
      return { candles: null as LWCandle[] | null, volumes: null as LWVolume[] | null, vwap: null as LWPoint[] | null };
    }
    const bars = (historyByTicker[tickers[0]] ?? []).filter((b) => notFutureBar(b.date));
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
          // Soft overlay on price (TV-style) — not a separate pane.
          color: b.close >= o ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
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
          queryKey: ["stock-history", ticker, selectedPeriod],
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
      data-lenis-prevent-wheel
      data-lenis-prevent-touch
      className={compact
        ? "bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2 h-full min-h-0 flex flex-col overflow-hidden overscroll-none"
        : "bg-card border border-border rounded-xl p-4 shadow-sm mb-4 overscroll-none"}
    >
      <div className={cn(
        "shrink-0 flex flex-col sm:flex-row justify-between items-start sm:items-center",
        compact ? "gap-1.5 mb-1" : "gap-4 mb-6",
      )}>
        <div className="flex items-center gap-3 min-w-0">
          <h2 className={compact ? "text-[11px] font-semibold tracking-wide text-[#d4af37] shrink-0" : "text-lg font-bold tracking-tight"}>
            Price History
          </h2>
          {isError && (
            <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 px-2.5 py-1 rounded-full font-medium">
              <AlertCircle className="w-3.5 h-3.5" />
              Some data unavailable
            </div>
          )}
        </div>
        <div className={cn("flex items-center min-w-0", compact ? "gap-1.5 flex-nowrap overflow-x-auto" : "gap-2")}>
          {showTechnicalZones && techTicker && tickers.length === 1 && (
            <IndicatorMenu
              compact={compact}
              items={INDICATOR_META.map((ind) => ({ id: ind.id, label: ind.label, title: ind.title, busy: ind.id === "session" && sessionFlowQuery.isFetching }))}
              active={activeIndicators}
              onToggle={(id) => toggleIndicator(id as IndicatorId)}
            />
          )}
          {isAdmin && showTechnicalZones && techTicker && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh support/resistance levels"
              aria-label="Refresh support/resistance levels"
              className={cn(
                "inline-flex items-center justify-center rounded-md border font-medium disabled:opacity-50 shrink-0",
                compact
                  ? "h-5 w-5 border-zinc-600 bg-zinc-950 text-zinc-200 hover:text-white hover:border-zinc-400"
                  : "h-7 w-7 border-border/50 text-amber-100 hover:text-foreground hover:bg-secondary/60",
              )}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
            </button>
          )}
          {barChoices.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title={`Candle size ${activeBar}`}
                  className={cn(
                    "inline-flex items-center gap-0.5 rounded border border-zinc-600 bg-zinc-950 text-zinc-200 hover:text-white shrink-0",
                    compact ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-1 text-xs",
                  )}
                >
                  <Settings className="w-3 h-3" />
                  {activeBar}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-36 p-1.5 bg-zinc-950 border-[#d4af37]/30 text-white">
                <p className="px-1 pb-1 text-[9px] uppercase tracking-wide text-amber-100/70">Candle size</p>
                <div className="flex flex-wrap gap-1">
                  {barChoices.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setBarInterval(id === defaultBar(selectedPeriod) ? null : id)}
                      className={cn(
                        "px-1.5 py-0.5 rounded border text-[10px] font-mono",
                        activeBar === id
                          ? "border-[#d4af37] text-[#d4af37]"
                          : "border-zinc-600 text-white hover:border-zinc-400",
                      )}
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <div className={cn("flex items-center rounded-lg shrink-0", compact ? "bg-black border border-[#d4af37]/20 p-0.5" : "bg-secondary/60 p-1 border border-border/50")}>
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "font-bold rounded-md transition-colors",
                  compact ? "px-1.5 py-0.5 text-[10px]" : "px-3 py-1.5 text-xs",
                  selectedPeriod === p
                    ? compact ? "bg-zinc-800 text-white border border-[#d4af37]/60 shadow-sm" : "bg-primary text-primary-foreground shadow-sm"
                    : compact ? "text-amber-100 hover:text-white" : "text-amber-100 hover:text-foreground hover:bg-background/50",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Compact: fixed one-line key — live values overlay the chart so hover never grows this strip. */}
      {compact && (
        <div className="shrink-0 h-5 mb-1 flex items-center gap-x-1.5 overflow-x-auto whitespace-nowrap border-b border-[#d4af37]/25 bg-black px-1 text-[10px] font-mono font-semibold [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {hover?.o != null && hover.h != null && hover.l != null && hover.c != null ? (
            <>
              <span className={hover.chgPct != null && hover.chgPct >= 0 ? "text-green-400" : "text-red-400"}>O {hover.o.toFixed(2)}</span>
              <span className="text-sky-300">H {hover.h.toFixed(2)}</span>
              <span className="text-amber-200">L {hover.l.toFixed(2)}</span>
              <span className={hover.chgPct != null && hover.chgPct >= 0 ? "text-green-400" : "text-red-400"}>C {hover.c.toFixed(2)}</span>
              {hover.vol != null && <span className="text-[#d4af37]">V {hover.vol}</span>}
              {showRsi && hover.rsi != null && <span className="text-violet-300">RSI {hover.rsi.toFixed(0)}</span>}
              {hover.mark != null && <span className="text-rose-300">{hover.mark}</span>}
            </>
          ) : null}
          {!(hover?.o != null && hover.h != null && hover.l != null && hover.c != null) && (<>
          <span className="inline-flex items-center gap-1 text-[#d4af37]">
            Price
          </span>
          {showEm && ivBand?.weekFrac != null && (
            <span className="inline-flex items-center gap-1 text-sky-300/90" title="±1σ weekly IV expected move">
              <span className="h-0 w-2.5 border-t border-dashed border-sky-400" />
              1w ±{(ivBand.weekFrac * 100).toFixed(1)}%
            </span>
          )}
          {showEm && ivBand?.monthFrac != null && (
            <span className="inline-flex items-center gap-1 text-violet-300/90" title="±1σ ~30d IV expected move">
              <span className="h-0 w-2.5 border-t border-dashed border-violet-400" />
              30d ±{(ivBand.monthFrac * 100).toFixed(1)}%
            </span>
          )}
          {showEma && emaSeries && (
            <>
              <span className="inline-flex items-center gap-1 text-[#fde047]/90" title="EMA 50">
                <span className="h-0 w-2.5 border-t border-dashed border-[#fde047]" />
                EMA50
              </span>
              <span className="inline-flex items-center gap-1 text-[#fb923c]/90" title="EMA 200">
                <span className="h-0 w-2.5 border-t border-[#fb923c]" />
                EMA200
              </span>
            </>
          )}
          {showRsi && (
            <span className="text-violet-300/90" title="RSI(14)">RSI</span>
          )}
          <span className="inline-flex items-center gap-1 text-amber-100/80" title="L period low · SL swing low · SH swing high">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
            L·SL·SH
          </span>
          </>)}
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
                explanation="±1σ from ATM put IV around each close: 1-week (sky) and ~30-day (violet). Not EMA. Not a forecast — options-market implied range."
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
        "w-full relative min-h-0",
        compact
          ? "flex-1"
          : (showRsi || showMacd ? "h-[420px]" : "h-[320px]"),
      )}>
        {isLoading && !hasAnyData ? (
          <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10 rounded-lg border border-border/50">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !hasAnyData ? (
          <div className="absolute inset-0 flex items-center justify-center text-amber-100 border border-dashed border-border rounded-lg">
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
            tvInd={tvInd}
            onHover={onChartHover}
          />
        )}
      </div>
    </div>
  );
}
