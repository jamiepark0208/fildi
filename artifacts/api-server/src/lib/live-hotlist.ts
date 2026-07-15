import { EventEmitter } from "events";
import { getAllCachedIndicators, type IndicatorResult } from "./indicators.js";
import { logger } from "./logger.js";

const HOT_LIST_CAP = 46; // + 4 market context symbols = 50 (Finnhub free tier cap)
const REFRESH_MS = 60 * 60 * 1000; // 1hr — re-enable via ENABLE_AUTO_REFRESH once prototype tab is done

// Prototype phase: refresh is manual-only (button-triggered call to refresh()).
// Flip to true to restore the periodic setInterval in start().
const ENABLE_AUTO_REFRESH = false;

// Always subscribed regardless of scanner state. "^VIX" matches the Yahoo convention used
// elsewhere (see macro-regime.ts) — Finnhub's WebSocket symbol may differ, revisit in Phase 1
// (W1) when wiring these into the live ws subscription rather than just display.
export const MARKET_CONTEXT_SYMBOLS = ["SPY", "QQQ", "^VIX", "^TNX"];

export interface HotlistEntry {
  ticker: string;
  price: number;
  rsi: number;
  ivCurrent: number;
  return5d: number | null;
  stoch: number | null;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
}

function toEntry(r: IndicatorResult): HotlistEntry {
  return { ticker: r.ticker, price: r.price, rsi: r.rsi, ivCurrent: r.ivCurrent, return5d: r.return5d, stoch: r.stoch, signal: r.signal, tier: r.tier };
}

/** Top-10-per-dimension derivation from cached daily indicators (see task doc A7). */
export async function deriveHotList(): Promise<HotlistEntry[]> {
  const all = await getAllCachedIndicators();
  if (all.length === 0) return [];

  const byTicker = new Map<string, IndicatorResult>();

  const byRsi = [...all].sort((a, b) => a.rsi - b.rsi);
  byRsi.slice(0, 10).forEach(r => byTicker.set(r.ticker, r));

  const byIv = [...all].sort((a, b) => b.ivCurrent - a.ivCurrent);
  byIv.slice(0, 10).forEach(r => byTicker.set(r.ticker, r));

  const byDrop = [...all]
    .filter(r => r.return5d != null)
    .sort((a, b) => (a.return5d ?? 0) - (b.return5d ?? 0));
  byDrop.slice(0, 10).forEach(r => byTicker.set(r.ticker, r));

  const byStoch = [...all]
    .filter(r => r.stoch != null)
    .sort((a, b) => (a.stoch ?? 100) - (b.stoch ?? 100));
  byStoch.slice(0, 10).forEach(r => byTicker.set(r.ticker, r));

  return [...byTicker.values()].slice(0, HOT_LIST_CAP).map(toEntry);
}

/**
 * Owns the live hot list: re-derives from the scanner cache every 15 min during
 * market hours, applies user pin/unpin overrides, and emits "change" with the
 * add/remove diff so the WebSocket layer can subscribe/unsubscribe incrementally
 * without dropping candle/indicator state for tickers that remain.
 */
export class LiveHotlistManager extends EventEmitter {
  private current = new Set<string>();
  private entries: HotlistEntry[] = [];
  private pinned = new Set<string>();
  private unpinned = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshedAt: number | null = null;

  getCurrent(): string[] {
    return [...this.current];
  }

  /** Enriched rows (price/RSI/IV/etc) for tickers currently on the hot list — excludes market context symbols, which have no daily indicator row. */
  getCurrentEntries(): HotlistEntry[] {
    return this.entries;
  }

  getLastRefreshedAt(): number | null {
    return this.lastRefreshedAt;
  }

  /** User pin/unpin overrides — pinned tickers survive scanner refreshes, unpinned ones are excluded. */
  setPinned(ticker: string, pinned: boolean): void {
    const t = ticker.toUpperCase();
    if (pinned) {
      this.pinned.add(t);
      this.unpinned.delete(t);
    } else {
      this.unpinned.add(t);
      this.pinned.delete(t);
    }
  }

  async refresh(): Promise<void> {
    const derived = await deriveHotList();
    const filtered = derived.filter(e => !this.unpinned.has(e.ticker));
    const next = new Set(filtered.map(e => e.ticker));
    for (const t of this.pinned) next.add(t);
    for (const t of MARKET_CONTEXT_SYMBOLS) next.add(t);

    const added = [...next].filter(t => !this.current.has(t));
    const removed = [...this.current].filter(t => !next.has(t));

    this.lastRefreshedAt = Date.now();
    this.entries = filtered;
    if (added.length === 0 && removed.length === 0) return;

    this.current = next;
    logger.info({ added, removed, total: next.size }, "live-hotlist: refreshed");
    this.emit("change", { added, removed, current: this.getCurrent() });
  }

  start(): void {
    this.refresh().catch(err => logger.error({ err }, "live-hotlist: initial refresh failed"));
    if (!ENABLE_AUTO_REFRESH) return;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(err => logger.error({ err }, "live-hotlist: refresh failed"));
    }, REFRESH_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
}

// Shared instance — routes/live.ts and the future streaming engine both read/refresh this one.
export const liveHotlist = new LiveHotlistManager();
