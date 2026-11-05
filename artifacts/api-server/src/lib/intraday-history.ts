// Intraday session-shape history (Live tab).
//
// intraday-regime.ts records what the model CALLED at each checkpoint; this
// records what the tape actually DID — where the high and low printed, and how
// far into the session. That's the pair needed to answer both "were the
// checkpoint calls any good" and "what time of day have reversals been hitting".
//
// The raw 5m series is stored alongside the derived stats because Yahoo only
// serves 5m bars ~60 days back: once a day ages out of that window, the bars are
// unrecoverable, and checkpoint reconstruction (see intraday-checkpoint-grading.ts)
// needs them.
import { yahooFinance } from "./yahoo-client.js";
import { and, eq, inArray } from "drizzle-orm";
import { db, intradayDayStats } from "@workspace/db";
import type { Bar } from "./intraday-regime.js";
import { logger } from "./logger.js";


/** Index symbols whose session shape is tracked. Deliberately not the hotlist — this is market-wide context. */
export const TRACKED_SYMBOLS = ["SPY", "QQQ"] as const;

export type DayShape = "reversal-up" | "reversal-down" | "trend-up" | "trend-down" | "chop";

export interface DayStats {
  date: string;
  ticker: string;
  open: number;
  high: number;
  low: number;
  close: number;
  highAtMin: number;
  lowAtMin: number;
  closeVsOpenPct: number;
  rangePct: number;
  dayShape: DayShape;
  reversalAtMin: number | null;
  bars: Bar[];
}

// A close in the top/bottom third of the day's range is a directional session;
// the middle third is chop. Two-thirds (not 80%) because SPY rarely closes on the
// absolute high — demanding more would classify most real trend days as chop.
const DIRECTIONAL_RANGE_POS = 1 / 3;

// The extreme has to print after the opening range closes for the session to count
// as a reversal. A low set in the first 5m bar is just a gap-down open that drifted
// up all day — that's a trend day, and calling it a reversal would pollute the
// reversal-time histogram with 9:30 entries that no one can trade.
const MIN_REVERSAL_MIN = 30;

// And it has to reverse from something. A 0.1% dip that recovers isn't a reversal,
// it's noise — without this floor every quiet grind-up day reads as "reversal-up".
const MIN_REVERSAL_EXCURSION_PCT = 0.25;

/** Minutes from 9:30 ET open for a bar timestamp, given that session's open time. */
function minAfterOpen(barTime: number, sessionOpenMs: number): number {
  return Math.round((barTime - sessionOpenMs) / 60_000);
}

/**
 * Derives the session shape from one day's 5m bars.
 *
 * Returns null for sessions too short to classify (half-days that lost their feed,
 * or a day still in progress) — a 3-bar "session" would produce a garbage dayShape
 * that then silently skews every pattern aggregate built on top of it.
 */
export function classifyDay(ticker: string, date: string, bars: Bar[]): DayStats | null {
  if (bars.length < 12) return null; // < 1 hour of tape

  const sessionOpenMs = bars[0].time;
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;

  let high = -Infinity, low = Infinity, highIdx = 0, lowIdx = 0;
  bars.forEach((b, i) => {
    if (b.high > high) { high = b.high; highIdx = i; }
    if (b.low < low) { low = b.low; lowIdx = i; }
  });

  const highAtMin = minAfterOpen(bars[highIdx].time, sessionOpenMs);
  const lowAtMin = minAfterOpen(bars[lowIdx].time, sessionOpenMs);
  const range = high - low;

  // A zero-range session (halted / single print) can't be classified and would
  // divide by zero below.
  if (!(range > 0) || !(open > 0)) return null;

  const rangePos = (close - low) / range;
  const dipDepthPct = ((open - low) / open) * 100;
  const popHeightPct = ((high - open) / open) * 100;

  let dayShape: DayShape;
  let reversalAtMin: number | null = null;

  if (rangePos >= 1 - DIRECTIONAL_RANGE_POS) {
    // Closed strong. Reversal only if it first sold off, late enough and deep enough.
    if (lowAtMin >= MIN_REVERSAL_MIN && dipDepthPct >= MIN_REVERSAL_EXCURSION_PCT) {
      dayShape = "reversal-up";
      reversalAtMin = lowAtMin;
    } else {
      dayShape = "trend-up";
    }
  } else if (rangePos <= DIRECTIONAL_RANGE_POS) {
    if (highAtMin >= MIN_REVERSAL_MIN && popHeightPct >= MIN_REVERSAL_EXCURSION_PCT) {
      dayShape = "reversal-down";
      reversalAtMin = highAtMin;
    } else {
      dayShape = "trend-down";
    }
  } else {
    dayShape = "chop";
  }

  return {
    date,
    ticker,
    open,
    high,
    low,
    close,
    highAtMin,
    lowAtMin,
    closeVsOpenPct: ((close - open) / open) * 100,
    rangePct: (range / open) * 100,
    dayShape,
    reversalAtMin,
    bars,
  };
}

/** ET calendar date for a bar timestamp — groups a multi-day 5m series into sessions. */
export function etDateOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Multi-day 5m bars grouped by ET session date, regular hours only.
 *
 * Yahoo returns pre/post-market prints in this series; including them would put
 * the session "open" at 4:00 AM and make every minutes-after-open figure wrong,
 * so bars outside 9:30–16:00 ET are dropped before grouping.
 */
export async function fetchIntradayHistory(ticker: string, days: number): Promise<Map<string, Bar[]>> {
  // Yahoo serves 5m only inside the last 60 days and rejects a request that starts exactly 60 d back -> clamp to 59.
  const period1 = new Date(Date.now() - Math.min(days, 59) * 86_400_000);
  const result = await yahooFinance.chart(ticker, { period1, interval: "5m" }, { validateResult: false }) as unknown as {
    quotes?: Array<{ date: string | Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null }>;
  };

  const bySession = new Map<string, Bar[]>();
  for (const q of result?.quotes ?? []) {
    if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
    const time = new Date(q.date).getTime();
    const et = new Date(new Date(time).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const minutes = et.getHours() * 60 + et.getMinutes();
    if (minutes < 9 * 60 + 30 || minutes >= 16 * 60) continue;

    const key = etDateOf(time);
    const arr = bySession.get(key) ?? [];
    arr.push({ time, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
    bySession.set(key, arr);
  }

  for (const bars of bySession.values()) bars.sort((a, b) => a.time - b.time);
  return bySession;
}

/** Upserts derived stats for one session. Idempotent — re-running a day overwrites it. */
export async function saveDayStats(stats: DayStats): Promise<void> {
  const row = {
    date: stats.date,
    ticker: stats.ticker,
    open: String(stats.open),
    high: String(stats.high),
    low: String(stats.low),
    close: String(stats.close),
    highAtMin: stats.highAtMin,
    lowAtMin: stats.lowAtMin,
    closeVsOpenPct: String(stats.closeVsOpenPct),
    rangePct: String(stats.rangePct),
    dayShape: stats.dayShape,
    reversalAtMin: stats.reversalAtMin,
    barsJson: stats.bars,
  };
  await db.insert(intradayDayStats).values(row)
    .onConflictDoUpdate({ target: [intradayDayStats.date, intradayDayStats.ticker], set: row });
}

/** Stored sessions for the given dates, keyed `${date}:${ticker}`. Bars included — callers replay them. */
export async function loadDayStats(dates: string[]): Promise<Map<string, DayStats>> {
  if (dates.length === 0) return new Map();
  const rows = await db.select().from(intradayDayStats).where(inArray(intradayDayStats.date, dates));
  const out = new Map<string, DayStats>();
  for (const r of rows) {
    out.set(`${r.date}:${r.ticker}`, {
      date: r.date,
      ticker: r.ticker,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      highAtMin: r.highAtMin,
      lowAtMin: r.lowAtMin,
      closeVsOpenPct: Number(r.closeVsOpenPct),
      rangePct: Number(r.rangePct),
      dayShape: r.dayShape as DayShape,
      reversalAtMin: r.reversalAtMin,
      bars: r.barsJson as Bar[],
    });
  }
  return out;
}

/** True if this session is already captured — lets the nightly job no-op instead of re-fetching. */
export async function hasDayStats(date: string, ticker: string): Promise<boolean> {
  const rows = await db.select({ id: intradayDayStats.id }).from(intradayDayStats)
    .where(and(eq(intradayDayStats.date, date), eq(intradayDayStats.ticker, ticker))).limit(1);
  return rows.length > 0;
}

/**
 * Captures today's completed session for every tracked symbol. Called by the
 * nightly job after the close; safe to re-run.
 */
export async function captureSession(date: string): Promise<{ captured: string[]; skipped: string[] }> {
  const captured: string[] = [];
  const skipped: string[] = [];

  for (const ticker of TRACKED_SYMBOLS) {
    try {
      // 5 days back is enough to include today plus a long weekend, and keeps the
      // payload small — this runs daily, unlike the 60-day backfill.
      const sessions = await fetchIntradayHistory(ticker, 5);
      const bars = sessions.get(date);
      if (!bars) { skipped.push(ticker); continue; }
      const stats = classifyDay(ticker, date, bars);
      if (!stats) { skipped.push(ticker); continue; }
      await saveDayStats(stats);
      captured.push(ticker);
    } catch (err) {
      logger.warn({ err, ticker, date }, "intraday-history: session capture failed");
      skipped.push(ticker);
    }
  }

  logger.info({ date, captured, skipped }, "intraday-history: session capture complete");
  return { captured, skipped };
}
