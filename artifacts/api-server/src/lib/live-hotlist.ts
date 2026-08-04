import { EventEmitter } from "events";
import { getAllCachedIndicators, type IndicatorResult } from "./indicators.js";
import { logger } from "./logger.js";

const HOT_LIST_CAP = 46; // + 4 market context symbols = 50 (Finnhub free tier cap)
const REFRESH_MS = 60 * 60 * 1000; // 1hr — re-enable via ENABLE_AUTO_REFRESH once prototype tab is done

// Prototype phase: refresh is manual-only (button-triggered call to refresh()).
// Flip to true to restore the periodic setInterval in start().
const ENABLE_AUTO_REFRESH = false;

// Market context strip on the Live tab. "^VIX"/"^TNX" use the Yahoo convention (see
// macro-regime.ts) — priced through getLivePrices (Yahoo), which resolves them fine.
export const MARKET_CONTEXT_SYMBOLS = ["SPY", "QQQ", "^VIX", "^TNX"];

// Closed by the time the US session opens — getLivePrices' quote() call returns
// each index's own last-session price/change%, i.e. "how did Asia do overnight."
export const ASIA_INDEX_SYMBOLS = ["^KS11", "^N225", "^HSI"] as const;

/** dip = crashed, may reverse up (sell puts). rally = squeezed, may reverse down (sell calls). */
export type HotlistSide = "dip" | "rally";

export interface HotlistEntry {
  ticker: string;
  price: number;
  rsi: number;
  mfi: number;
  ivCurrent: number;
  return5d: number | null;
  stoch: number | null;
  macdCross: IndicatorResult["macdCross"];
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
}

// Overbought mirror of indicators.ts toSignal (which is oversold-only — including
// inside getLiveIndicatorOverlay, so rally callers must recompute after overlaying).
export const RALLY_RSI_THRESHOLD = 70;
export const RALLY_MFI_THRESHOLD = 80;
export function rallySignal(rsi: number, mfi: number): "GO" | "WATCH" | "NO" {
  const rsiOk = rsi > RALLY_RSI_THRESHOLD;
  const mfiOk = mfi > RALLY_MFI_THRESHOLD;
  if (rsiOk && mfiOk) return "GO";
  if (rsiOk || mfiOk) return "WATCH";
  return "NO";
}

function toEntry(r: IndicatorResult, side: HotlistSide): HotlistEntry {
  return {
    ticker: r.ticker, price: r.price, rsi: r.rsi, mfi: r.mfi, ivCurrent: r.ivCurrent,
    return5d: r.return5d, stoch: r.stoch, macdCross: r.macdCross,
    signal: side === "rally" ? rallySignal(r.rsi, r.mfi) : r.signal,
    tier: r.tier,
  };
}

// Both sides derive from one refresh, so each side gets half the websocket budget.
const PER_SIDE_CAP = Math.floor(HOT_LIST_CAP / 2);

/** Union of top-10 per dimension. Ascending comparators surface dip extremes; rally flips all but IV (always desc). */
function unionTopDimensions(all: IndicatorResult[], side: HotlistSide): IndicatorResult[] {
  const flip = side === "rally" ? -1 : 1;
  const dimensions: Array<(a: IndicatorResult, b: IndicatorResult) => number> = [
    (a, b) => flip * (a.rsi - b.rsi),
    (a, b) => b.ivCurrent - a.ivCurrent,
    (a, b) => flip * ((a.return5d ?? 0) - (b.return5d ?? 0)),
    (a, b) => flip * ((a.stoch ?? (side === "rally" ? -1 : 100)) - (b.stoch ?? (side === "rally" ? -1 : 100))),
  ];
  const needsField: Array<(r: IndicatorResult) => boolean> = [
    () => true,
    () => true,
    r => r.return5d != null,
    r => r.stoch != null,
  ];
  const byTicker = new Map<string, IndicatorResult>();
  dimensions.forEach((cmp, i) => {
    [...all].filter(needsField[i]).sort(cmp).slice(0, 10).forEach(r => byTicker.set(r.ticker, r));
  });
  return [...byTicker.values()];
}

/** Top-10-per-dimension derivation from cached daily indicators (see task doc A7). */
export async function deriveHotList(side: HotlistSide = "dip"): Promise<HotlistEntry[]> {
  const all = await getAllCachedIndicators();
  if (all.length === 0) return [];
  return unionTopDimensions(all, side).slice(0, PER_SIDE_CAP).map(r => toEntry(r, side));
}

/**
 * Owns the live hot list: re-derives from the scanner cache every 15 min during
 * market hours, applies user pin/unpin overrides, and emits "change" with the
 * add/remove diff so the WebSocket layer can subscribe/unsubscribe incrementally
 * without dropping candle/indicator state for tickers that remain.
 */
export class LiveHotlistManager extends EventEmitter {
  private current = new Set<string>();
  private dipEntries: HotlistEntry[] = [];
  private rallyEntries: HotlistEntry[] = [];
  private pinned = new Set<string>();
  private unpinned = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshedAt: number | null = null;

  getCurrent(): string[] {
    return [...this.current];
  }

  /** Enriched rows (price/RSI/IV/etc) for tickers currently on the hot list — excludes market context symbols, which have no daily indicator row. */
  getCurrentEntries(): HotlistEntry[] {
    return this.dipEntries;
  }

  getEntries(side: HotlistSide): HotlistEntry[] {
    return side === "rally" ? this.rallyEntries : this.dipEntries;
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

  private inFlightRefresh: Promise<void> | null = null;

  // /live/state and /live/entry-signals both auto-trigger a refresh when
  // lastRefreshedAt is null (post-restart); without this guard concurrent
  // requests race into duplicate scans (see 2026-07-28 "tickers: 0" incident).
  async refresh(): Promise<void> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(): Promise<void> {
    // Both sides come from the same in-memory indicator scan — one refresh, two lists.
    const [dip, rally] = await Promise.all([deriveHotList("dip"), deriveHotList("rally")]);
    const dipFiltered = dip.filter(e => !this.unpinned.has(e.ticker));
    const rallyFiltered = rally.filter(e => !this.unpinned.has(e.ticker));
    const next = new Set([...dipFiltered, ...rallyFiltered].map(e => e.ticker));
    for (const t of this.pinned) next.add(t);
    for (const t of MARKET_CONTEXT_SYMBOLS) next.add(t);

    const added = [...next].filter(t => !this.current.has(t));
    const removed = [...this.current].filter(t => !next.has(t));

    this.lastRefreshedAt = Date.now();
    this.dipEntries = dipFiltered;
    this.rallyEntries = rallyFiltered;
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
