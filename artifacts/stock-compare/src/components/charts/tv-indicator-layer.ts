/**
 * Draws TV_INDICATORS results on a lightweight-charts v5 chart — shared by the Breakdown chart and the Live chart.
 * Price-pane indicators become overlay lines + candle-series markers; sub-pane indicators get their own pane.
 * Everything it adds is removed again on the next render() / destroy(), so callers just hand it fresh results.
 */
import {
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { IndLine, IndResult, TvIndicator } from "@/lib/tv-indicators";

export type LayerItem = { ind: TvIndicator; res: IndResult };
export type LayerRenderOptions = {
  /** Draw only points whose time passes (Live: session window). */
  keep?: (t: number) => boolean;
  /** Seconds per bar, to time points displaced past the last bar (Ichimoku spans). */
  stepSec: number;
  subPaneHeight?: number;
};

const SUB_PANE_HEIGHT = 84;

type Pt = { time: UTCTimestamp; value?: number; color?: string };

export class TvIndicatorLayer {
  private series: ISeriesApi<"Line" | "Histogram">[] = [];
  private markers: ISeriesMarkersPluginApi<Time>;
  private notes = new Map<number, string[]>();

  constructor(
    private chart: IChartApi,
    private candle: ISeriesApi<"Candlestick">,
    private priceScaleId: string,
  ) {
    this.markers = createSeriesMarkers(candle, []);
  }

  /** Number of sub-panes the last render() created (callers grow the chart height by this). */
  subPanes = 0;

  /** The event facts of any markers at this bar time (hover). */
  noteAt(time: number): string[] {
    return this.notes.get(time) ?? [];
  }

  private clear(): void {
    for (const s of this.series) {
      try { this.chart.removeSeries(s); } catch { /* already gone */ }
    }
    this.series = [];
    this.notes.clear();
    this.subPanes = 0;
    try { this.markers.setMarkers([]); } catch { /* ignore */ }
  }

  destroy(): void {
    this.clear();
    try { this.markers.detach(); } catch { /* chart already removed */ }
  }

  render(items: LayerItem[], times: number[], o: LayerRenderOptions): void {
    this.clear();
    if (!items.length || !times.length) return;
    const n = times.length;
    const timeAt = (j: number): number | null => (j < 0 ? null : j < n ? times[j]! : times[n - 1]! + (j - (n - 1)) * o.stepSec);
    const keep = o.keep ?? (() => true);

    const linePoints = (ln: IndLine): Pt[] => {
      const out: Pt[] = [];
      const shift = ln.shift ?? 0;
      let started = false;
      for (let i = 0; i < ln.values.length; i++) {
        const t = timeAt(i + shift);
        if (t == null || !keep(t)) continue;
        const v = ln.values[i]!;
        if (Number.isFinite(v)) {
          started = true;
          const c = ln.colors?.[i];
          out.push(c ? { time: t as UTCTimestamp, value: v, color: c } : { time: t as UTCTimestamp, value: v });
        } else if (started) out.push({ time: t as UTCTimestamp });
      }
      return out;
    };

    const marks: SeriesMarker<Time>[] = [];
    for (const { ind, res } of items) {
      let pane = 0;
      if (ind.pane === "sub") {
        const p = this.chart.addPane();
        p.setHeight(o.subPaneHeight ?? SUB_PANE_HEIGHT);
        pane = p.paneIndex();
        this.subPanes += 1;
      }
      const overlay = ind.pane === "price";
      let first: ISeriesApi<"Line" | "Histogram"> | null = null;
      if (res.hist) {
        const h = this.chart.addSeries(HistogramSeries, {
          lastValueVisible: false, priceLineVisible: false, base: res.hist.base ?? 0,
          priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        }, pane);
        const pts: Pt[] = [];
        for (let i = 0; i < res.hist.values.length; i++) {
          const t = times[i]!;
          const v = res.hist.values[i]!;
          if (!keep(t) || !Number.isFinite(v)) continue;
          pts.push({ time: t as UTCTimestamp, value: v, color: res.hist.colors[i] });
        }
        h.setData(pts);
        this.series.push(h);
        first = h;
      }
      for (const ln of res.lines) {
        const s = this.chart.addSeries(LineSeries, {
          color: ln.color,
          lineWidth: ln.width ?? 1,
          lineStyle: ln.dashed ? LineStyle.Dashed : LineStyle.Solid,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          ...(ln.dots ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2 } : {}),
          ...(overlay ? { priceScaleId: this.priceScaleId, autoscaleInfoProvider: () => null } : {}),
        }, pane);
        s.setData(linePoints(ln));
        this.series.push(s);
        first ??= s;
      }
      if (!overlay) {
        try {
          this.chart.priceScale("right", pane).applyOptions({ visible: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
        } catch { /* scale id varies by pane */ }
      }
      if (!overlay && first && res.hlines) {
        for (const price of res.hlines) {
          first.createPriceLine({ price, color: "rgba(255,255,255,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        }
      }
      for (const m of res.markers) {
        const t = times[m.i];
        if (t == null || !keep(t)) continue;
        marks.push({
          time: t as UTCTimestamp,
          position: m.side === "up" ? "belowBar" : "aboveBar",
          shape: m.shape === "circle" ? "circle" : m.shape === "square" ? "square" : m.side === "up" ? "arrowUp" : "arrowDown",
          color: m.color,
          text: m.text,
          size: 1,
        });
        const list = this.notes.get(t) ?? [];
        list.push(`${ind.label}: ${m.detail}`);
        this.notes.set(t, list);
      }
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    try { this.markers.setMarkers(marks); } catch { /* overlay only — never break the candles */ }
  }
}
