/** A83 — model-track path bars + path-risk backfill (split from model-track-record). */
import { and, eq, asc, gt, gte, lte, desc, sql } from "drizzle-orm";
import { db, modelRecs, pricesHistorical } from "@workspace/db";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";
import { computePathRisk, type PathRisk } from "./model-track-path-risk.js";

export async function fetchPathBars(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<Array<{ high: number; low: number }>> {
  const rows = await db
    .select({
      high: pricesHistorical.high,
      low: pricesHistorical.low,
    })
    .from(pricesHistorical)
    .where(and(
      eq(pricesHistorical.ticker, ticker),
      gte(pricesHistorical.date, fromDate),
      lte(pricesHistorical.date, toDate),
    ))
    .orderBy(asc(pricesHistorical.date));
  return rows.flatMap((r) => {
    const high = r.high != null ? Number(r.high) : NaN;
    const low = r.low != null ? Number(r.low) : NaN;
    if (!Number.isFinite(high) || !Number.isFinite(low)) return [];
    return [{ high, low }];
  });
}

export async function pathRiskForRec(input: {
  ticker: string;
  side: string;
  spot: number;
  strike: number;
  snapshotDate: string;
  endDate: string;
  /** When false, skip Yahoo OHLCV fill — request paths must stay fast. Default true for backfill jobs. */
  allowFetch?: boolean;
}): Promise<PathRisk | null> {
  let bars = await fetchPathBars(input.ticker, input.snapshotDate, input.endDate);
  if (bars.length === 0 && input.allowFetch !== false) {
    await fetchAndStoreOHLCV(input.ticker).catch(() => {});
    bars = await fetchPathBars(input.ticker, input.snapshotDate, input.endDate);
  }
  if (bars.length === 0) return null;
  return computePathRisk({
    side: input.side,
    spot: input.spot,
    strike: input.strike,
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
  });
}

/** Backfill _pathRisk on graded WIN/LOSS rows missing it (idempotent). */
export async function backfillPathRisk(limit = 80): Promise<{ updated: number; skipped: number }> {
  const rows = await db.select({
    id: modelRecs.id,
    ticker: modelRecs.ticker,
    side: modelRecs.side,
    spot: modelRecs.spot,
    strike: modelRecs.strike,
    snapshotDate: modelRecs.snapshotDate,
    expiry: modelRecs.expiry,
    componentScores: modelRecs.componentScores,
  }).from(modelRecs)
    .where(sql`${modelRecs.status} IN ('WIN','LOSS')`)
    .orderBy(desc(modelRecs.expiry))
    .limit(limit * 3); // oversample; many already filled

  let updated = 0, skipped = 0;
  for (const rec of rows) {
    if (updated >= limit) break;
    const prev = (rec.componentScores && typeof rec.componentScores === "object")
      ? rec.componentScores as Record<string, unknown>
      : {};
    if (prev["_pathRisk"] && typeof (prev["_pathRisk"] as { maxAdversePct?: unknown }).maxAdversePct === "number") {
      skipped++;
      continue;
    }
    const path = await pathRiskForRec({
      ticker: rec.ticker,
      side: rec.side,
      spot: Number(rec.spot),
      strike: Number(rec.strike),
      snapshotDate: rec.snapshotDate,
      endDate: rec.expiry,
    });
    if (!path) { skipped++; continue; }
    await db.update(modelRecs).set({
      componentScores: { ...prev, _pathRisk: path },
    }).where(eq(modelRecs.id, rec.id));
    updated++;
  }
  if (updated > 0) logger.info({ updated, skipped }, "model-track-record: path-risk backfill");
  return { updated, skipped };
}

/** Next N trading-day closes after expiry (for A92 day-10 assignment window). */
export async function closesAfterExpiry(
  ticker: string,
  expiry: string,
  n = 10,
): Promise<number[]> {
  const bars = await db.select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, ticker), gt(pricesHistorical.date, expiry)))
    .orderBy(asc(pricesHistorical.date))
    .limit(n);
  return bars.flatMap((b) => {
    const c = b.close != null ? Number(b.close) : NaN;
    return Number.isFinite(c) && c > 0 ? [c] : [];
  });
}

