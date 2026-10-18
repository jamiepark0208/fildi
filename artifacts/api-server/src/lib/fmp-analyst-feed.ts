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

/** A146 — drop market-roundup headlines that FMP attaches to every name in a digest. */
const ROUNDUP_RE = /what you missed on wall street|wall street'?s top analyst calls|stocks to (?:buy|watch)|top (?:analyst )?calls|morning movers|market wrap|today'?s biggest|analysts (?:are )?saying|here are the/i;

/**
 * Keep newsTitle only when it names this ticker (word boundary). Roundups → null.
 * Company-name matching needs a name map we don't have here — ticker mention is the gate.
 */
export function headlineForTicker(ticker: string, title: string | null | undefined): string | null {
  if (!title?.trim()) return null;
  const trimmed = title.trim();
  if (ROUNDUP_RE.test(trimmed)) return null;
  const esc = ticker.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${esc}\\b`, "i").test(trimmed)) return null;
  return trimmed;
}

/** Parse "from $180" / "raised from 180" → prior target when FMP omits the field. */
export function priorTargetFromHeadline(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = title.match(/(?:from|was)\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : null;
}

/** Null out stored roundup titles (FMP digest noise). Does not touch firm-specific company-name headlines. */
async function scrubStaleRoundupTitles(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE analyst_events
    SET news_title = NULL
    WHERE news_title IS NOT NULL
      AND (
        news_title ~* 'what you missed on wall street'
        OR news_title ~* 'wall street''?s top analyst calls'
        OR news_title ~* 'stocks to (buy|watch)'
        OR news_title ~* 'top analyst calls'
        OR news_title ~* 'morning movers'
      )
  `);
  return Number((res as { rowCount?: number }).rowCount ?? 0);
}

export async function runFmpAnalystFeedPoll(): Promise<{ gradesWritten: number; targetsWritten: number; scrubbed: number }> {
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
    const newsTitle = headlineForTicker(symbol, item.newsTitle);
    const prior = priorTargetFromHeadline(item.newsTitle);

    await db.insert(analystEvents)
      .values({
        ticker: symbol,
        firm: item.gradingCompany,
        source: "fmp-grade",
        action: (item.action ?? "maintain").toLowerCase(),
        fromGrade: item.previousGrade ?? null,
        toGrade: item.newGrade ?? null,
        eventDate,
        newsTitle,
        ...(prior != null ? { priorPriceTarget: String(prior) } : {}),
      })
      .onConflictDoUpdate({
        target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
        set: {
          action: (item.action ?? "maintain").toLowerCase(),
          fromGrade: item.previousGrade ?? null,
          toGrade: item.newGrade ?? null,
          newsTitle,
          ...(prior != null ? { priorPriceTarget: String(prior) } : {}),
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
    const newsTitle = headlineForTicker(symbol, item.newsTitle);
    const prior = priorTargetFromHeadline(item.newsTitle);

    await db.insert(analystEvents)
      .values({
        ticker: symbol,
        firm: item.analystCompany,
        source: "fmp-target",
        action: "price-target",
        eventDate,
        priceTarget: String(item.priceTarget),
        newsTitle,
        ...(prior != null ? { priorPriceTarget: String(prior) } : {}),
      })
      .onConflictDoUpdate({
        target: [analystEvents.ticker, analystEvents.firm, analystEvents.eventDate, analystEvents.source],
        set: {
          priceTarget: String(item.priceTarget),
          newsTitle,
          ...(prior != null ? { priorPriceTarget: String(prior) } : {}),
          fetchedAt: sql`now()`,
        },
      });
    targetsWritten++;
  }

  const scrubbed = await scrubStaleRoundupTitles().catch((err) => {
    logger.warn({ err }, "fmp-analyst-feed: scrub failed");
    return 0;
  });

  logger.info({ gradesWritten, targetsWritten, scrubbed }, "fmp-analyst-feed: poll complete");
  return { gradesWritten, targetsWritten, scrubbed };
}
