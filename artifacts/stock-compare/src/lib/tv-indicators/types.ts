/** Shared bar + result shapes for the TradingView indicator ports. Times are unix seconds. */
export type TvBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

export type TvTimeframe = "5m" | "15m" | "1h";
