// 1–2-week market put risk (S130, Jamie 10-28) — the daily half of the Live regime read.
//
// S130 tested the 8 TradingView regime detectors + classic regime signals on 33 years of SPY/QQQ/IWM/DIA daily
// bars. None calls 5/10-day direction out of sample (AUC 0.50–0.52). What does repeat in both halves is
// how often a VIX-sized put (≈ 0.16Δ) gets breached. Three flags, each passing on its own:
//   realised vol (20 d) > VIX   — no variance premium: strikes sized by implied vol are too close (t 5.7 / 3.5)
//   ATR percentile (1 y) > 80   — volatility clusters (forexobroker "volatile" regime)
//   efficiency ratio (20 d) < 0.4 — choppy tape (KK / StrixEDGE); ER > 0.4 cut breaches 12.8 → 7.4 %
// 5-day breach of a VIX-sized put by flag count (1993–2009 / 2010–26): 0 → 6.1 / 6.5 %, 1 → 10 / 10 %,
// 2 → 18 / 13 %, 3 → 20 / 16 %. Inputs use closes through the prior session only.
import { and, desc, eq, lt } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";
import { yahooFinance } from "./yahoo-client.js";
import { logger } from "./logger.js";

export type WeekRiskLevel = "low" | "normal" | "elevated" | "high";

export interface WeekPutRisk {
  flags: number;
  level: WeekRiskLevel;
  /** S130 pooled 5-day breach rate of a VIX-sized put at this flag count. */
  pBreach5d: number;
  vix: number;
  rv20: number;
  atrPct: number;
  er20: number;
  asOf: string;
}

const LEVELS: WeekRiskLevel[] = ["low", "normal", "elevated", "high"];
const P_BREACH = [0.064, 0.10, 0.152, 0.175];
const VENDOR_DEADLINE_MS = 8_000;

const memo = new Map<string, WeekPutRisk | null>();

/** Wilder's moving average, same as Pine `ta.rma` and the S130 script. */
function rma(xs: number[], n: number): number[] {
  const out: number[] = [];
  let prev = xs[0];
  for (const x of xs) { prev = out.length === 0 ? x : prev + (x - prev) / n; out.push(prev); }
  return out;
}

export function computeWeekPutRisk(bars: { high: number; low: number; close: number; date: string }[], vix: number): WeekPutRisk | null {
  if (bars.length < 280 || !(vix > 0)) return null;
  const c = bars.map(b => b.close);
  const tr = bars.map((b, i) => i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1]), Math.abs(b.low - c[i - 1])));
  const atr = rma(tr, 14).map((a, i) => a / c[i]);
  const window = atr.slice(-252);
  const last = window[window.length - 1];
  const atrPct = window.filter(a => a <= last).length / window.length;
  const n = c.length - 1;
  let path = 0;
  for (let i = n - 19; i <= n; i++) path += Math.abs(c[i] - c[i - 1]);
  const er20 = path > 0 ? Math.abs(c[n] - c[n - 20]) / path : 0;
  const lr = c.slice(-21).map((x, i, a) => i === 0 ? 0 : Math.log(x / a[i - 1])).slice(1);
  const mean = lr.reduce((s, x) => s + x, 0) / lr.length;
  const rv20 = Math.sqrt(lr.reduce((s, x) => s + (x - mean) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252) * 100;
  const flags = Number(rv20 > vix) + Number(atrPct > 0.8) + Number(er20 < 0.4);
  return { flags, level: LEVELS[flags], pBreach5d: P_BREACH[flags], vix, rv20, atrPct, er20, asOf: bars[n].date };
}

/** Once per session date; never throws (null = unavailable, the banner just omits it). */
export async function weekPutRisk(dateKey: string): Promise<WeekPutRisk | null> {
  if (memo.has(dateKey)) return memo.get(dateKey)!;
  try {
    const rows = await db.select({ date: pricesHistorical.date, high: pricesHistorical.high, low: pricesHistorical.low, close: pricesHistorical.close })
      .from(pricesHistorical)
      .where(and(eq(pricesHistorical.ticker, "SPY"), lt(pricesHistorical.date, dateKey)))
      .orderBy(desc(pricesHistorical.date))
      .limit(320);
    const bars = rows.map(r => ({ date: String(r.date), high: Number(r.high), low: Number(r.low), close: Number(r.close) })).reverse();
    const period1 = new Date(Date.now() - 20 * 86_400_000);
    const chart = await Promise.race([
      yahooFinance.chart("^VIX", { period1, interval: "1d" }, { validateResult: false }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("vix deadline")), VENDOR_DEADLINE_MS)),
    ]) as { quotes?: Array<{ date: string | Date; close: number | null }> };
    const prior = (chart.quotes ?? [])
      .filter(q => q.close != null && new Date(q.date).toISOString().slice(0, 10) < dateKey)
      .pop();
    const out = computeWeekPutRisk(bars, prior?.close ?? NaN);
    memo.set(dateKey, out);
    return out;
  } catch (err) {
    logger.warn({ err: String(err), dateKey }, "market-put-risk: unavailable");
    return null; // not memoised — the next checkpoint retries
  }
}
