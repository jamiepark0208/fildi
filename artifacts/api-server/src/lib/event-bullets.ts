/**
 * Daily, DB-only event-trigger check for watchlist tickers.
 *
 * Produces template bull/bear bullets (no LLM) for three structured triggers:
 *   - earnings beat/miss (earnings_calendar)
 *   - analyst rating upgrade/downgrade (analyst_events)
 *   - large price move vs SPY, ex-macro (prices_historical)
 *
 * Every input is already populated by other pipelines (nightly enrichment,
 * analyst write-through, price fetch) — this job only reads, so it's cheap
 * enough to run once a day over the full watchlist union with no API budget
 * impact. See routes/stocks.ts breakdown handler for where results are merged
 * into the response.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db, earningsCalendar, analystEvents, pricesHistorical, tickerEventBullets } from "@workspace/db";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { logger } from "./logger.js";

// Validated empirically against 45 days of watchlist price history: below this,
// day-to-day noise dominates; above it, moves reliably line up with a real event.
const EXCESS_MOVE_THRESHOLD_PCT = 5;
/** Quiet tickers keep old rows forever unless we expire — Aug bullets were still prepended as "timely". */
const EVENT_BULLET_TTL_DAYS = 7;

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function checkEarnings(ticker: string): Promise<{ bull: string[]; bear: string[]; triggers: string[] }> {
  const bull: string[] = [];
  const bear: string[] = [];
  const triggers: string[] = [];

  const rows = await db.select().from(earningsCalendar).where(
    and(
      eq(earningsCalendar.ticker, ticker),
      eq(earningsCalendar.isConfirmed, true),
      gte(earningsCalendar.reportDate, yesterday()),
    ),
  );

  for (const r of rows) {
    if (r.epsActual == null || r.surprisePct == null) continue;
    const surprise = Number(r.surprisePct);
    const actual = Number(r.epsActual);
    const estimate = r.epsEstimate != null ? Number(r.epsEstimate) : null;
    const estStr = estimate != null ? `$${estimate.toFixed(2)}` : "est.";
    if (surprise > 0) {
      bull.push(`Beat EPS estimate by ${surprise.toFixed(0)}% ($${actual.toFixed(2)} vs ${estStr}) on ${r.reportDate}`);
      triggers.push(`earnings_beat:${r.reportDate}`);
    } else if (surprise < 0) {
      bear.push(`Missed EPS estimate by ${Math.abs(surprise).toFixed(0)}% ($${actual.toFixed(2)} vs ${estStr}) on ${r.reportDate}`);
      triggers.push(`earnings_miss:${r.reportDate}`);
    }
  }

  return { bull, bear, triggers };
}

async function checkAnalystActions(ticker: string): Promise<{ bull: string[]; bear: string[]; triggers: string[] }> {
  const bull: string[] = [];
  const bear: string[] = [];
  const triggers: string[] = [];

  const rows = await db.select().from(analystEvents).where(
    and(eq(analystEvents.ticker, ticker), gte(analystEvents.eventDate, yesterday())),
  );

  for (const r of rows) {
    if (r.action === "upgrade") {
      bull.push(`${r.firm} upgraded ${ticker} from ${r.fromGrade ?? "prior rating"} to ${r.toGrade}`);
      triggers.push(`analyst_upgrade:${r.firm}:${r.eventDate}`);
    } else if (r.action === "downgrade") {
      bear.push(`${r.firm} downgraded ${ticker} from ${r.fromGrade ?? "prior rating"} to ${r.toGrade}`);
      triggers.push(`analyst_downgrade:${r.firm}:${r.eventDate}`);
    }
  }

  return { bull, bear, triggers };
}

async function lastTwoCloses(ticker: string): Promise<[number, number] | null> {
  const rows = await db.select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(eq(pricesHistorical.ticker, ticker))
    .orderBy(desc(pricesHistorical.date))
    .limit(2);
  if (rows.length < 2) return null;
  const [last, prev] = rows; // desc order: rows[0] = most recent
  if (last.close == null || prev.close == null) return null;
  return [Number(prev.close), Number(last.close)];
}

async function checkPriceMove(ticker: string, spyCloses: [number, number] | null): Promise<{ bull: string[]; bear: string[]; triggers: string[] }> {
  const bull: string[] = [];
  const bear: string[] = [];
  const triggers: string[] = [];

  if (!spyCloses) return { bull, bear, triggers };
  const tickerCloses = await lastTwoCloses(ticker);
  if (!tickerCloses) return { bull, bear, triggers };

  const [spyPrev, spyLast] = spyCloses;
  const [tPrev, tLast] = tickerCloses;
  if (!spyPrev || !tPrev) return { bull, bear, triggers };

  const spyMovePct = ((spyLast - spyPrev) / spyPrev) * 100;
  const tickerMovePct = ((tLast - tPrev) / tPrev) * 100;
  const excessMovePct = tickerMovePct - spyMovePct;

  if (excessMovePct >= EXCESS_MOVE_THRESHOLD_PCT) {
    bull.push(`Large price move detected (ex-macro): +${excessMovePct.toFixed(1)}% vs SPY today`);
    triggers.push(`price_move_up:${excessMovePct.toFixed(1)}`);
  } else if (excessMovePct <= -EXCESS_MOVE_THRESHOLD_PCT) {
    bear.push(`Large price move detected (ex-macro): ${excessMovePct.toFixed(1)}% vs SPY today`);
    triggers.push(`price_move_down:${excessMovePct.toFixed(1)}`);
  }

  return { bull, bear, triggers };
}

export async function runEventBulletCheck(): Promise<void> {
  const tickers = await getUnionWatchlistTickers();
  const spyCloses = await lastTwoCloses("SPY");

  let updated = 0;
  for (const ticker of tickers) {
    try {
      const [earnings, analyst, priceMove] = await Promise.all([
        checkEarnings(ticker),
        checkAnalystActions(ticker),
        checkPriceMove(ticker, spyCloses),
      ]);

      const bullBullets = [...earnings.bull, ...analyst.bull, ...priceMove.bull];
      const bearBullets = [...earnings.bear, ...analyst.bear, ...priceMove.bear];
      const triggers = [...earnings.triggers, ...analyst.triggers, ...priceMove.triggers];

      if (bullBullets.length === 0 && bearBullets.length === 0) {
        // No fresh trigger — drop rows older than TTL so Breakdown doesn't show dead catalysts.
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - EVENT_BULLET_TTL_DAYS);
        await db.delete(tickerEventBullets).where(
          and(eq(tickerEventBullets.ticker, ticker), lt(tickerEventBullets.generatedAt, cutoff)),
        );
        continue;
      }

      await db.insert(tickerEventBullets)
        .values({ ticker, bullBullets, bearBullets, triggers, generatedAt: new Date() })
        .onConflictDoUpdate({
          target: tickerEventBullets.ticker,
          set: { bullBullets, bearBullets, triggers, generatedAt: new Date() },
        });
      updated++;
    } catch (err) {
      logger.error({ ticker, err }, "event-bullets: trigger check failed for ticker");
    }
  }

  logger.info({ tickersChecked: tickers.length, tickersUpdated: updated }, "event-bullets: daily trigger check complete");
}
