// Per-ticker intraday entry timing for the Live tab Opportunities table.
//
// Runs the same OR-breakout/VWAP/pullback/sweep composite the regime banner
// applies to SPY/QQQ against each hotlist ticker, adds a 5-min fair-value-gap
// read, and combines the result with the latest resolved regime checkpoint
// into an entry verdict for the put-sell workflow: the daily scanner finds
// oversold candidates, this answers "is the reversal actually firing NOW".
//
// Red flags come from ticker_technicals (already computed nightly — not
// recomputed here): fallingKnife forces Avoid, earnings within 5 days caps the
// verdict at Wait. Daily bullish RSI divergence is computed here (nothing else
// in the codebase computes divergence) as an informational factor only — it
// does not steer the verdict until outcome tracking proves it should.
//
// Every snapshot is also appended to a per-day history key so forward returns
// can later grade whether Enter actually outperforms Wait (see /live/entry-stats).
import { RSI } from "technicalindicators";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, appConfig, pricesHistorical } from "@workspace/db";
import { etDateKey } from "./market-hours.js";
import { liveHotlist } from "./live-hotlist.js";
import { readOHLCVFromDB } from "./indicators.js";
import { getAllTechnicalsRows } from "./technicals-db.js";
import {
  fetchTodaysBars,
  computeSymbolSignal,
  getTodaysCheckpoints,
  symbolFactorLine,
  type Bar,
  type Direction,
} from "./intraday-regime.js";
import { logger } from "./logger.js";

const FETCH_CONCURRENCY = 5; // hotlist is ≤46 tickers; chunked Yahoo chart calls, at most once per checkpoint
const EARNINGS_CAUTION_DAYS = 5; // selling a put through earnings is a different trade — cap verdict at Wait

export type EntryVerdict = "enter" | "wait" | "avoid";

export interface FvgZone {
  type: "bullish" | "bearish";
  top: number;
  bottom: number;
  /** Price is currently retracing inside the unfilled gap — for a bullish gap this is the classic entry moment. */
  inZone: boolean;
}

export interface EntrySignal {
  ticker: string;
  /** Last 5-min close at compute time — the reference price for forward-return grading. */
  price: number;
  direction: Direction | null;
  score: number;
  verdict: EntryVerdict;
  fvg: FvgZone | null;
  /** One line per input that fed the verdict — same convention as the regime banner popover. */
  factors: string[];
}

export interface EntrySignalsSnapshot {
  computedAt: number;
  /** The checkpoint whose resolution triggered this compute, for display ("as of 7:30 AM PT"). */
  afterCheckpointMin: number | null;
  regimeDirection: Direction | null;
  regimeConfidence: number | null;
  signals: EntrySignal[];
}

/** Nightly-computed red flags per ticker, read from ticker_technicals — never recomputed here. */
interface RedFlags {
  fallingKnife: boolean;
  earningsDaysOut: number | null;
}

// 3-candle fair value gap on 5-min bars: bullish when bar i's low sits fully
// above bar i-2's high (the displacement candle left an untraded zone).
// Scans newest-first and returns the most recent still-unfilled gap — the
// tradeable moment is the retrace INTO that zone, not the gap itself.
export function findActiveFvg(bars: Bar[]): FvgZone | null {
  if (bars.length < 3) return null;
  const lastClose = bars[bars.length - 1].close;
  for (let i = bars.length - 1; i >= 2; i--) {
    const after = bars.slice(i + 1);
    const bullBottom = bars[i - 2].high;
    const bullTop = bars[i].low;
    if (bullTop > bullBottom && !after.some(b => b.low <= bullBottom)) {
      return { type: "bullish", top: bullTop, bottom: bullBottom, inZone: lastClose >= bullBottom && lastClose <= bullTop };
    }
    const bearTop = bars[i - 2].low;
    const bearBottom = bars[i].high;
    if (bearBottom < bearTop && !after.some(b => b.high >= bearTop)) {
      return { type: "bearish", top: bearTop, bottom: bearBottom, inZone: lastClose >= bearBottom && lastClose <= bearTop };
    }
  }
  return null;
}

// Daily bullish RSI divergence: price made a lower low in the recent 15
// sessions vs. the 15 before, but RSI at that low is meaningfully higher —
// selling pressure fading into the new low. Informational factor only.
export function bullishRsiDivergence(closes: number[]): boolean {
  if (closes.length < 45) return false;
  const rsiVals = RSI.calculate({ period: 14, values: closes });
  const aligned = closes.slice(closes.length - rsiVals.length);
  const n = aligned.length;
  if (n < 30) return false;
  const recent = aligned.slice(n - 15);
  const prior = aligned.slice(n - 30, n - 15);
  const recentRsi = rsiVals.slice(n - 15);
  const priorRsi = rsiVals.slice(n - 30, n - 15);
  const iR = recent.indexOf(Math.min(...recent));
  const iP = prior.indexOf(Math.min(...prior));
  return recent[iR] < prior[iP] && recentRsi[iR] > priorRsi[iP] + 2;
}

function verdictFor(direction: Direction | null, regime: Direction | null, fvg: FvgZone | null, flags: RedFlags): { verdict: EntryVerdict; why: string } {
  if (flags.fallingKnife) return { verdict: "avoid", why: "falling knife — >2 ATR below both MAs with MACD falling (nightly technicals flag)" };
  if (direction === "bearish") return { verdict: "avoid", why: "ticker is trading bearish intraday" };
  if (regime === "bearish") return { verdict: "avoid", why: "market regime is bearish — don't fight the tape" };

  const earningsSoon = flags.earningsDaysOut != null && flags.earningsDaysOut >= 0 && flags.earningsDaysOut <= EARNINGS_CAUTION_DAYS;
  if (earningsSoon) return { verdict: "wait", why: `earnings in ${flags.earningsDaysOut}d — selling a put through earnings is a different trade` };

  if (direction === "bullish" && regime === "bullish") return { verdict: "enter", why: "ticker bullish and market regime agrees" };
  // The FVG retrace is itself an entry trigger when the ticker leans bullish and the tape isn't against it.
  if (direction === "bullish" && fvg?.type === "bullish" && fvg.inZone) {
    return { verdict: "enter", why: "bullish and price is retracing inside an unfilled fair-value gap" };
  }
  if (direction === "bullish") return { verdict: "wait", why: "ticker bullish but market regime hasn't confirmed" };
  return { verdict: "wait", why: "no intraday lean yet" };
}

function fvgFactorLine(fvg: FvgZone | null): string | null {
  if (!fvg) return null;
  const zone = `${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)}`;
  if (fvg.inZone) return `Price inside unfilled ${fvg.type} FVG (${zone})${fvg.type === "bullish" ? " — classic entry retrace" : " — supply overhead"}`;
  return `Unfilled ${fvg.type} FVG at ${zone}`;
}

function configKey(dateKey: string): string {
  return `intraday_entry_signals_${dateKey}`;
}

function historyKey(dateKey: string): string {
  return `entry_signal_history_${dateKey}`;
}

async function computeOne(ticker: string, regime: Direction | null, flags: RedFlags): Promise<EntrySignal | null> {
  // One DB read per ticker: last row = prior day's H/L, close series feeds divergence.
  const [bars, dailyRows] = await Promise.all([fetchTodaysBars(ticker), readOHLCVFromDB(ticker)]);
  const prior = dailyRows[dailyRows.length - 1];
  const sig = computeSymbolSignal(ticker, bars, prior?.high ?? null, prior?.low ?? null);
  if (!sig) return null;
  const price = bars[bars.length - 1].close;
  const fvg = findActiveFvg(bars);
  const divergence = bullishRsiDivergence(dailyRows.map(r => r.close));
  const { verdict, why } = verdictFor(sig.direction, regime, fvg, flags);

  const factors = [symbolFactorLine(ticker, sig)];
  const fvgLine = fvgFactorLine(fvg);
  if (fvgLine) factors.push(fvgLine);
  if (divergence) factors.push("Daily bullish RSI divergence — lower price low, higher RSI low (informational)");
  if (flags.fallingKnife) factors.push("⚠ Falling knife flag from nightly technicals");
  if (flags.earningsDaysOut != null && flags.earningsDaysOut >= 0 && flags.earningsDaysOut <= EARNINGS_CAUTION_DAYS) {
    factors.push(`⚠ Earnings in ${flags.earningsDaysOut} day${flags.earningsDaysOut === 1 ? "" : "s"}`);
  }
  factors.push(regime ? `Market regime: ${regime}` : "Market regime: no call yet");
  factors.push(`Verdict: ${verdict.toUpperCase()} — ${why}`);

  return { ticker, price, direction: sig.direction, score: sig.score, verdict, fvg, factors };
}

/** Recomputes entry signals for every hotlist ticker and persists today's snapshot (+history). Called by the scheduler after a regime checkpoint resolves. */
export async function runEntrySignals(): Promise<void> {
  const dateKey = etDateKey();
  const [checkpoints, technicalsRows] = await Promise.all([getTodaysCheckpoints(), getAllTechnicalsRows()]);
  const latest = [...checkpoints].reverse().find(c => c.status === "resolved" && c.direction != null) ?? null;
  const regimeDirection = latest?.direction ?? null;

  const flagsByTicker = new Map<string, RedFlags>(technicalsRows.map(r => [r.ticker, {
    fallingKnife: r.fallingKnife === 1,
    earningsDaysOut: r.earningsDaysOut ?? null,
  }]));
  const noFlags: RedFlags = { fallingKnife: false, earningsDaysOut: null };

  const tickers = liveHotlist.getCurrentEntries().map(e => e.ticker);
  const signals: EntrySignal[] = [];
  for (let i = 0; i < tickers.length; i += FETCH_CONCURRENCY) {
    const chunk = tickers.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(t => computeOne(t, regimeDirection, flagsByTicker.get(t) ?? noFlags)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled" && r.value) signals.push(r.value);
      else if (r.status === "rejected") logger.warn({ ticker: chunk[j], err: String(r.reason) }, "entry-signals: ticker compute failed");
    });
  }

  const snapshot: EntrySignalsSnapshot = {
    computedAt: Date.now(),
    afterCheckpointMin: latest?.minAfterOpen ?? null,
    regimeDirection,
    regimeConfidence: latest?.confidence ?? null,
    signals,
  };

  await upsertConfig(configKey(dateKey), snapshot);
  await appendHistory(dateKey, snapshot);
  logger.info({ dateKey, tickers: signals.length, regimeDirection }, "entry-signals: snapshot recorded");
}

async function upsertConfig(key: string, value: unknown): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) await db.insert(appConfig).values({ key, value });
  else await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
}

async function appendHistory(dateKey: string, snapshot: EntrySignalsSnapshot): Promise<void> {
  const key = historyKey(dateKey);
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  const existing = (rows[0]?.value as { snapshots?: EntrySignalsSnapshot[] } | undefined)?.snapshots ?? [];
  await upsertConfig(key, { snapshots: [...existing, snapshot] });
}

/** Today's persisted snapshot, or null before the first checkpoint resolves. */
export async function getTodaysEntrySignals(): Promise<EntrySignalsSnapshot | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, configKey(etDateKey()))).limit(1);
  return (rows[0]?.value as EntrySignalsSnapshot | undefined) ?? null;
}

/** Last `days` of history keys (dateKey → the day's final snapshot). Used for forward-return grading. */
export async function getEntrySignalHistory(days: number): Promise<Map<string, EntrySignalsSnapshot>> {
  const keys: string[] = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    keys.push(historyKey(etDateKey(d)));
    d.setDate(d.getDate() - 1);
  }
  const rows = await db.select().from(appConfig).where(inArray(appConfig.key, keys));
  const out = new Map<string, EntrySignalsSnapshot>();
  for (const row of rows) {
    const snapshots = (row.value as { snapshots?: EntrySignalsSnapshot[] }).snapshots ?? [];
    const last = snapshots[snapshots.length - 1];
    // Grade each day by its LAST snapshot — the most informed verdict of the day.
    if (last) out.set(row.key.slice("entry_signal_history_".length), last);
  }
  return out;
}

export interface VerdictStats {
  n: number;
  avgFwd1dPct: number | null;
  avgFwd5dPct: number | null;
}

export interface EntryStatsResponse {
  days: number;
  gradedDays: number;
  perVerdict: Record<EntryVerdict, VerdictStats>;
}

/**
 * Forward-return grading of past verdicts: for each history day's final
 * snapshot, compare each ticker's signal price to its next 1 and 5 daily
 * closes from prices_historical. This is the accountability layer — it exists
 * to answer "does Enter actually beat Wait" before any weight gets trusted.
 */
export async function computeEntryStats(days = 30): Promise<EntryStatsResponse> {
  const history = await getEntrySignalHistory(days);
  const emptyStats = (): { sum1: number; n1: number; sum5: number; n5: number; n: number } => ({ sum1: 0, n1: 0, sum5: 0, n5: 0, n: 0 });
  const acc: Record<EntryVerdict, ReturnType<typeof emptyStats>> = { enter: emptyStats(), wait: emptyStats(), avoid: emptyStats() };

  if (history.size > 0) {
    const tickers = [...new Set([...history.values()].flatMap(s => s.signals.map(sig => sig.ticker)))];
    const oldestDate = [...history.keys()].sort()[0];
    const priceRows = tickers.length > 0
      ? await db.select({ ticker: pricesHistorical.ticker, date: pricesHistorical.date, close: pricesHistorical.close })
          .from(pricesHistorical)
          .where(and(inArray(pricesHistorical.ticker, tickers), gte(pricesHistorical.date, oldestDate)))
          .orderBy(pricesHistorical.ticker, pricesHistorical.date)
      : [];
    const closesByTicker = new Map<string, Array<{ date: string; close: number }>>();
    for (const r of priceRows) {
      if (r.close == null) continue;
      const arr = closesByTicker.get(r.ticker) ?? [];
      arr.push({ date: r.date, close: parseFloat(r.close as string) });
      closesByTicker.set(r.ticker, arr);
    }

    for (const [dateKey, snapshot] of history) {
      for (const sig of snapshot.signals) {
        if (!(sig.price > 0)) continue;
        const series = closesByTicker.get(sig.ticker);
        if (!series) continue;
        const idx = series.findIndex(p => p.date > dateKey); // first trading day AFTER the signal day
        const a = acc[sig.verdict];
        a.n += 1;
        if (idx !== -1) {
          a.sum1 += (series[idx].close / sig.price - 1) * 100;
          a.n1 += 1;
          const idx5 = idx + 4;
          if (idx5 < series.length) {
            a.sum5 += (series[idx5].close / sig.price - 1) * 100;
            a.n5 += 1;
          }
        }
      }
    }
  }

  const round = (v: number): number => Math.round(v * 100) / 100;
  const toStats = (a: ReturnType<typeof emptyStats>): VerdictStats => ({
    n: a.n,
    avgFwd1dPct: a.n1 > 0 ? round(a.sum1 / a.n1) : null,
    avgFwd5dPct: a.n5 > 0 ? round(a.sum5 / a.n5) : null,
  });
  return {
    days,
    gradedDays: history.size,
    perVerdict: { enter: toStats(acc.enter), wait: toStats(acc.wait), avoid: toStats(acc.avoid) },
  };
}
