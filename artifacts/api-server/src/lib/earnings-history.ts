import { inArray, sql, eq, and, isNotNull } from "drizzle-orm";
import { db, earningsCalendar, fmpFundamentals } from "@workspace/db";
import { fetchFMPEarningsHistory } from "./fmp-client.js";
import { fetchFinnhubEarningsHistory } from "./finnhub-client.js";
import { logger } from "./logger.js";

const STALE_DAYS = 30; // earnings only report ~4x/year — no need to re-fetch often
const MAX_QUARTERS = 8;

export interface EarningsQuarter {
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

// Source-agnostic shape both fetchFMPEarningsHistory and fetchFinnhubEarningsHistory
// rows satisfy (FMP's also carries revenue fields, which writeEarningsHistory ignores).
interface RawEarningsQuarter {
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
}

// FMP first (it's the primary fundamentals source and already covers most of the
// universe); Finnhub as a fallback for tickers FMP's current plan 402s on (e.g.
// AAOI, GME — "Premium Query Parameter", not a data-availability issue, a plan-tier
// gate). Only fall back when FMP returned nothing usable, so a ticker FMP already
// serves correctly never burns a second-source call.
export async function fetchLiveEarningsHistory(ticker: string, trigger: string): Promise<RawEarningsQuarter[]> {
  const fmpKey = process.env["FMP_API_KEY"];
  if (fmpKey) {
    try {
      const rows = await fetchFMPEarningsHistory(ticker, fmpKey, trigger);
      if (rows.some(r => r.epsActual != null)) return rows;
    } catch (err) {
      logger.warn({ ticker, err }, "fetchFMPEarningsHistory failed, falling back to Finnhub");
    }
  }
  if (process.env["FINNHUB_API_KEY"]) {
    try {
      return await fetchFinnhubEarningsHistory(ticker, trigger);
    } catch (err) {
      logger.warn({ ticker, err }, "fetchFinnhubEarningsHistory fallback failed");
    }
  }
  return [];
}

/** Tickers with no earnings_calendar row (with an actual reported quarter) fetched within STALE_DAYS. */
export async function getStaleEarningsTickers(allTickers: string[]): Promise<string[]> {
  if (allTickers.length === 0) return [];
  const normalized = allTickers.map(t => t.toUpperCase());
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const freshRows = await db
    .select({ ticker: earningsCalendar.ticker })
    .from(earningsCalendar)
    .where(and(inArray(earningsCalendar.ticker, normalized), isNotNull(earningsCalendar.epsActual)))
    .groupBy(earningsCalendar.ticker)
    .having(sql`MAX(${earningsCalendar.fetchedAt}) > ${cutoff}`);

  const freshSet = new Set(freshRows.map(r => r.ticker.toUpperCase()));
  return normalized.filter(t => !freshSet.has(t));
}

export async function isEarningsDataFresh(ticker: string): Promise<boolean> {
  const stale = await getStaleEarningsTickers([ticker]);
  return stale.length === 0;
}

/** Upsert live-fetched (FMP or Finnhub) rows into earnings_calendar (past + upcoming quarters). */
export async function writeEarningsHistory(ticker: string, rows: RawEarningsQuarter[]): Promise<void> {
  const upperTicker = ticker.toUpperCase();
  if (rows.length === 0) return;

  await db.transaction(async tx => {
    for (const r of rows) {
      const surprisePct = r.epsActual != null && r.epsEstimate != null && r.epsEstimate !== 0
        ? ((r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate)) * 100
        : null;

      await tx.insert(earningsCalendar)
        .values({
          ticker: upperTicker,
          reportDate: r.reportDate,
          isConfirmed: true,
          epsEstimate: r.epsEstimate?.toString() ?? null,
          epsActual: r.epsActual?.toString() ?? null,
          surprisePct: surprisePct?.toString() ?? null,
        })
        .onConflictDoUpdate({
          target: [earningsCalendar.ticker, earningsCalendar.reportDate],
          set: {
            epsEstimate: r.epsEstimate?.toString() ?? null,
            epsActual: r.epsActual?.toString() ?? null,
            surprisePct: surprisePct?.toString() ?? null,
            fetchedAt: sql`now()`,
          },
        });
    }
  }).catch(err => {
    logger.warn({ ticker: upperTicker, err }, "writeEarningsHistory transaction failed");
    throw err;
  });
}

/** Read past reported quarters (actual != null) for a ticker, most recent first, capped to MAX_QUARTERS. */
export async function readEarningsHistoryFromDb(ticker: string): Promise<EarningsQuarter[]> {
  const rows = await db
    .select({
      reportDate: earningsCalendar.reportDate,
      epsEstimate: earningsCalendar.epsEstimate,
      epsActual: earningsCalendar.epsActual,
      surprisePct: earningsCalendar.surprisePct,
    })
    .from(earningsCalendar)
    .where(and(eq(earningsCalendar.ticker, ticker.toUpperCase()), isNotNull(earningsCalendar.epsActual)))
    .orderBy(sql`${earningsCalendar.reportDate} DESC`)
    .limit(MAX_QUARTERS);

  return rows.map(r => ({
    reportDate: r.reportDate,
    epsEstimate: r.epsEstimate != null ? Number(r.epsEstimate) : null,
    epsActual: r.epsActual != null ? Number(r.epsActual) : null,
    surprisePct: r.surprisePct != null ? Number(r.surprisePct) : null,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Capped per run so a full-universe backlog (first run after shipping this feature)
// spreads across several nightly runs instead of one big burst against FMP/Finnhub.
const MAX_PER_RUN = 60;
const GAP_MS = 350;

// Proactively refreshes stale earnings history for the canonical ticker universe so
// stock-breakdown's Earnings tab is always DB-served — no user click should ever be
// the first thing that triggers an FMP/Finnhub call. Run nightly from the scheduler.
export async function runEarningsHistoryBackfill(trigger = "scheduled"): Promise<{ attempted: number; written: number; empty: number }> {
  const universe = await db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals);
  const stale = await getStaleEarningsTickers(universe.map(r => r.ticker));
  const batch = stale.slice(0, MAX_PER_RUN);

  let written = 0;
  let empty = 0;
  for (const ticker of batch) {
    try {
      const rows = await fetchLiveEarningsHistory(ticker, trigger);
      if (rows.length > 0) {
        await writeEarningsHistory(ticker, rows);
        written++;
      } else {
        empty++;
      }
    } catch (err) {
      logger.warn({ ticker, err }, "runEarningsHistoryBackfill: ticker failed");
    }
    await sleep(GAP_MS);
  }

  logger.info({ trigger, universeSize: universe.length, staleCount: stale.length, attempted: batch.length, written, empty }, "runEarningsHistoryBackfill complete");
  return { attempted: batch.length, written, empty };
}
