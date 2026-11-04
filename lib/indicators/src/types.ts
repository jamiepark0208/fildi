/** Shared bar + result shapes for the indicator package. Times are unix seconds. */
export type TvBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

export type TvTimeframe = "5m" | "15m" | "1h";

/** One event an indicator fires, known at the close of its bar (never later). price = that bar's close (the grader's entry). */
export type IndEvent = {
  time: number;
  side: "buy" | "sell" | "neutral";
  /** Stable name the scorecard groups by (e.g. "Buy", "BoS", "Sweep"). Rename = new track record. */
  kind: string;
  price: number;
  /** The event's own facts, shown on chart hover. */
  note?: string[];
};

export type IndLineView = {
  /** Key into `series`. */
  key: string;
  color: string;
  width?: 1 | 2 | 3 | 4;
  dashed?: boolean;
  /** Optional per-bar colour (null = use `color`). */
  colors?: (string | null)[];
  /** Draw `shift` bars forward in time (negative = back), like Pine `offset`. */
  shift?: number;
  /** Dots instead of a line (e.g. the squeeze state cross). */
  dots?: boolean;
};
export type IndHistView = { key: string; colors: string[]; base?: number };
/** How the shared chart layer draws the series; pure data, no per-indicator chart code. */
export type IndView = { lines: IndLineView[]; hist?: IndHistView; hlines?: number[] };

export type IndOutput = { series: Record<string, number[]>; events: IndEvent[]; view: IndView };

export type MarkerStyle = { text: string; color: string; shape?: "arrow" | "circle" | "square" };

/** The plug-in contract: one file exports `def`; the registry in index.ts lists it. Bump `version` when logic/defaults change. */
export type IndicatorDef<O = Record<string, unknown>> = {
  id: string;
  label: string;
  /** Grades are per version. */
  version: number;
  source: { url: string; author: string; license: string; pinePath?: string };
  defaults: O;
  timeframes: TvTimeframe[];
  pane: "price" | "sub";
  /** One line: what the marks mean. */
  title: string;
  compute: (bars: TvBar[], opts?: Partial<O>) => IndOutput;
  /** Event kinds drawn as chart markers (default all; [] = events feed the track record only). */
  chartKinds?: string[];
  /** Marker text/colour/shape for an event (default: kind text, green buy / red sell). */
  marker?: (e: IndEvent) => MarkerStyle;
};
