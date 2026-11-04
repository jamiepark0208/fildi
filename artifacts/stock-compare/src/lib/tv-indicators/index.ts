/**
 * Registry of the TradingView indicator ports. Both the Breakdown chart and the Live chart read TV_INDICATORS: each
 * entry computes plain arrays aligned to the bars passed in, and the shared layer (components/charts/tv-indicator-layer)
 * draws them. Inputs are the scripts' defaults (see each module's *_DEFAULTS).
 */
import { superTrend, utBot } from "../tv-intraday.ts";
import { ichimoku } from "./ichimoku.ts";
import { lsh } from "./lsh.ts";
import { mso } from "./mso.ts";
import { ema, rsi, type Series } from "./pine.ts";
import { squeeze } from "./squeeze.ts";
import type { TvBar } from "./types.ts";

export type { TvBar, TvTimeframe } from "./types.ts";
export { resample, TF_MINUTES, type ResampledBar } from "./resample.ts";

export type IndLine = {
  key: string;
  color: string;
  width?: 1 | 2 | 3 | 4;
  dashed?: boolean;
  /** One value per bar (NaN = gap). */
  values: Series;
  /** Optional per-bar colour (null = use `color`). */
  colors?: (string | null)[];
  /** Draw `shift` bars forward in time (negative = back), like Pine `offset`. */
  shift?: number;
  /** Dots instead of a line (e.g. the squeeze state cross). */
  dots?: boolean;
};
export type IndHist = { key: string; values: Series; colors: string[]; base?: number };
export type IndMarker = {
  i: number;
  side: "up" | "down";
  text: string;
  color: string;
  shape?: "arrow" | "circle" | "square";
  /** The event's own facts, shown on hover. */
  detail: string;
};
export type IndResult = {
  lines: IndLine[];
  hist?: IndHist;
  /** Reference lines drawn on a sub-pane (e.g. 50, 30/70). */
  hlines?: number[];
  markers: IndMarker[];
};

export type TvIndicator = {
  id: TvIndicatorId;
  label: string;
  pane: "price" | "sub";
  /** One line: what the marks mean. */
  title: string;
  compute: (bars: TvBar[]) => IndResult;
};
export type TvIndicatorId = "ut" | "st" | "ichimoku" | "squeeze" | "mso" | "lsh" | "rsi" | "macd";

const GREEN = "#22c55e", RED = "#ef4444";
const fmt = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(3));

function computeUt(bars: TvBar[]): IndResult {
  const { signals } = utBot(bars);
  const idx = new Map(bars.map((b, i) => [b.time, i]));
  return {
    lines: [],
    markers: signals.map((s) => ({
      i: idx.get(s.time)!,
      side: s.side === "buy" ? "up" : "down",
      text: s.side === "buy" ? "Buy" : "Sell",
      color: s.side === "buy" ? GREEN : RED,
      detail: `UT Bot ${s.side}: close crossed ${s.side === "buy" ? "above" : "below"} the ATR(10)x1 trail`,
    })),
  };
}

function computeSt(bars: TvBar[]): IndResult {
  const { line, dir } = superTrend(bars);
  return { lines: [{ key: "st", color: GREEN, width: 2, values: line, colors: dir.map((d) => (d > 0 ? GREEN : RED)) }], markers: [] };
}

function computeIchimoku(bars: TvBar[]): IndResult {
  const r = ichimoku(bars);
  return {
    lines: [
      { key: "conv", color: "#2962ff", values: r.conversion },
      { key: "base", color: "#b71c1c", values: r.base },
      { key: "lag", color: "#43a047", values: r.lagging, shift: -r.shift },
      { key: "spanA", color: "rgba(67,160,71,0.9)", values: r.spanA, shift: r.shift },
      { key: "spanB", color: "rgba(244,67,54,0.9)", values: r.spanB, shift: r.shift },
    ],
    markers: [],
  };
}

const SQZ_BAR: Record<string, string> = { lime: "#00e600", green: "#007a00", red: "#ff2020", maroon: "#7a0000" };
const SQZ_STATE: Record<string, string> = { on: "#e5e7eb", off: "#6b7280", none: "#2962ff" };

function computeSqueeze(bars: TvBar[]): IndResult {
  const r = squeeze(bars);
  return {
    lines: [{ key: "state", color: "#6b7280", dots: true, values: r.val.map((v) => (Number.isNaN(v) ? NaN : 0)), colors: r.state.map((s) => (s ? SQZ_STATE[s]! : null)) }],
    hist: { key: "val", values: r.val, colors: r.barColor.map((c) => (c ? SQZ_BAR[c]! : "transparent")) },
    markers: [], // the state cross already shows squeeze on/off; the events stay in squeeze().events
  };
}

const BULL = "#35cfc5", BEAR = "#ff5454";
function computeMso(bars: TvBar[]): IndResult {
  const r = mso(bars);
  const markers: IndMarker[] = [];
  for (const b of r.breaks) {
    markers.push({
      i: b.i, side: b.dir === "bull" ? "up" : "down", text: `${b.kind}${b.count}`, color: b.dir === "bull" ? BULL : BEAR, shape: "square",
      detail: `${b.kind} ${b.dir === "bull" ? "up" : "down"} #${b.count}: close broke swing ${b.dir === "bull" ? "high" : "low"} ${fmt(b.price)}`,
    });
  }
  for (const d of r.divergences) {
    markers.push({
      i: d.i, side: d.dir === "bull" ? "up" : "down", text: "Div", color: d.dir === "bull" ? "#facc15" : "#fb923c", shape: "circle",
      detail: `${d.dir === "bull" ? "Bullish" : "Bearish"} divergence: price ${d.dir === "bull" ? "low" : "high"} ${fmt(d.price)} vs ${fmt(d.prevPrice)}, osc ${d.osc.toFixed(1)} vs ${d.prevOsc.toFixed(1)}`,
    });
  }
  markers.sort((a, b) => a.i - b.i);
  return {
    lines: [{ key: "osc", color: BULL, width: 2, values: r.osc, colors: r.osc.map((v) => (v >= 50 ? BULL : BEAR)) }],
    hist: { key: "tfo", base: 50, values: r.trendFilteredOsc, colors: r.trendFilteredOsc.map((v) => (v >= 50 ? "rgba(53,207,197,0.6)" : "rgba(255,84,84,0.6)")) },
    hlines: [50],
    markers,
  };
}

function computeLsh(bars: TvBar[]): IndResult {
  const r = lsh(bars);
  const lines: IndLine[] = [
    ...r.upper.map((v, k): IndLine => ({ key: `u${k + 1}`, color: "rgba(239,68,68,0.8)", dashed: true, values: v })),
    ...r.lower.map((v, k): IndLine => ({ key: `l${k + 1}`, color: "rgba(0,255,187,0.8)", dashed: true, values: v })),
  ];
  return {
    lines,
    markers: r.signals.map((s) => ({
      i: s.i, side: s.side === "bull" ? "up" : "down", text: "Sweep", color: s.side === "bull" ? "#00ffbb" : "#ff1100",
      detail: `${s.side === "bull" ? "Bullish" : "Bearish"} sweep reversal: ${s.bands} levels cleared (avg strength ${(s.strength * 100).toFixed(0)}%), reclaimed ${fmt(s.reclaim)}`,
    })),
  };
}

function computeRsi(bars: TvBar[]): IndResult {
  return { lines: [{ key: "rsi", color: "#a78bfa", values: rsi(bars.map((b) => b.close), 14) }], hlines: [30, 70], markers: [] };
}

function computeMacd(bars: TvBar[]): IndResult {
  const c = bars.map((b) => b.close);
  const f = ema(c, 12), s = ema(c, 26);
  const m = f.map((x, i) => x - s[i]!);
  const sig = ema(m, 9);
  const h = m.map((x, i) => x - sig[i]!);
  return {
    lines: [{ key: "macd", color: "#38bdf8", values: m }, { key: "sig", color: "#fbbf24", values: sig }],
    hist: { key: "hist", values: h, colors: h.map((v) => (v >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)")) },
    markers: [],
  };
}

export const TV_INDICATORS: TvIndicator[] = [
  { id: "ut", label: "UT Bot", pane: "price", title: "Buy/Sell arrows when the close crosses the ATR(10)x1 trailing stop.", compute: computeUt },
  { id: "st", label: "SuperTrend", pane: "price", title: "ATR(10)x3 line: green under price = up, red over = down.", compute: computeSt },
  { id: "ichimoku", label: "Ichimoku", pane: "price", title: "9/26/52 cloud: conversion blue, base red, spans 25 bars ahead, lagging green 25 back.", compute: computeIchimoku },
  { id: "lsh", label: "Liquidity Sweep", pane: "price", title: "Nearest 3 liquidity highs (red) / lows (teal); arrows = sweep of 2+ levels then reclaim.", compute: computeLsh },
  { id: "squeeze", label: "Squeeze", pane: "sub", title: "LazyBear momentum bars; cross: white squeeze on, gray off, blue none.", compute: computeSqueeze },
  { id: "mso", label: "Market Structure Osc", pane: "sub", title: "BigBeluga: histogram by structure trend; squares = ChoCh/BoS, dots = divergence.", compute: computeMso },
  { id: "rsi", label: "RSI", pane: "sub", title: "RSI(14) with 30/70 lines.", compute: computeRsi },
  { id: "macd", label: "MACD", pane: "sub", title: "MACD(12,26,9) line, signal, histogram.", compute: computeMacd },
];

export const TV_INDICATOR_BY_ID: Record<TvIndicatorId, TvIndicator> = Object.fromEntries(TV_INDICATORS.map((x) => [x.id, x])) as Record<TvIndicatorId, TvIndicator>;
