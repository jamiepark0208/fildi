import { createHash } from "node:crypto";
import { sql, inArray } from "drizzle-orm";
import { db, yahooAnalystActions, analystEvents } from "@workspace/db";
import { yahooEpochToMs, yahooEpochToDateStr, type CatalystAnalystAction } from "./catalysts.js";
import { logger } from "./logger.js";
import { STALE_DAYS } from "./data-ops-config.js";

const CUTOFF_DAYS = 365;
/** Cap on events returned to the breakdown UI (full firm history; UI groups by firm). */
const MAX_HISTORY = 100;

const ACTION_NORMALIZED: Record<string, string> = {
  up: "upgrade",
  down: "downgrade",
  init: "initiate",
  main: "maintain",
  reit: "reiterate",
};

/** Yahoo PT fields: 0 / missing → null (priorPriceTarget=0 means initiation, not $0). */
function yahooPriceTarget(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Yahoo upgradeDowngradeHistory → flat events (last 365d). UI groups by firm + expand for history. */
export function parseAnalystHistory(rawHistory: unknown[]): CatalystAnalystAction[] {
  const cutoff = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  return (rawHistory as any[])
    .filter(item => {
      const ts = yahooEpochToMs(item.epochGradeDate);
      return ts && ts >= cutoff;
    })
    .sort((a, b) => yahooEpochToMs(b.epochGradeDate) - yahooEpochToMs(a.epochGradeDate))
    .slice(0, MAX_HISTORY)
    .map(item => ({
      firm: item.firm ?? "Unknown",
      toGrade: item.toGrade ?? "",
      fromGrade: item.fromGrade ?? "",
      action: item.action ?? "maintain",
      date: yahooEpochToDateStr(item.epochGradeDate),
      priceTarget: yahooPriceTarget(item.currentPriceTarget),
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
      const priceTarget = yahooPriceTarget(item.currentPriceTarget);
      const priorPriceTarget = yahooPriceTarget(item.priorPriceTarget);
      const priceTargetAction =
        typeof item.priceTargetAction === "string" && item.priceTargetAction.trim()
          ? item.priceTargetAction.trim()
          : null;
      const priceTargetStr = priceTarget != null ? String(priceTarget) : null;
      const priorPriceTargetStr = priorPriceTarget != null ? String(priorPriceTarget) : null;

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
          priceTarget: priceTargetStr,
          priorPriceTarget: priorPriceTargetStr,
          priceTargetAction,
        })
        .onConflictDoUpdate({
          target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
          set: {
            fromGrade,
            toGrade,
            action: ACTION_NORMALIZED[rawAction] ?? rawAction,
            priceTarget: priceTargetStr,
            priorPriceTarget: priorPriceTargetStr,
            priceTargetAction,
            fetchedAt: sql`now()`,
          },
        });
    }
  }).catch(err => {
    logger.warn({ ticker: upperTicker, err }, "writeAnalystEvents transaction failed");
    throw err;
  });
}

/** Read Yahoo gold analyst_events for a ticker (flat history; UI groups by firm). */
export async function readAnalystEventsFromDb(ticker: string): Promise<CatalystAnalystAction[]> {
  const rows = await db
    .select({
      firm: analystEvents.firm,
      toGrade: analystEvents.toGrade,
      fromGrade: analystEvents.fromGrade,
      action: analystEvents.action,
      eventDate: analystEvents.eventDate,
      priceTarget: analystEvents.priceTarget,
    })
    .from(analystEvents)
    .where(sql`${analystEvents.ticker} = ${ticker.toUpperCase()} AND ${analystEvents.source} = 'yahoo'`)
    .orderBy(sql`${analystEvents.eventDate} DESC`)
    .limit(MAX_HISTORY);

  return rows.map(r => ({
    firm: r.firm,
    toGrade: r.toGrade ?? "",
    fromGrade: r.fromGrade ?? "",
    action: r.action,
    date: r.eventDate,
    priceTarget: r.priceTarget != null ? parseFloat(r.priceTarget as unknown as string) : null,
  }));
}

export interface FmpAnalystEventRow {
  firm: string;
  action: string;
  fromGrade: string | null;
  toGrade: string | null;
  eventDate: string;
  priceTarget: number | null;
}

/** FMP-archived rows (source fmp-grade/fmp-target) — see fmp-analyst-feed.ts for why
 *  these are two separate row types rather than one merged event. */
export async function readFmpAnalystEventsFromDb(ticker: string): Promise<FmpAnalystEventRow[]> {
  const rows = await db
    .select({
      firm: analystEvents.firm,
      source: analystEvents.source,
      action: analystEvents.action,
      fromGrade: analystEvents.fromGrade,
      toGrade: analystEvents.toGrade,
      eventDate: analystEvents.eventDate,
      priceTarget: analystEvents.priceTarget,
    })
    .from(analystEvents)
    .where(sql`${analystEvents.ticker} = ${ticker.toUpperCase()} AND ${analystEvents.source} IN ('fmp-grade', 'fmp-target')`)
    .orderBy(sql`${analystEvents.eventDate} DESC`)
    .limit(30);

  return rows.map(r => ({
    firm: r.firm,
    action: r.action,
    fromGrade: r.fromGrade,
    toGrade: r.toGrade,
    eventDate: r.eventDate,
    priceTarget: r.priceTarget != null ? parseFloat(r.priceTarget as unknown as string) : null,
  }));
}
