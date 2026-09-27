/**
 * FMP's price-target and grade "latest news" feeds are global, unfilterable
 * tapes — no symbol query param, capped to the ~10 most recent events across
 * the entire market (verified live against our plan: page/limit are locked).
 * There's no way to ask for a specific ticker's history on demand, so this
 * runs as a daily background poll that archives whatever crosses our tracked
 * universe into analyst_events (source='fmp-grade' / 'fmp-target'), and the
 * breakdown route reads from there — never live per-request.
 *
 * The two feeds are separate, unmergeable streams (grades feed has no price
 * target field; price-target feed has no grade fields) — written as distinct
 * rows and paired up at read time by (ticker, firm, eventDate) when both
 * happen to land on the same day for the same firm.
 */
import { sql } from "drizzle-orm";
import { db, analystEvents, fmpFundamentals } from "@workspace/db";
import { logger } from "./logger.js";

const FMP_BASE = "https://financialmodelingprep.com/stable";

interface FmpGradeNewsItem {
  symbol: string;
  publishedDate: string;
  newsTitle: string;
  newGrade: string;
  previousGrade: string;
  gradingCompany: string;
  action: string;
}

interface FmpPriceTargetNewsItem {
  symbol: string;
  publishedDate: string;
  newsTitle: string;
  priceTarget: number;
  analystCompany: string;
}

async function fetchFmpFeed<T>(endpoint: string): Promise<T[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(`${FMP_BASE}/${endpoint}?apikey=${apiKey}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.warn({ endpoint, status: res.status }, "fmp-analyst-feed: fetch failed");
      return [];
    }
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    logger.warn({ endpoint, err }, "fmp-analyst-feed: fetch threw");
    return [];
  }
}

async function getTrackedTickers(): Promise<Set<string>> {
  const rows = await db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals);
  return new Set(rows.map(r => r.ticker.toUpperCase()));
}

function toEventDate(publishedDate: string): string | null {
  return publishedDate ? publishedDate.slice(0, 10) : null;
}

export async function runFmpAnalystFeedPoll(): Promise<{ gradesWritten: number; targetsWritten: number }> {
  const universe = await getTrackedTickers();

  const [grades, targets] = await Promise.all([
    fetchFmpFeed<FmpGradeNewsItem>("grades-latest-news"),
    fetchFmpFeed<FmpPriceTargetNewsItem>("price-target-latest-news"),
  ]);

  let gradesWritten = 0;
  for (const item of grades) {
    const symbol = item.symbol?.toUpperCase();
    const eventDate = toEventDate(item.publishedDate);
    if (!symbol || !universe.has(symbol) || !eventDate || !item.gradingCompany) continue;

    await db.insert(analystEvents)
      .values({
        ticker: symbol,
        firm: item.gradingCompany,
        source: "fmp-grade",
        action: (item.action ?? "maintain").toLowerCase(),
        fromGrade: item.previousGrade ?? null,
        toGrade: item.newGrade ?? null,
        eventDate,
        newsTitle: item.newsTitle ?? null,
      })
      .onConflictDoUpdate({
        target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
        set: {
          action: (item.action ?? "maintain").toLowerCase(),
          fromGrade: item.previousGrade ?? null,
          toGrade: item.newGrade ?? null,
          newsTitle: item.newsTitle ?? null,
          fetchedAt: sql`now()`,
        },
      });
    gradesWritten++;
  }

  let targetsWritten = 0;
  for (const item of targets) {
    const symbol = item.symbol?.toUpperCase();
    const eventDate = toEventDate(item.publishedDate);
    if (!symbol || !universe.has(symbol) || !eventDate || !item.analystCompany || item.priceTarget == null) continue;

    await db.insert(analystEvents)
      .values({
        ticker: symbol,
        firm: item.analystCompany,
        source: "fmp-target",
        action: "price-target",
        eventDate,
        priceTarget: String(item.priceTarget),
        newsTitle: item.newsTitle ?? null,
      })
      .onConflictDoUpdate({
        target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
        set: {
          priceTarget: String(item.priceTarget),
          newsTitle: item.newsTitle ?? null,
          fetchedAt: sql`now()`,
        },
      });
    targetsWritten++;
  }

  logger.info({ gradesWritten, targetsWritten }, "fmp-analyst-feed: poll complete");
  return { gradesWritten, targetsWritten };
}
