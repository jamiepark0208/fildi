// Intraday trend-day-vs-reversal-day regime banner (Live tab).
//
// Samples SPY/QQQ at fixed checkpoints after the open instead of continuous
// tick monitoring — the composite mirrors what intraday traders check by eye
// (opening-range breakout hold/fail, VWAP separation, pullback depth, a
// lightweight liquidity-sweep analog on prior-day H/L) without the
// execution-grade machinery (FVG entries, market-structure-shift confirmation,
// tick-level scanning) that a put-selling dashboard doesn't need.
import YahooFinanceClass from "yahoo-finance2";
import { eq } from "drizzle-orm";
import { db, appConfig } from "@workspace/db";
import { readOHLCVFromDB } from "./indicators.js";
import { getLivePrices } from "./live-quote.js";
import { liveHotlist, MARKET_CONTEXT_SYMBOLS } from "./live-hotlist.js";
import { etDateKey, getMarketOpenUtc } from "./market-hours.js";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

// Every 15 min through the first hour (when trend-vs-reversal usually resolves),
// every 30 min after that through midday — no point in 15-min granularity once
// a trend is established.
export const CHECKPOINTS_MIN = [15, 30, 45, 60, 90, 120, 150, 180] as const;

// A checkpoint computed more than this long after its target time (e.g. the
// server was down or just restarted) is reconstructed from historically-sliced
// bars for SPY/QQQ, but hotlist breadth has no historical snapshot to fall
// back on — skip it rather than silently mislabeling "now" breadth as
// as-of-checkpoint breadth.
const LATE_THRESHOLD_MS = 5 * 60 * 1000;

// Throttles retries on persistent fetch failure (e.g. Yahoo Finance outage) so a
// broken checkpoint doesn't hammer the API and spam error logs every 60s tick.
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const lastFailureAt = new Map<string, number>();

type Breakout = "holding-up" | "holding-down" | "failed-up" | "failed-down" | "inside";
type Direction = "bullish" | "bearish" | "mixed";

interface SymbolSignal {
  ticker: string;
  orHigh: number;
  orLow: number;
  breakout: Breakout;
  vwap: number;
  vwapSepPct: number;
  pullbackPct: number;
  priorDaySweep: "bullish-reclaim" | "bearish-reclaim" | null;
  direction: Direction | null;
  score: number; // 0-100, magnitude of the winning direction
}

export interface RegimeCheckpoint {
  minAfterOpen: number;
  timestamp: number;
  status: "pending" | "resolved";
  direction: Direction | null;
  confidence: number | null;
  spy: SymbolSignal | null;
  qqq: SymbolSignal | null;
  breadth: { agree: number; total: number } | null;
  /** Wall-clock label for this checkpoint's target time, e.g. "6:45 AM PT". */
  label: string;
  /** True if this checkpoint ran well after its target time (catch-up after downtime) — breadth is omitted since it has no historical snapshot. */
  computedLate: boolean;
  /** Concise factor/value lines that drove the direction/confidence call — one per input. */
  factors: string[];
}

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchTodaysBars(ticker: string): Promise<Bar[]> {
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const period1 = new Date(etNow);
  period1.setHours(9, 30, 0, 0);
  const offsetMs = now.getTime() - etNow.getTime();
  const period1Utc = new Date(period1.getTime() + offsetMs);

  const result = await yahooFinance.chart(ticker, { period1: period1Utc, interval: "5m" }, { validateResult: false }) as unknown as {
    quotes?: Array<{ date: string | Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null }>;
  };
  const quotes = result?.quotes ?? [];
  return quotes
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
    .map(q => ({
      time: new Date(q.date).getTime(),
      open: q.open as number,
      high: q.high as number,
      low: q.low as number,
      close: q.close as number,
      volume: q.volume ?? 0,
    }));
}

function computeSymbolSignal(ticker: string, bars: Bar[], priorHigh: number | null, priorLow: number | null): SymbolSignal | null {
  if (bars.length === 0) return null;

  const orBars = bars.slice(0, 3); // first 15 min = first three 5-min bars
  const afterOR = bars.slice(3);
  const orHigh = Math.max(...orBars.map(b => b.high));
  const orLow = Math.min(...orBars.map(b => b.low));
  const lastClose = bars[bars.length - 1].close;

  let breakout: Breakout = "inside";
  if (afterOR.length > 0) {
    const maxHighAfter = Math.max(orHigh, ...afterOR.map(b => b.high));
    const minLowAfter = Math.min(orLow, ...afterOR.map(b => b.low));
    const brokeUp = maxHighAfter > orHigh;
    const brokeDown = minLowAfter < orLow;
    if (brokeUp && lastClose > orHigh) breakout = "holding-up";
    else if (brokeUp) breakout = "failed-up";
    else if (brokeDown && lastClose < orLow) breakout = "holding-down";
    else if (brokeDown) breakout = "failed-down";
  }

  const totalVol = bars.reduce((s, b) => s + b.volume, 0);
  const vwap = totalVol > 0
    ? bars.reduce((s, b) => s + b.close * b.volume, 0) / totalVol
    : bars.reduce((s, b) => s + b.close, 0) / bars.length;
  const vwapSepPct = ((lastClose - vwap) / vwap) * 100;

  const firstOpen = bars[0].open;
  const overallUp = lastClose >= firstOpen;
  let pullbackPct: number;
  if (overallUp) {
    const extreme = Math.max(...bars.map(b => b.high));
    const drive = extreme - firstOpen;
    pullbackPct = drive > 0 ? ((extreme - lastClose) / drive) * 100 : 0;
  } else {
    const extreme = Math.min(...bars.map(b => b.low));
    const drive = firstOpen - extreme;
    pullbackPct = drive > 0 ? ((lastClose - extreme) / drive) * 100 : 0;
  }

  const todayHigh = Math.max(...bars.map(b => b.high));
  const todayLow = Math.min(...bars.map(b => b.low));
  let priorDaySweep: SymbolSignal["priorDaySweep"] = null;
  if (priorLow != null && todayLow < priorLow && lastClose > priorLow) priorDaySweep = "bullish-reclaim";
  else if (priorHigh != null && todayHigh > priorHigh && lastClose < priorHigh) priorDaySweep = "bearish-reclaim";

  // Weighted composite: breakout 35 / VWAP separation 30 / pullback depth 20 / prior-day sweep 15.
  let bullish = 0;
  let bearish = 0;

  if (breakout === "holding-up") bullish += 35;
  else if (breakout === "failed-up") bearish += 35;
  else if (breakout === "holding-down") bearish += 35;
  else if (breakout === "failed-down") bullish += 35;

  const VWAP_THRESHOLD = 0.3;
  if (vwapSepPct > VWAP_THRESHOLD) bullish += 30 * Math.min(1, vwapSepPct / (VWAP_THRESHOLD * 2));
  else if (vwapSepPct < -VWAP_THRESHOLD) bearish += 30 * Math.min(1, -vwapSepPct / (VWAP_THRESHOLD * 2));

  if (afterOR.length > 0) {
    const trendWeight = pullbackPct <= 50
      ? 20 * (1 - pullbackPct / 50)
      : 0;
    const fadeWeight = pullbackPct > 50
      ? 20 * ((pullbackPct - 50) / 50)
      : 0;
    if (overallUp) { bullish += trendWeight; bearish += fadeWeight; }
    else { bearish += trendWeight; bullish += fadeWeight; }
  }

  if (priorDaySweep === "bullish-reclaim") bullish += 15;
  else if (priorDaySweep === "bearish-reclaim") bearish += 15;

  const MAX_POINTS = 35 + 30 + 20 + 15;
  let direction: Direction | null = null;
  let score = 0;
  if (bullish > bearish) { direction = "bullish"; score = Math.round((bullish / MAX_POINTS) * 100); }
  else if (bearish > bullish) { direction = "bearish"; score = Math.round((bearish / MAX_POINTS) * 100); }

  return { ticker, orHigh, orLow, breakout, vwap, vwapSepPct, pullbackPct, priorDaySweep, direction, score };
}

async function getPriorDayHighLow(ticker: string): Promise<{ high: number | null; low: number | null }> {
  try {
    const rows = await readOHLCVFromDB(ticker);
    const prior = rows[rows.length - 1];
    return { high: prior?.high ?? null, low: prior?.low ?? null };
  } catch (err) {
    logger.warn({ err, ticker }, "intraday-regime: prior-day H/L lookup failed");
    return { high: null, low: null };
  }
}

function combine(spy: SymbolSignal | null, qqq: SymbolSignal | null): { direction: Direction | null; confidence: number | null } {
  if (!spy?.direction && !qqq?.direction) return { direction: null, confidence: null };
  if (spy?.direction && qqq?.direction) {
    if (spy.direction === qqq.direction) {
      return { direction: spy.direction, confidence: Math.round((spy.score + qqq.score) / 2) };
    }
    return { direction: "mixed", confidence: Math.round(Math.min(spy.score, qqq.score) * 0.5) };
  }
  const only = spy?.direction ? spy : qqq;
  return { direction: only!.direction, confidence: only!.score };
}

async function computeBreadth(direction: Direction | null): Promise<{ agree: number; total: number } | null> {
  if (!direction || direction === "mixed") return null;
  const tickers = liveHotlist.getCurrent().filter(t => !MARKET_CONTEXT_SYMBOLS.includes(t));
  if (tickers.length === 0) return null;
  const live = await getLivePrices(tickers);
  let agree = 0;
  let total = 0;
  for (const t of tickers) {
    const cp = live.get(t)?.changePercent;
    if (cp == null) continue;
    total += 1;
    const tickerDir: Direction = cp >= 0 ? "bullish" : "bearish";
    if (tickerDir === direction) agree += 1;
  }
  return total > 0 ? { agree, total } : null;
}

// Same 9:30 ET math as getMarketOpenUtc, but without the trading-day gate — used
// only for display labels, which should still show a plausible time on weekends/holidays.
function nominalMarketOpenUtc(now: Date = new Date()): Date {
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offsetMs = now.getTime() - etNow.getTime();
  const openEt = new Date(etNow);
  openEt.setHours(9, 30, 0, 0);
  return new Date(openEt.getTime() + offsetMs);
}

function checkpointLabel(marketOpenUtc: Date, minAfterOpen: number): string {
  const t = new Date(marketOpenUtc.getTime() + minAfterOpen * 60_000);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
  return `${formatted} PT`;
}

const BREAKOUT_TEXT: Record<Breakout, string> = {
  "holding-up": "holding above the opening range",
  "holding-down": "holding below the opening range",
  "failed-up": "broke above the range but failed back inside",
  "failed-down": "broke below the range but failed back inside",
  "inside": "still inside the opening range",
};

function symbolFactorLine(ticker: string, sig: SymbolSignal | null): string {
  if (!sig) return `${ticker}: no data`;
  const bits = [BREAKOUT_TEXT[sig.breakout]];
  if (Math.abs(sig.vwapSepPct) > 0.05) {
    bits.push(`${sig.vwapSepPct >= 0 ? "+" : ""}${sig.vwapSepPct.toFixed(2)}% VWAP`);
  }
  if (sig.priorDaySweep) {
    bits.push(sig.priorDaySweep === "bullish-reclaim" ? "swept prior low, reclaimed" : "swept prior high, reclaimed");
  }
  const dirLabel = sig.direction ? `${sig.direction} ${sig.score}` : "no lean";
  return `${ticker}: ${bits.join(", ")} — ${dirLabel}`;
}

/** Concise factor/value breakdown — "Mixed (18%)" alone doesn't say which way, or why. One line per input that fed the call. */
function explainCheckpoint(args: {
  spy: SymbolSignal | null;
  qqq: SymbolSignal | null;
  direction: Direction | null;
  confidence: number | null;
  breadth: { agree: number; total: number } | null;
  isBaselineOnly: boolean;
}): string[] {
  const { spy, qqq, direction, confidence, breadth, isBaselineOnly } = args;
  if (isBaselineOnly) return ["Opening range established (first 15 min) — no directional call yet."];

  const lines = [symbolFactorLine("SPY", spy), symbolFactorLine("QQQ", qqq)];
  if (breadth) lines.push(`Breadth: ${breadth.agree}/${breadth.total} hotlist tickers agree`);

  if (direction === "mixed") lines.push(`Verdict: Mixed, ${confidence ?? 0}% — SPY/QQQ disagree`);
  else if (direction) lines.push(`Verdict: ${direction === "bullish" ? "Bullish" : "Bearish"}, ${confidence ?? 0}% — indices agree`);
  else lines.push("Verdict: no lean yet");

  return lines;
}

function configKey(dateKey: string): string {
  return `intraday_regime_${dateKey}`;
}

// Normalizes checkpoints persisted under an older shape of this feature (e.g. a
// pre-rename `explanation: string` instead of `factors: string[]`, or missing
// `label`/`computedLate` from before those fields existed) so a mid-day schema
// change doesn't crash every consumer that trusts the current RegimeCheckpoint type.
function normalizeCheckpoint(raw: RegimeCheckpoint & { explanation?: string }, openUtc: Date): RegimeCheckpoint {
  return {
    ...raw,
    label: raw.label ?? checkpointLabel(openUtc, raw.minAfterOpen),
    computedLate: raw.computedLate ?? false,
    factors: raw.factors ?? (raw.explanation ? [raw.explanation] : ["Recorded under an older format — no factor breakdown available."]),
  };
}

async function loadCheckpoints(dateKey: string): Promise<RegimeCheckpoint[]> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, configKey(dateKey))).limit(1);
  const value = rows[0]?.value as { checkpoints?: RegimeCheckpoint[] } | undefined;
  const checkpoints = value?.checkpoints ?? [];
  const openUtc = getMarketOpenUtc() ?? nominalMarketOpenUtc();
  return checkpoints.map(c => normalizeCheckpoint(c, openUtc));
}

async function saveCheckpoints(dateKey: string, checkpoints: RegimeCheckpoint[]): Promise<void> {
  const key = configKey(dateKey);
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  const value = { checkpoints };
  if (existing.length === 0) await db.insert(appConfig).values({ key, value });
  else await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
}

/** Runs (or re-runs, idempotently overwriting) the checkpoint for minAfterOpen if not already recorded today. */
export async function runCheckpoint(minAfterOpen: number): Promise<void> {
  const dateKey = etDateKey();
  const failureKey = `${dateKey}:${minAfterOpen}`;
  const existing = await loadCheckpoints(dateKey);
  if (existing.some(c => c.minAfterOpen === minAfterOpen)) return;

  const lastFailure = lastFailureAt.get(failureKey);
  if (lastFailure != null && Date.now() - lastFailure < FAILURE_BACKOFF_MS) {
    logger.debug({ dateKey, minAfterOpen }, "intraday-regime: skipping checkpoint, still in failure backoff window");
    return;
  }

  const marketOpenUtc = getMarketOpenUtc();
  if (!marketOpenUtc) return; // scheduler already gates on isMarketOpen(); defensive only.
  const targetTimestamp = marketOpenUtc.getTime() + minAfterOpen * 60_000;
  const isLate = Date.now() - targetTimestamp > LATE_THRESHOLD_MS;

  logger.info({ dateKey, minAfterOpen, isLate }, "intraday-regime: running checkpoint");

  try {
    const [spyBarsAll, qqqBarsAll, spyPrior, qqqPrior] = await Promise.all([
      fetchTodaysBars("SPY"),
      fetchTodaysBars("QQQ"),
      getPriorDayHighLow("SPY"),
      getPriorDayHighLow("QQQ"),
    ]);

    // Slice to bars at/before this checkpoint's target time — even when this
    // runs late (e.g. a restart caught up on several thresholds at once), each
    // checkpoint is reconstructed from the data as it stood at ITS time, not
    // from whatever "now" happens to be. Without this, a late catch-up run
    // computes every overdue checkpoint from the same current-moment bars,
    // making them all show the same result.
    const spyBars = spyBarsAll.filter(b => b.time <= targetTimestamp);
    const qqqBars = qqqBarsAll.filter(b => b.time <= targetTimestamp);

    const spy = computeSymbolSignal("SPY", spyBars, spyPrior.high, spyPrior.low);
    const qqq = computeSymbolSignal("QQQ", qqqBars, qqqPrior.high, qqqPrior.low);

    // The 15-min checkpoint is when the opening range itself closes — no
    // breakout is possible yet, so report the OR baseline without a directional call.
    const isBaselineOnly = minAfterOpen === 15;
    const { direction, confidence } = isBaselineOnly ? { direction: null, confidence: null } : combine(spy, qqq);
    // Hotlist breadth has no historical snapshot — only meaningful when computed
    // close to the checkpoint's actual time, not reconstructed after the fact.
    const breadthRaw = (isBaselineOnly || isLate) ? null : await computeBreadth(direction);

    let finalConfidence = confidence;
    if (breadthRaw && confidence != null) {
      const ratio = breadthRaw.agree / breadthRaw.total;
      finalConfidence = Math.max(0, Math.min(100, Math.round(confidence + (ratio - 0.5) * 20)));
    }

    const checkpoint: RegimeCheckpoint = {
      minAfterOpen,
      timestamp: Date.now(),
      status: "resolved",
      direction,
      confidence: finalConfidence,
      spy,
      qqq,
      breadth: breadthRaw,
      label: checkpointLabel(marketOpenUtc, minAfterOpen),
      computedLate: isLate,
      factors: explainCheckpoint({ spy, qqq, direction, confidence: finalConfidence, breadth: breadthRaw, isBaselineOnly }),
    };

    await saveCheckpoints(dateKey, [...existing, checkpoint]);
    lastFailureAt.delete(failureKey);
    logger.info({ dateKey, minAfterOpen, direction, confidence: finalConfidence, isLate }, "intraday-regime: checkpoint recorded");
  } catch (err) {
    lastFailureAt.set(failureKey, Date.now());
    throw err;
  }
}

/** Today's checkpoints, padded with "pending" placeholders for slots not yet reached. */
export async function getTodaysCheckpoints(): Promise<RegimeCheckpoint[]> {
  const dateKey = etDateKey();
  const existing = await loadCheckpoints(dateKey);
  const byMin = new Map(existing.map(c => [c.minAfterOpen, c]));
  const openUtc = nominalMarketOpenUtc();
  return CHECKPOINTS_MIN.map(min => byMin.get(min) ?? {
    minAfterOpen: min,
    timestamp: 0,
    status: "pending" as const,
    direction: null,
    confidence: null,
    spy: null,
    qqq: null,
    breadth: null,
    label: checkpointLabel(openUtc, min),
    computedLate: false,
    factors: ["Not reached yet today."],
  });
}
