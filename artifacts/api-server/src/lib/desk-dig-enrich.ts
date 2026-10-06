/**
 * Enrich shallow TipRanks dig teasers ("1 new analyst rating") with firm /
 * grade / action / date from Yahoo upgradeDowngradeHistory + analyst_events.
 */
import { and, gte, inArray, sql } from "drizzle-orm";
import { db, analystEvents } from "@workspace/db";
import { yahooEpochToDateStr, yahooEpochToMs } from "./catalysts.js";
import {
  isShallowDigFact,
  mergePreferRichDigFacts,
  type DigFact,
  type DigKind,
} from "./desk-link-dig.js";
import { writeAnalystEvents } from "./analyst-events.js";
import { fetchYahooAnalystActions } from "./yahoo-analyst-client.js";
import { logger } from "./logger.js";

const ACTION_LABEL: Record<string, string> = {
  up: "upgrade",
  upgrade: "upgrade",
  down: "downgrade",
  downgrade: "downgrade",
  init: "initiate",
  initialise: "initiate",
  initiate: "initiate",
  main: "maintain",
  maintain: "maintain",
  reit: "reiterate",
  reiterate: "reiterate",
  "price-target": "PT",
};

function kindFromAction(action: string): DigKind {
  const a = (ACTION_LABEL[action] ?? action).toLowerCase();
  if (a === "upgrade") return "upgrade";
  if (a === "downgrade") return "downgrade";
  if (a === "pt" || a === "price-target") return "price_target";
  return "analyst_rating";
}

function formatEventDetail(opts: {
  firm: string;
  action: string;
  fromGrade: string | null;
  toGrade: string | null;
  eventDate: string;
  priceTarget?: number | null;
}): string {
  const label = ACTION_LABEL[opts.action] ?? opts.action;
  const grade =
    opts.fromGrade && opts.toGrade && opts.fromGrade !== opts.toGrade
      ? `${opts.fromGrade}→${opts.toGrade}`
      : opts.toGrade || opts.fromGrade || "";
  const pt = opts.priceTarget != null && Number.isFinite(opts.priceTarget) ? ` PT $${opts.priceTarget}` : "";
  return `${opts.firm} ${label}${grade ? ` ${grade}` : ""}${pt} (${opts.eventDate})`.replace(/\s+/g, " ").trim();
}

/** Raw Yahoo history → events on/after sinceDate (no firm dedupe — want today's tape). */
export function recentActionsFromYahooRaw(
  raw: unknown[],
  sinceDate: string,
  limit = 6,
): Array<{ firm: string; action: string; fromGrade: string; toGrade: string; date: string }> {
  const out: Array<{ firm: string; action: string; fromGrade: string; toGrade: string; date: string }> = [];
  for (const item of raw as any[]) {
    const date = yahooEpochToDateStr(item.epochGradeDate);
    if (!date || date < sinceDate) continue;
    const ts = yahooEpochToMs(item.epochGradeDate);
    if (!ts) continue;
    out.push({
      firm: String(item.firm ?? "Unknown"),
      action: String(item.action ?? "main"),
      fromGrade: String(item.fromGrade ?? ""),
      toGrade: String(item.toGrade ?? ""),
      date,
    });
  }
  return out
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit);
}

async function enrichFromDb(tickers: string[], sinceDate: string): Promise<DigFact[]> {
  if (!tickers.length) return [];
  const upper = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const rows = await db
    .select({
      ticker: analystEvents.ticker,
      firm: analystEvents.firm,
      action: analystEvents.action,
      fromGrade: analystEvents.fromGrade,
      toGrade: analystEvents.toGrade,
      eventDate: analystEvents.eventDate,
      priceTarget: analystEvents.priceTarget,
      source: analystEvents.source,
    })
    .from(analystEvents)
    .where(and(inArray(analystEvents.ticker, upper), gte(analystEvents.eventDate, sinceDate)))
    .orderBy(sql`${analystEvents.eventDate} DESC`)
    .limit(40);

  return rows.map((r) => ({
    ticker: r.ticker.toUpperCase(),
    kind: kindFromAction(r.action),
    detail: formatEventDetail({
      firm: r.firm,
      action: r.action,
      fromGrade: r.fromGrade,
      toGrade: r.toGrade,
      eventDate: String(r.eventDate),
      priceTarget: r.priceTarget != null ? parseFloat(String(r.priceTarget)) : null,
    }),
    source: `analyst_events:${r.source}`,
  }));
}

/**
 * For each shallow dig ticker: pull Yahoo history, persist, then merge DB rows
 * since `sinceDate` (usually session start PT). Drops shallow teasers when rich
 * facts exist; leftover shallow stay for the prompt's INCOMPLETE warning.
 */
export async function enrichShallowDigFacts(
  facts: DigFact[],
  opts: { sinceDate: string },
): Promise<DigFact[]> {
  const shallowTickers = [...new Set(facts.filter(isShallowDigFact).map((f) => f.ticker))];
  if (!shallowTickers.length) return facts;

  for (const ticker of shallowTickers.slice(0, 8)) {
    try {
      const raw = await fetchYahooAnalystActions(ticker);
      if (raw.length) {
        await writeAnalystEvents(ticker, raw).catch((err) => {
          logger.debug({ err, ticker }, "desk-dig-enrich: writeAnalystEvents failed");
        });
      }
    } catch (err) {
      logger.debug({ err, ticker }, "desk-dig-enrich: yahoo fetch failed");
    }
  }

  // Look back one extra day so Mon session can use Fri events; TipRanks often lags a day.
  const d = new Date(`${opts.sinceDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const dbSince = d.toISOString().slice(0, 10);

  const fromDb = await enrichFromDb(shallowTickers, dbSince);
  return mergePreferRichDigFacts(facts, fromDb);
}
