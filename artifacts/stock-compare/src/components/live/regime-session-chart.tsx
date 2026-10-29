/**
 * Breakdown-style candle session chart (lightweight-charts) for Live regime.
 * Domain = RTH open→close (PT labels); candles only through now; regime lines
 * drawn once on a canvas overlay (no separate snapped markers — those drifted).
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import {
  pendingCellLabel,
  type RegimeCheckpoint,
  type RegimeOutlook,
} from "@/components/live/regime-banner";
import { EntryCell, type EntrySignal } from "@/components/live/hotlist-table";
import { formatVolume } from "@/components/live/live-format";

/** Keep chart failures off the Live route ErrorBoundary. */
class ChartIsolate extends Component<
  { children: ReactNode; symbol: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch() { /* already isolated */ }
  override componentDidUpdate(prev: { symbol: string }) {
    if (prev.symbol !== this.props.symbol && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  override render() {
    if (this.state.failed) {
      return (
        <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-3 py-6 text-[11px] font-mono text-amber-100">
          Session chart failed for {this.props.symbol} — pick another ticker or refresh.
        </div>
      );
    }
    return this.props.children;
  }
}

type HistBar = {
  date: string;
  close: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
};

const SESSION_MIN = 390;
const BAR_SEC = 5 * 60;
const PT = "America/Los_Angeles";
const ET = "America/New_York";

/**
 * UTC ms of 9:30 America/New_York on today's ET calendar date.
 * Avoids `toLocaleString` → `new Date(...)` (parses as browser-local → PST/EST skew).
 */
export function sessionOpenMs(nowMs = Date.now()): number {
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const [y, m, d] = etDate.split("-").map(Number) as [number, number, number];
  // Seed EDT (UTC−4), then refine wall clock against America/New_York.
  let t = Date.UTC(y, m - 1, d, 9 + 4, 30, 0);
  for (let i = 0; i < 5; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(t));
    const g = (ty: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === ty)?.value ?? NaN);
    const gotD = `${g("year")}-${String(g("month")).padStart(2, "0")}-${String(g("day")).padStart(2, "0")}`;
    const wantD = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (gotD < wantD) {
      t += 86_400_000;
      continue;
    }
    if (gotD > wantD) {
      t -= 86_400_000;
      continue;
    }
    const deltaMin = 9 * 60 + 30 - (g("hour") * 60 + g("minute"));
    const deltaSec = 0 - g("second");
    t += deltaMin * 60_000 + deltaSec * 1000;
  }
  return t;
}

const RISK_HEX = { calm: "#38bdf8", normal: "#d4d4d8", elevated: "#f59e0b", stormy: "#ef4444" } as const;
const RISK_SHORT = { calm: "Calm", normal: "Norm", elevated: "Elev", stormy: "Storm" } as const;

function markerColor(c: RegimeCheckpoint): string {
  if (c.status === "resolved" && c.risk) return RISK_HEX[c.risk.level];
  if (c.status !== "resolved" || c.direction == null) return "#a8a29e";
  if (c.direction === "mixed") return "#eab308";
  return c.direction === "bullish" ? "#22c55e" : "#ef4444";
}

function shortDir(c: RegimeCheckpoint): string {
  if (c.status !== "resolved" || c.direction == null) return "—";
  if (c.direction === "mixed") return "Mix";
  return c.direction === "bullish" ? "Bull" : "Bear";
}

function markerLabel(c: RegimeCheckpoint): string {
  if (c.risk) return `${RISK_SHORT[c.risk.level]} ${Math.round(c.risk.pDropHalfAtr * 100)}%`;
  const dir = shortDir(c);
  return c.confidence != null ? `${dir} ${c.confidence}%` : dir;
}

function outlookLabel(slot: NonNullable<RegimeOutlook[number]>, minAfterOpen: number): string {
  return pendingCellLabel(
    {
      minAfterOpen,
      status: "pending",
      direction: null,
      confidence: null,
      label: "",
      computedLate: false,
      factors: [],
    },
    { [minAfterOpen]: slot },
  );
}

/** Always h:mm PT — "7:00 AM". */
function formatPtHmm(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return `${hour}:${minute} ${dayPeriod}`.trim();
}

/** Axis: only label :00 / :30 PT — hides LW's odd 11:03-style auto ticks. */
function formatAxisTick(sec: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(sec * 1000));
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (minute !== "00" && minute !== "30") return "";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return `${hour}:${minute} ${dayPeriod}`.trim();
}

/** Snap unix-sec to session 5m grid anchored at open. */
function snapToSessionGrid(tSec: number, openSec: number): number {
  const rel = Math.round((tSec - openSec) / BAR_SEC) * BAR_SEC;
  return openSec + Math.max(0, Math.min(SESSION_MIN * 60, rel));
}

async function fetch1D(ticker: string): Promise<HistBar[]> {
  const r = await fetch(
    `/api/stocks/history?ticker=${encodeURIComponent(ticker)}&period=1D`,
    { credentials: "include" },
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const QUICK_SYMBOLS = ["SPY", "QQQ"] as const;

type VertMark = {
  tSec: number;
  color: string;
  dashed: boolean;
  label: string;
  /** Pending / empirical — draw label under the plot so resolved labels stay clear. */
  future: boolean;
};

export function RegimeSessionChart(props: {
  symbol: string;
  onSymbolChange: (s: string) => void;
  checkpoints: RegimeCheckpoint[] | undefined;
  outlook?: RegimeOutlook;
  /** Hotlist entry-timing for this symbol (side-scoped). Null for SPY/QQQ / non-hotlist. */
  entrySignal?: EntrySignal;
  entryAsOf?: string | null;
}) {
  return (
    <ChartIsolate symbol={props.symbol}>
      <RegimeSessionChartInner {...props} />
    </ChartIsolate>
  );
}

function RegimeSessionChartInner({
  symbol,
  onSymbolChange,
  checkpoints,
  outlook,
  entrySignal,
  entryAsOf,
}: {
  symbol: string;
  onSymbolChange: (s: string) => void;
  checkpoints: RegimeCheckpoint[] | undefined;
  outlook?: RegimeOutlook;
  entrySignal?: EntrySignal;
  entryAsOf?: string | null;
}) {
  const openMs = useMemo(() => sessionOpenMs(), []);
  const closeMs = openMs + SESSION_MIN * 60_000;
  const openSec = Math.floor(openMs / 1000);
  const closeSec = Math.floor(closeMs / 1000);

  const { data: bars, isLoading, isError } = useQuery({
    queryKey: ["history-1d", symbol],
    queryFn: () => fetch1D(symbol),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  /** Full session 5m grid: real OHLC+vol through now, whitespace after — so every checkpoint time exists. */
  const { seriesData, volumeData, orHigh, orLow } = useMemo(() => {
    const nowSec = Math.floor((Date.now() + 120_000) / 1000);
    const bySec = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();

    for (const b of bars ?? []) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const tMs = new Date(b.date).getTime();
      if (!Number.isFinite(tMs)) continue;
      const snapped = snapToSessionGrid(Math.floor(tMs / 1000), openSec);
      if (snapped < openSec || snapped > closeSec || snapped > nowSec) continue;
      const oRaw = b.open == null ? close : Number(b.open);
      const hRaw = b.high == null ? close : Number(b.high);
      const lRaw = b.low == null ? close : Number(b.low);
      const o = Number.isFinite(oRaw) ? oRaw : close;
      const h = Number.isFinite(hRaw) ? Math.max(hRaw, o, close) : Math.max(o, close);
      const l = Number.isFinite(lRaw) ? Math.min(lRaw, o, close) : Math.min(o, close);
      const volRaw = Number(b.volume ?? 0);
      const vol = Number.isFinite(volRaw) ? volRaw : 0;
      const prev = bySec.get(snapped);
      if (!prev) {
        bySec.set(snapped, { open: o, high: h, low: l, close, volume: vol });
      } else {
        bySec.set(snapped, {
          open: prev.open,
          high: Math.max(prev.high, h),
          low: Math.min(prev.low, l),
          close,
          volume: prev.volume + vol,
        });
      }
    }

    const out: Array<
      | { time: UTCTimestamp; open: number; high: number; low: number; close: number }
      | { time: UTCTimestamp }
    > = [];
    const vols: Array<{ time: UTCTimestamp; value: number; color: string }> = [];
    // Opening range = first 30 minutes of RTH (6 bars × 5m).
    const orEnd = openSec + 30 * 60;
    const orBars: Array<{ high: number; low: number; close: number }> = [];

    for (let t = openSec; t <= closeSec; t += BAR_SEC) {
      const bar = bySec.get(t);
      if (bar && t <= nowSec) {
        out.push({
          time: t as UTCTimestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });
        const up = bar.close >= bar.open;
        vols.push({
          time: t as UTCTimestamp,
          value: bar.volume,
          color: up ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
        });
        if (t < orEnd) orBars.push({ high: bar.high, low: bar.low, close: bar.close });
      } else {
        out.push({ time: t as UTCTimestamp });
      }
    }

    // Drop OR outliers (bad vendor lows ~50pts below session) so ORH/ORL stay near price.
    let orH: number | null = null;
    let orL: number | null = null;
    if (orBars.length > 0) {
      const closes = orBars.map((b) => b.close).sort((a, b) => a - b);
      const mid = closes[Math.floor(closes.length / 2)]!;
      const band = mid * 0.04; // 4% of mid-price
      for (const b of orBars) {
        if (b.high > mid + band * 3 || b.low < mid - band * 3) continue;
        orH = orH == null ? b.high : Math.max(orH, b.high);
        orL = orL == null ? b.low : Math.min(orL, b.low);
      }
      if (orH == null || orL == null) {
        orH = Math.max(...orBars.map((b) => b.high));
        orL = Math.min(...orBars.map((b) => b.low));
      }
    }
    return { seriesData: out, volumeData: vols, orHigh: orH, orLow: orL };
  }, [bars, openSec, closeSec]);

  const candleCount = useMemo(
    () => seriesData.filter((d) => "close" in d).length,
    [seriesData],
  );

  const barBySec = useMemo(() => {
    const vols = new Map<number, number>();
    for (const v of volumeData) vols.set(v.time as number, v.value);
    const m = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
    for (const d of seriesData) {
      if (!("close" in d)) continue;
      m.set(d.time as number, {
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: vols.get(d.time as number) ?? 0,
      });
    }
    return m;
  }, [seriesData, volumeData]);

  const vertMarks = useMemo((): VertMark[] => {
    const list: VertMark[] = [];
    for (const c of checkpoints ?? []) {
      // Checkpoint minutes are exact on the session grid (15, 30, …).
      const tSec = openSec + c.minAfterOpen * 60;
      if (tSec < openSec || tSec > closeSec) continue;
      if (c.status === "resolved" && (c.risk != null || c.direction != null)) {
        list.push({
          tSec,
          color: markerColor(c),
          dashed: !!c.computedLate,
          label: markerLabel(c),
          future: false,
        });
      } else if (c.status === "resolved" && c.direction == null && c.minAfterOpen === 15) {
        // Ran on purpose: OR close, no directional call yet.
        list.push({
          tSec,
          color: "#a8a29e",
          dashed: !!c.computedLate,
          label: "OR",
          future: false,
        });
      } else if (c.status === "pending") {
        const slot = outlook?.[c.minAfterOpen];
        list.push({
          tSec,
          color: "rgba(255,255,255,0.88)",
          dashed: true,
          label: slot ? outlookLabel(slot, c.minAfterOpen) : "—",
          future: true,
        });
      }
    }
    return list;
  }, [checkpoints, outlook, openSec, closeSec]);

  const [hoverBar, setHoverBar] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);
  const [tickerDraft, setTickerDraft] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** Candle OHLC only — OR lines / volume must not stretch the left price scale. */
  const candlesRef = useRef<Array<{ high: number; low: number }>>([]);
  const vertMarksRef = useRef(vertMarks);
  const barBySecRef = useRef(barBySec);
  const orRef = useRef<{ high: number | null; low: number | null; openSec: number; orEndSec: number }>({
    high: null, low: null, openSec: 0, orEndSec: 0,
  });
  vertMarksRef.current = vertMarks;
  barBySecRef.current = barBySec;
  candlesRef.current = seriesData
    .filter((d): d is { time: UTCTimestamp; open: number; high: number; low: number; close: number } => "close" in d)
    .map((d) => ({ high: d.high, low: d.low }));
  orRef.current = {
    high: orHigh,
    low: orLow,
    openSec,
    orEndSec: openSec + 30 * 60,
  };

  const drawOverlay = () => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const canvas = overlayRef.current;
    const container = containerRef.current;
    if (!chart || !canvas || !container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ts = chart.timeScale();
    const or = orRef.current;
    if (series && or.high != null && or.low != null) {
      const x0 = ts.timeToCoordinate(or.openSec as UTCTimestamp);
      const x1 = ts.timeToCoordinate(or.orEndSec as UTCTimestamp);
      const yH = series.priceToCoordinate(or.high);
      const yL = series.priceToCoordinate(or.low);
      const paneBottom = Math.round(h * 0.72);
      // Skip OR paint when levels sit outside the candle-fit scale (bad lows used to
      // stretch the axis; now they just fall off-pane — don't draw a huge band).
      const orOnPane =
        yH != null && yL != null
        && Number.isFinite(yH) && Number.isFinite(yL)
        && yH >= 0 && yL >= 0 && yH <= paneBottom && yL <= paneBottom;
      if (
        orOnPane
        && x0 != null && x1 != null
        && Number.isFinite(x0) && Number.isFinite(x1)
      ) {
        ctx.fillStyle = "rgba(212,175,55,0.10)";
        ctx.fillRect(x0, Math.min(yH!, yL!), Math.max(4, x1 - x0), Math.abs(yL! - yH!));
        ctx.font = "600 9px ui-monospace, monospace";
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(212,175,55,0.95)";
        ctx.fillText("ORH", w - 6, yH! + 3);
        ctx.fillText("ORL", w - 6, yL! + 3);
      }
    }

    let pastLane = 0;
    let futureLane = 0;
    for (const m of vertMarksRef.current) {
      const x = ts.timeToCoordinate(m.tSec as UTCTimestamp);
      if (x == null || !Number.isFinite(x)) continue;
      ctx.beginPath();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(m.dashed ? [3, 4] : []);
      // Future labels sit at bottom of candle pane (above volume), not on the time axis —
      // h-14 collided with axis ticks + volume and looked "gone".
      const labelFloor = Math.round(h * 0.70);
      ctx.moveTo(x + 0.5, m.future ? 18 : 20);
      ctx.lineTo(x + 0.5, m.future ? labelFloor - 12 : h - 22);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.font = "600 9px ui-monospace, monospace";
      ctx.textAlign = "center";
      if (m.future) {
        ctx.font = "italic 600 9px ui-monospace, monospace";
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        const y = labelFloor - 2 - (futureLane % 2) * 11;
        ctx.fillText(m.label, x, y);
        futureLane += 1;
      } else {
        ctx.font = "600 9px ui-monospace, monospace";
        ctx.fillStyle = m.color;
        const y = 11 + (pastLane % 2) * 10;
        ctx.fillText(m.label, x, y);
        pastLane += 1;
      }
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.92)",
        fontSize: 9,
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale: { visible: true, borderVisible: false },
      localization: {
        timeFormatter: (time: Time) => {
          const sec = typeof time === "number" ? time : 0;
          return formatPtHmm(sec * 1000);
        },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => {
          const sec = typeof time === "number" ? time : 0;
          return formatAxisTick(sec);
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      lastValueVisible: true,
      priceLineVisible: true,
      priceScaleId: "left",
      // Fit candles only — OR price-lines used to pull the domain down to ~700.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        const bars = candlesRef.current;
        if (!res?.priceRange || !bars.length) return res;
        let min = Infinity;
        let max = -Infinity;
        for (const c of bars) {
          if (c.low < min) min = c.low;
          if (c.high > max) max = c.high;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return res;
        const pad = Math.max((max - min) * 0.08, max * 0.0015);
        return {
          priceRange: { minValue: min - pad, maxValue: max + pad },
          margins: res.margins,
        };
      },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    chart.priceScale("left").applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.08, bottom: 0.28 },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    const onRange = () => drawOverlay();
    const onCrosshair = (param: MouseEventParams<Time>) => {
      const t = param.time;
      if (t == null || typeof t !== "number") {
        setHoverBar(null);
        return;
      }
      const bar = barBySecRef.current.get(t);
      setHoverBar(bar ?? null);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.subscribeCrosshairMove(onCrosshair);
    const ro = new ResizeObserver(() => drawOverlay());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    // Clear hover — stale bar map from the previous ticker must not paint.
    setHoverBar(null);

    try {
      series.setData(seriesData as any);
      volume?.setData(volumeData as any);
    } catch {
      // Bad OHLC from a vendor bar — leave prior frame rather than crash the Live route.
      return;
    }

    // Prefer logical range — setVisibleRange → ensureNotNull(timeToIndex) throws
    // "Value is null" when the time scale has no index for from/to (rapid ticker swaps).
    const ts = chart.timeScale();
    const last = seriesData.length - 1;
    if (last >= 0) {
      try {
        ts.setVisibleLogicalRange({ from: 0, to: last });
      } catch {
        try {
          ts.setVisibleRange({
            from: openSec as UTCTimestamp,
            to: closeSec as UTCTimestamp,
          });
        } catch {
          try { ts.fitContent(); } catch { /* ignore */ }
        }
      }
    }
    // ORH/ORL drawn on canvas overlay only (createPriceLine stretched Y to include bad ORL).
    requestAnimationFrame(drawOverlay);
  }, [seriesData, volumeData, orHigh, orLow, openSec, closeSec, vertMarks]);

  const customActive = !QUICK_SYMBOLS.includes(symbol as (typeof QUICK_SYMBOLS)[number]);
  const hoverUp = hoverBar ? hoverBar.close >= hoverBar.open : null;

  const commitTicker = () => {
    const t = tickerDraft.trim().toUpperCase().replace(/[^A-Z.]/g, "");
    if (t.length >= 1 && t.length <= 6) onSymbolChange(t);
    setTickerDraft("");
  };

  const px = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="px-3 py-1 border-b border-[#d4af37]/25 bg-black flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold text-[#d4af37] uppercase tracking-wide shrink-0">
            {symbol}
          </span>
          {hoverBar ? (
            <span className="flex items-center gap-1.5 min-w-0 text-[10px] font-mono font-semibold tracking-wide truncate">
              <span className={hoverUp ? "text-green-400" : "text-red-400"}>
                O {px(hoverBar.open)}
              </span>
              <span className="text-sky-300">H {px(hoverBar.high)}</span>
              <span className="text-amber-200/90">L {px(hoverBar.low)}</span>
              <span className={hoverUp ? "text-green-400" : "text-red-400"}>
                C {px(hoverBar.close)}
              </span>
              <span className="text-[#d4af37]">
                V {hoverBar.volume > 0 ? formatVolume(hoverBar.volume) : "—"}
              </span>
            </span>
          ) : entrySignal ? (
            <span className="flex items-center gap-1.5 shrink-0" title="Stock entry timing under today's market regime — not a forecast">
              <EntryCell signal={entrySignal} asOf={entryAsOf ?? null} />
              <span className="text-[9px] font-mono text-white/80 hidden sm:inline">
                entry · {entryAsOf ?? "today"}
              </span>
            </span>
          ) : customActive ? (
            <span className="text-[9px] font-mono text-amber-100 shrink-0">
              no entry signal (not on hotlist)
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {QUICK_SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSymbolChange(s)}
              className={cn(
                "px-2 py-0.5 text-[10px] font-mono font-semibold rounded border transition-colors",
                symbol === s
                  ? "border-[#d4af37]/60 bg-[#d4af37]/15 text-amber-50"
                  : "border-[#d4af37]/15 text-amber-50/70 hover:border-[#d4af37]/40 hover:text-amber-50",
              )}
            >
              {s}
            </button>
          ))}
          <input
            type="text"
            value={tickerDraft}
            onChange={(e) => setTickerDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTicker();
              }
            }}
            onBlur={() => { if (tickerDraft.trim()) commitTicker(); }}
            placeholder="TKR"
            maxLength={6}
            title="Chart any ticker — one 1D history fetch (same as SPY/QQQ)"
            className="w-14 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border border-[#d4af37]/25 bg-zinc-950 text-amber-50 placeholder:text-amber-50/35 focus:outline-none focus:border-[#d4af37]/60 uppercase"
          />
          {customActive && (
            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded border border-[#d4af37]/60 bg-[#d4af37]/15 text-amber-50">
              {symbol}
            </span>
          )}
        </div>
      </div>

      <div className="relative h-[248px]">
        {isLoading && (
          <p className="absolute inset-0 z-10 flex items-center px-3 text-[11px] text-amber-100 font-mono bg-zinc-950/80">
            Loading {symbol}…
          </p>
        )}
        {isError && (
          <p className="absolute inset-0 z-10 flex items-center px-3 text-[11px] text-amber-100 font-mono bg-zinc-950/80">
            Chart unavailable.
          </p>
        )}
        {!isLoading && !isError && candleCount === 0 && (
          <p className="absolute inset-0 z-10 flex items-center px-3 text-[11px] text-amber-100 font-mono bg-zinc-950/80">
            No session bars yet (premarket / holiday).
          </p>
        )}
        <div ref={containerRef} className="absolute inset-0" />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 pointer-events-none"
          aria-hidden
        />
      </div>
    </div>
  );
}
