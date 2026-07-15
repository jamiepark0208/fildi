import { EventEmitter } from "events";
import type { FinnhubTrade } from "./finnhub-ws.js";

const BUCKET_MS = 5 * 60 * 1000;

export interface Candle {
  symbol: string;
  bucketStart: number; // UNIX ms, floor(t / BUCKET_MS) * BUCKET_MS
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number; // session-anchored VWAP as of this candle's close
}

interface SymbolState {
  current: Candle | null;
  sessionDateKey: string; // ET calendar date the session VWAP accumulator belongs to
  sessionPV: number; // cumulative price*volume for the session
  sessionVolume: number; // cumulative volume for the session
}

function bucketStartFor(tMs: number): number {
  return Math.floor(tMs / BUCKET_MS) * BUCKET_MS;
}

function etDateKey(tMs: number): string {
  return new Date(tMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Aggregates Finnhub trade ticks into closed 5-min OHLCV candles per symbol,
 * with a session-anchored VWAP accumulator that resets when the ET calendar
 * date rolls over. Emits "candle" only when a bucket closes (i.e. a tick
 * arrives for the next bucket) — the in-progress candle is available via
 * getCurrentCandle() for callers that want a live/unfinished view.
 */
export class CandleAggregator extends EventEmitter {
  private state = new Map<string, SymbolState>();

  private getState(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = { current: null, sessionDateKey: "", sessionPV: 0, sessionVolume: 0 };
      this.state.set(symbol, s);
    }
    return s;
  }

  onTrade(trade: FinnhubTrade): void {
    // v=0 on price-only updates (no real trade volume) — still update price, skip VWAP contribution
    const { s: symbol, p: price, t: tMs, v: volume } = trade;
    if (!symbol || !isFinite(price)) return;

    const state = this.getState(symbol);
    const dateKey = etDateKey(tMs);
    if (dateKey !== state.sessionDateKey) {
      state.sessionDateKey = dateKey;
      state.sessionPV = 0;
      state.sessionVolume = 0;
    }
    if (volume > 0) {
      state.sessionPV += price * volume;
      state.sessionVolume += volume;
    }
    const vwap = state.sessionVolume > 0 ? state.sessionPV / state.sessionVolume : price;

    const bucketStart = bucketStartFor(tMs);

    if (!state.current || state.current.bucketStart !== bucketStart) {
      if (state.current) {
        this.emit("candle", state.current);
      }
      state.current = {
        symbol,
        bucketStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume > 0 ? volume : 0,
        vwap,
      };
      return;
    }

    const c = state.current;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += volume > 0 ? volume : 0;
    c.vwap = vwap;
  }

  /** In-progress candle for the current bucket, or null if no ticks seen yet this bucket. */
  getCurrentCandle(symbol: string): Candle | null {
    return this.state.get(symbol)?.current ?? null;
  }

  /** Seed a symbol's session VWAP accumulator from historical warmup bars (see A2.2). */
  seedSession(symbol: string, bars: { close: number; volume: number; tSec: number }[]): void {
    if (bars.length === 0) return;
    const state = this.getState(symbol);
    const dateKey = etDateKey(bars[bars.length - 1].tSec * 1000);
    state.sessionDateKey = dateKey;
    state.sessionPV = bars.reduce((sum, b) => sum + b.close * b.volume, 0);
    state.sessionVolume = bars.reduce((sum, b) => sum + b.volume, 0);
  }

  reset(symbol: string): void {
    this.state.delete(symbol);
  }
}
