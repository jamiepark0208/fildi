import { createHash } from "node:crypto";
import { sql, inArray, eq } from "drizzle-orm";
import { db, yahooAnalystActions, analystEvents } from "@workspace/db";
import { yahooEpochToMs, yahooEpochToDateStr, type CatalystAnalystAction } from "./catalysts.js";
import { logger } from "./logger.js";

const STALE_DAYS = 7;
const CUTOFF_DAYS = 365;
const MAX_ACTIONS = 10;

const ACTION_NORMALIZED: Record<string, string> = {
  up: "upgrade",
  down: "downgrade",
  init: "initiate",
  main: "maintain",
  reit: "reiterate",
};

/** Dedup Yahoo's raw upgradeDowngradeHistory to one row per firm (most recent, last 365d, top 10). */
export function parseAnalystHistory(rawHistory: unknown[]): CatalystAnalystAction[] {
  const cutoff = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  const firmMap = new Map<string, any>();
  for (const item of rawHistory as any[]) {
    const ts = yahooEpochToMs(item.epochGradeDate);
    if (!ts || ts < cutoff) continue;
    const firm = (item.firm ?? "Unknown") as string;
    if (!firmMap.has(firm)) firmMap.set(firm, item);
  }
  return Array.from(firmMap.values())
    .sort((a, b) => yahooEpochToMs(b.epochGradeDate) - yahooEpochToMs(a.epochGradeDate))
    .slice(0, MAX_ACTIONS)
    .map(item => ({
      firm: item.firm ?? "Unknown",
      toGrade: item.toGrade ?? "",
      fromGrade: item.fromGrade ?? "",
      action: item.action ?? "maintain",
      date: yahooEpochToDateStr(item.epochGradeDate),
    }));
}

function sourceEventId(ticker: string, firm: string, epochGradeDate: unknown, fromGrade: string, toGrade: string): string {
  return createHash("sha1").update(`${ticker}|${firm}|${epochGradeDate}|${fromGrade}|${toGrade}`).digest("hex");
}

/** Tickers with no analyst_events row fetched within STALE_DAYS. */
export async function getStaleAnalystTickers(allTickers: string[]): Promise<string[]> {
  if (allTickers.length === 0) return [];
  const normalized = allTickers.map(t => t.toUpperCase());
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const freshRows = await db
    .select({ ticker: analystEvents.ticker })
    .from(analystEvents)
    .where(inArray(analystEvents.ticker, normalized))
    .groupBy(analystEvents.ticker)
    .having(sql`MAX(${analystEvents.fetchedAt}) > ${cutoff}`);

  const freshSet = new Set(freshRows.map(r => r.ticker.toUpperCase()));
  return normalized.filter(t => !freshSet.has(t));
}

export async function isAnalystDataFresh(ticker: string): Promise<boolean> {
  const stale = await getStaleAnalystTickers([ticker]);
  return stale.length === 0;
}

/** Write raw Yahoo history (bronze) + normalized events (gold) in one transaction. */
export async function writeAnalystEvents(ticker: string, rawHistory: unknown[]): Promise<void> {
  const upperTicker = ticker.toUpperCase();
  const cutoff = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  const events = (rawHistory as any[]).filter(item => {
    const ts = yahooEpochToMs(item.epochGradeDate);
    return ts && ts >= cutoff;
  });
  if (events.length === 0) return;

  await db.transaction(async tx => {
    for (const item of events) {
      const fromGrade = item.fromGrade ?? "";
      const toGrade = item.toGrade ?? "";
      const eventDate = yahooEpochToDateStr(item.epochGradeDate);
      if (!eventDate) continue;
      const firm = (item.firm ?? "Unknown") as string;
      const rawAction = item.action ?? "main";

      await tx.insert(yahooAnalystActions)
        .values({
          ticker: upperTicker,
          firm,
          action: rawAction,
          fromGrade,
          toGrade,
          eventDate,
          sourceEventId: sourceEventId(upperTicker, firm, item.epochGradeDate, fromGrade, toGrade),
          raw: item,
        })
        .onConflictDoUpdate({
          target: [yahooAnalystActions.ticker, yahooAnalystActions.sourceEventId],
          set: { fromGrade, toGrade, raw: item, fetchedAt: sql`now()` },
        });

      await tx.insert(analystEvents)
        .values({
          ticker: upperTicker,
          firm,
          source: "yahoo",
          action: ACTION_NORMALIZED[rawAction] ?? rawAction,
          fromGrade,
          toGrade,
          eventDate,
        })
        .onConflictDoUpdate({
          target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
          set: { fromGrade, toGrade, action: ACTION_NORMALIZED[rawAction] ?? rawAction, fetchedAt: sql`now()` },
        });
    }
  }).catch(err => {
    logger.warn({ ticker: upperTicker, err }, "writeAnalystEvents transaction failed");
    throw err;
  });
}

/** Read gold analyst_events for a ticker, mapped to the route's existing shape. */
export async function readAnalystEventsFromDb(ticker: string): Promise<CatalystAnalystAction[]> {
  const rows = await db
    .select({
      firm: analystEvents.firm,
      toGrade: analystEvents.toGrade,
      fromGrade: analystEvents.fromGrade,
      action: analystEvents.action,
      eventDate: analystEvents.eventDate,
    })
    .from(analystEvents)
    .where(eq(analystEvents.ticker, ticker.toUpperCase()))
    .orderBy(sql`${analystEvents.eventDate} DESC`)
    .limit(MAX_ACTIONS);

  return rows.map(r => ({
    firm: r.firm,
    toGrade: r.toGrade ?? "",
    fromGrade: r.fromGrade ?? "",
    action: r.action,
    date: r.eventDate,
  }));
}
