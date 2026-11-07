/**
 * A194 — Schwab 1m bar poll → watchlist_sync.intraday_bars_1m (source=schwab).
 *
 * Cadence: every 5 min during RTH, after 07:05 PT (skew survey uses ~120 Schwab
 * calls around 07:00 PT). ~20 symbols ≈ 20 req / 5 min ≈ 4 rpm — well under the
 * soft 60 rpm bar lane of the global 100 rpm FIFO in schwab-client.
 */
import { pool } from "@workspace/db";
import { WATCHLIST } from "./constants.js";
import { logger } from "./logger.js";
import { isMarketOpen } from "./market-hours.js";
import { schwabCredentialsConfigured } from "./schwab-auth.js";
import {
  getSchwabMinuteBars,
  getSchwabUsageStats,
  type SchwabMinuteBar,
} from "./schwab-client.js";
import { refreshLiveBreadthFromSchwabBars } from "./live-breadth-5m.js";
import { distinctConflictWhere, startFetchRun } from "./fetch-guard.js";
import { pollStartMsForSymbol } from "./schwab-1m-window.js";
export { pollStartMsForSymbol } from "./schwab-1m-window.js";

const POLL_MS = 5 * 60_000;
const JITTER_MS = 30_000;
const SYMBOL_CAP = 20;
/** Soft bar-lane ceiling — pause a cycle if the shared window is already this hot. */
const BAR_RPM_SOFT_CAP = 60;
export let schwab1mPollRunning = false;
export let lastSchwab1mPollRun: Date | null = null;

/** SPY + scanner watchlist, capped at 20 (A194 pass/fail universe). */
export function schwab1mUniverse(cap = SYMBOL_CAP): string[] {
  const rest = WATCHLIST.map((t) => t.toUpperCase()).filter((t) => t !== "SPY");
  return ["SPY", ...rest].slice(0, cap);
}

/** Minutes since local midnight in America/Los_Angeles. */
export function ptMinutesOfDay(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** Skip until 07:05 PT so the 07:00 skew survey owns the Schwab FIFO. */
export function afterSkewSurveyWindow(now: Date = new Date()): boolean {
  return ptMinutesOfDay(now) >= 7 * 60 + 5;
}

export function shouldRunSchwab1mPoll(now: Date = new Date()): boolean {
  if (!isMarketOpen(now)) return false;
  if (!afterSkewSurveyWindow(now)) return false;
  if (!schwabCredentialsConfigured()) return false;
  if (!lastSchwab1mPollRun) return true;
  return now.getTime() - lastSchwab1mPollRun.getTime() >= POLL_MS;
}

export async function storeSchwabMinuteBars(ticker: string, bars: SchwabMinuteBar[]): Promise<number> {
  if (bars.length === 0) return 0;
  const t = ticker.toUpperCase();
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const b of bars) {
    placeholders.push(`($${i++}, to_timestamp($${i++} / 1000.0), $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, 'schwab')`);
    values.push(t, b.ts, b.open, b.high, b.low, b.close, b.volume);
  }
  const cols = ["o", "h", "l", "c", "v", "source"];
  const { rowCount } = await pool.query(
    `INSERT INTO watchlist_sync.intraday_bars_1m (ticker, ts, o, h, l, c, v, source)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (ticker, ts) DO UPDATE SET
       o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v,
       source = EXCLUDED.source
     ${distinctConflictWhere(cols, "intraday_bars_1m")}`,
    values,
  );
  return rowCount ?? bars.length;
}

export async function fetchAndStoreSchwab1m(
  ticker: string,
  startMs: number,
  endMs: number = Date.now(),
): Promise<number> {
  const bars = await getSchwabMinuteBars(ticker, startMs, endMs);
  if (!bars?.length) return 0;
  return storeSchwabMinuteBars(ticker, bars);
}

export type Schwab1mPollResult = {
  symbols: number;
  bars: number;
  skipped?: string;
};

/**
 * One poll cycle (or admin/manual run). Advances lastRun even on empty so we
 * don't hammer a missing token / closed session.
 */
async function lastStoredBarMsByTicker(tickers: string[]): Promise<Map<string, number>> {
  if (!tickers.length) return new Map();
  const { rows } = await pool.query<{ ticker: string; ms: string }>(
    `SELECT ticker, (EXTRACT(EPOCH FROM MAX(ts)) * 1000)::bigint::text AS ms
     FROM watchlist_sync.intraday_bars_1m
     WHERE ticker = ANY($1::text[]) AND source = 'schwab'
     GROUP BY ticker`,
    [tickers],
  );
  return new Map(rows.map((r) => [r.ticker, Number(r.ms)]));
}

export async function runSchwab1mPoll(opts?: {
  force?: boolean;
  lookbackMs?: number;
  days?: number;
}): Promise<Schwab1mPollResult | null> {
  if (schwab1mPollRunning) return null;
  const force = opts?.force === true;
  const now = new Date();
  if (!force && !shouldRunSchwab1mPoll(now)) {
    return { symbols: 0, bars: 0, skipped: "gate" };
  }
  if (!schwabCredentialsConfigured()) {
    return { symbols: 0, bars: 0, skipped: "no-creds" };
  }
  const usage = getSchwabUsageStats();
  if (usage.requestsLast60s >= BAR_RPM_SOFT_CAP) {
    logger.warn(
      { rpm: usage.requestsLast60s, softCap: BAR_RPM_SOFT_CAP },
      "schwab-1m: skipping cycle — shared RPM already at soft bar cap",
    );
    return { symbols: 0, bars: 0, skipped: "rpm-soft-cap" };
  }

  schwab1mPollRunning = true;
  const symbols = schwab1mUniverse();
  let bars = 0;
  const meter = await startFetchRun("schwab", "schwab-1m-poll", { routine: opts?.days == null });
  meter.bump({ keysPlanned: symbols.length });
  try {
    const endMs = Date.now();
    const lastBySym = opts?.days != null ? new Map<string, number>() : await lastStoredBarMsByTicker(symbols);
    for (const sym of symbols) {
      try {
        const startMs = pollStartMsForSymbol(sym, endMs, lastBySym.get(sym), opts);
        const n = await fetchAndStoreSchwab1m(sym, startMs, endMs);
        bars += n;
        meter.bump({ keysFetched: n > 0 ? 1 : 0, vendorCalls: 1, rowsInserted: n });
      } catch (err) {
        logger.warn({ err, sym }, "schwab-1m: symbol failed");
      }
    }
    lastSchwab1mPollRun = new Date();
    await refreshLiveBreadthFromSchwabBars();
    await meter.finish(opts?.days != null ? "backfill" : "tail");
    logger.info({ symbols: symbols.length, bars }, "schwab-1m: poll complete");
    return { symbols: symbols.length, bars };
  } catch (err) {
    logger.error({ err }, "schwab-1m: poll failed");
    await meter.finish("error");
    return { symbols: symbols.length, bars, skipped: "error" };
  } finally {
    schwab1mPollRunning = false;
  }
}

/** S034-style one-shot: up to 10d × 20 symbols (one Schwab call each). */
export async function runSchwab1mBackfill(days = 10): Promise<Schwab1mPollResult | null> {
  const d = Math.min(10, Math.max(1, Math.floor(days)));
  return runSchwab1mPoll({ force: true, days: d });
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 60s heartbeat + 5m gate + startup jitter (A194). */
export function startSchwab1mPoller(): void {
  if (pollTimer) return;
  const delay = Math.floor(Math.random() * JITTER_MS);
  setTimeout(() => {
    void runSchwab1mPoll().catch((err) => logger.error({ err }, "schwab-1m: initial poll failed"));
    pollTimer = setInterval(() => {
      void runSchwab1mPoll().catch((err) => logger.error({ err }, "schwab-1m: poll failed"));
    }, 60_000);
  }, delay);
  logger.info({ delayMs: delay, pollMs: POLL_MS, symbols: SYMBOL_CAP }, "schwab-1m: poller armed");
}
