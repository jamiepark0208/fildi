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
export function unionTopDimensions(all: IndicatorResult[], side: HotlistSide): IndicatorResult[] {
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

/**
 * If a ticker still appears on both sides (should be rare after RSI gate), keep the
 * side with more extreme |RSI−50| and drop the other.
 */
export function partitionOverlap(
  dip: HotlistEntry[],
  rally: HotlistEntry[],
): { dip: HotlistEntry[]; rally: HotlistEntry[] } {
  const dipSet = new Set(dip.map(e => e.ticker));
  const both = rally.filter(e => dipSet.has(e.ticker));
  if (both.length === 0) return { dip, rally };

  const dropFromDip = new Set<string>();
  const dropFromRally = new Set<string>();
  for (const r of both) {
    const d = dip.find(e => e.ticker === r.ticker)!;
    const dipExt = Math.abs(d.rsi - 50);
    const rallyExt = Math.abs(r.rsi - 50);
    if (rallyExt > dipExt) dropFromDip.add(r.ticker);
    else dropFromRally.add(r.ticker); // ties → dip wins (sell-put bias)
  }
  return {
    dip: dip.filter(e => !dropFromDip.has(e.ticker)),
    rally: rally.filter(e => !dropFromRally.has(e.ticker)),
  };
}

/**
 * Atomic both-side derive: RSI side-gate before dimension union so high-IV mid-RSI
 * names cannot land on both Oversold and Overbought.
 * dip: rsi < 50; rally: rsi > 50; rsi == 50 → neither.
 */
export function deriveBothHotLists(all: IndicatorResult[]): { dip: HotlistEntry[]; rally: HotlistEntry[] } {
  if (all.length === 0) return { dip: [], rally: [] };

  const dipPool = all.filter(r => r.rsi < 50);
  const rallyPool = all.filter(r => r.rsi > 50);

  const dip = unionTopDimensions(dipPool, "dip").slice(0, PER_SIDE_CAP).map(r => toEntry(r, "dip"));
  const rally = unionTopDimensions(rallyPool, "rally").slice(0, PER_SIDE_CAP).map(r => toEntry(r, "rally"));
  return partitionOverlap(dip, rally);
}

/** Top-10-per-dimension derivation from cached daily indicators (see task doc A7). */
export async function deriveHotList(side: HotlistSide = "dip"): Promise<HotlistEntry[]> {
  const all = await getAllCachedIndicators();
  const both = deriveBothHotLists(all);
  return side === "rally" ? both.rally : both.dip;
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
  // Not `async`: an async wrapper would hand callers a fresh, unhandled promise (A251).
  refresh(): Promise<void> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh().finally(() => {
      this.inFlightRefresh = null;
    });
    // A251: routes fire-and-forget this (`void refresh()`); an unhandled rejection shuts the API down.
    // Mark it handled here; awaiting callers still receive the rejection.
    this.inFlightRefresh.catch(err => logger.warn({ err }, "live-hotlist: refresh failed"));
    return this.inFlightRefresh;
  }

  private async doRefresh(): Promise<void> {
    // Both sides from one gated derive — RSI pools are mutually exclusive by construction.
    const all = await getAllCachedIndicators();
    const { dip, rally } = deriveBothHotLists(all);
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
