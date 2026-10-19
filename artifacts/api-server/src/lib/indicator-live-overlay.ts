/**
 * A83 — display-only live RSI/MFI overlay (from indicators.ts).
 */
import { and, eq, gte } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";
import {
  computeIndicators,
  type IndicatorResult,
  type OHLCVRow,
} from "./indicator-compute.js";
import { getLivePrices } from "./live-quote.js";

function cutoffStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 420);
  return d.toISOString().slice(0, 10);
}

async function readOHLCV(key: string): Promise<OHLCVRow[]> {
  const rows = await db.select({
    date: pricesHistorical.date,
    close: pricesHistorical.close,
    high: pricesHistorical.high,
    low: pricesHistorical.low,
    volume: pricesHistorical.volume,
  })
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, key), gte(pricesHistorical.date, cutoffStr())))
    .orderBy(pricesHistorical.date);
  return rows
    .filter((r) => r.close != null && r.high != null && r.low != null)
    .map((r) => ({
      close: Number(r.close),
      high: Number(r.high),
      low: Number(r.low),
      volume: r.volume != null ? Number(r.volume) : 0,
    }));
}

/** Display-only live overlay; never writes indicatorCache. */
export async function getLiveIndicatorOverlay(
  tickers: string[],
): Promise<Map<string, Pick<IndicatorResult, "rsi" | "mfi" | "stoch" | "macdCross" | "signal">>> {
  const result = new Map<string, Pick<IndicatorResult, "rsi" | "mfi" | "stoch" | "macdCross" | "signal">>();
  const keys = [...new Set(tickers.map((t) => t.toUpperCase()))];
  if (keys.length === 0) return result;

  const live = await getLivePrices(keys);

  await Promise.all(keys.map(async (key) => {
    const livePrice = live.get(key)?.price;
    if (livePrice == null) return;

    const rows = await readOHLCV(key);
    if (rows.length < 15) return;

    const last = rows[rows.length - 1]!;
    const liveRows: OHLCVRow[] = [...rows, {
      close: livePrice,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      volume: last.volume,
    }];

    try {
      const r = computeIndicators(key, liveRows);
      result.set(key, { rsi: r.rsi, mfi: r.mfi, stoch: r.stoch, macdCross: r.macdCross, signal: r.signal });
    } catch {
      // skip
    }
  }));

  return result;
}
