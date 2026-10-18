import { sleep } from "./http-client.js";
import { inArray, sql, eq, and, isNotNull } from "drizzle-orm";
import { db, earningsCalendar, fmpFundamentals } from "@workspace/db";
import { fetchFMPEarningsHistory } from "./fmp-client.js";
import { fetchFinnhubEarningsHistory, fetchFinnhubUpcomingEarnings } from "./finnhub-client.js";
import { logger } from "./logger.js";

const STALE_DAYS = 30; // earnings only report ~4x/year — no need to re-fetch often
const UPCOMING_STALE_DAYS = 3; // consensus EPS estimates move more often than reported actuals
const MAX_QUARTERS = 9; // 8 past + room for 1 upcoming without dropping a reported quarter

/** A114 — fiscal quarter ends mislabeled as announcement dates (Finnhub `period`, bad FMP rows). */
export function isFiscalPeriodEndDate(dateStr: string): boolean {
  return /-(03-31|06-30|09-30|12-31)$/.test(dateStr.slice(0, 10));
}

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
//
// FMP's /earnings already includes the next scheduled (unreported) quarter with a
// consensus estimate and a null actual. Finnhub's /stock/earnings (the fallback path)
// does NOT — it's past-actuals-only — so when we land on that fallback we separately
// pull the forward row from Finnhub's /calendar/earnings and merge it in, so the
// fallback path shows an upcoming-quarter estimate too, not just reported history.
export async function fetchLiveEarningsHistory(ticker: string, trigger: string): Promise<RawEarningsQuarter[]> {
  let rows: RawEarningsQuarter[] = [];
  const fmpKey = process.env["FMP_API_KEY"];
  if (fmpKey) {
    try {
      const fmpRows = await fetchFMPEarningsHistory(ticker, fmpKey, trigger);
      if (fmpRows.some(r => r.epsActual != null)) rows = fmpRows;
    } catch (err) {
      logger.warn({ ticker, err }, "fetchFMPEarningsHistory failed, falling back to Finnhub");
    }
  }
  if (rows.length === 0 && process.env["FINNHUB_API_KEY"]) {
    try {
      rows = await fetchFinnhubEarningsHistory(ticker, trigger);
    } catch (err) {
      logger.warn({ ticker, err }, "fetchFinnhubEarningsHistory fallback failed");
    }
  }

  const hasUpcoming = rows.some(r => r.epsActual == null);
  if (!hasUpcoming && process.env["FINNHUB_API_KEY"]) {
    const upcoming = await fetchFinnhubUpcomingEarnings(ticker, trigger);
    const known = new Set(rows.map(r => r.reportDate));
    for (const u of upcoming) if (!known.has(u.reportDate)) rows.push(u);
  }

  return rows;
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
  const today = new Date().toISOString().slice(0, 10);

  await db.transaction(async tx => {
    for (const r of rows) {
      const date = r.reportDate.slice(0, 10);
      // A114: never store fiscal period ends as past announcement dates.
      if (date < today && r.epsActual != null && isFiscalPeriodEndDate(date)) continue;

      const surprisePct = r.epsActual != null && r.epsEstimate != null && r.epsEstimate !== 0
        ? ((r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate)) * 100
        : null;

      await tx.insert(earningsCalendar)
        .values({
          ticker: upperTicker,
          reportDate: date,
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

/**
 * A114 repair: drop past fiscal-period-end rows; insert real announcement dates from LSEG.
 * Safe to re-run. EPS left null on LSEG-only inserts (date correctness > surprise %).
 */
export async function repairPastEarningsFromLseg(): Promise<{ deleted: number; inserted: number }> {
  const del = await db.execute(sql`
    DELETE FROM earnings_calendar
    WHERE eps_actual IS NOT NULL
      AND report_date < CURRENT_DATE
      AND to_char(report_date, 'MM-DD') IN ('03-31', '06-30', '09-30', '12-31')
  `);
  const deleted = Number((del as { rowCount?: number }).rowCount ?? 0);

  let inserted = 0;
  try {
    const ins = await db.execute(sql`
      INSERT INTO earnings_calendar (ticker, report_date, is_confirmed, eps_estimate, eps_actual, surprise_pct, fetched_at)
      SELECT m.ticker, m.report_date, true, NULL, NULL, NULL, now()
      FROM lseg_research.earnings_moves m
      WHERE m.report_date < CURRENT_DATE
      ON CONFLICT (ticker, report_date) DO NOTHING
    `);
    inserted = Number((ins as { rowCount?: number }).rowCount ?? 0);
  } catch (err) {
    logger.warn({ err }, "repairPastEarningsFromLseg: LSEG insert skipped (table missing?)");
  }
  logger.info({ deleted, inserted }, "A114 earnings_calendar repair from LSEG");
  return { deleted, inserted };
}

/** Read reported + upcoming quarters for a ticker, most recent/soonest first, capped to MAX_QUARTERS. */
export async function readEarningsHistoryFromDb(ticker: string): Promise<EarningsQuarter[]> {
  const rows = await db
    .select({
      reportDate: earningsCalendar.reportDate,
      epsEstimate: earningsCalendar.epsEstimate,
      epsActual: earningsCalendar.epsActual,
      surprisePct: earningsCalendar.surprisePct,
    })
    .from(earningsCalendar)
    .where(eq(earningsCalendar.ticker, ticker.toUpperCase()))
    .orderBy(sql`${earningsCalendar.reportDate} DESC`)
    .limit(MAX_QUARTERS);

  return rows.map(r => ({
    reportDate: r.reportDate,
    epsEstimate: r.epsEstimate != null ? Number(r.epsEstimate) : null,
    epsActual: r.epsActual != null ? Number(r.epsActual) : null,
    surprisePct: r.surprisePct != null ? Number(r.surprisePct) : null,
  }));
}

// The main 30-day staleness check (getStaleEarningsTickers) only tracks reported
// actuals, since those rarely change. It intentionally doesn't gate on "is there an
// upcoming-quarter row" — a ticker with no scheduled date yet would stay permanently
// "stale" under that rule and get re-fetched forever. Instead: only ever fetch the
// upcoming row when the ticker has NONE in the DB (cheap, self-limiting — once one
// exists it stays until its report date passes, at which point a normal actuals
// refresh naturally supersedes it). Called from the DB-fresh branch in the
// stock-breakdown route, where fetchLiveEarningsHistory's own upcoming-merge (used on
// the stale/live-fetch branch) never runs.
export async function ensureUpcomingEarnings(ticker: string, trigger: string): Promise<void> {
  const upperTicker = ticker.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const [futureRow] = await db
    .select({ reportDate: earningsCalendar.reportDate })
    .from(earningsCalendar)
    .where(and(eq(earningsCalendar.ticker, upperTicker), sql`${earningsCalendar.reportDate} >= ${today}`))
    .limit(1);
  if (futureRow || !process.env["FINNHUB_API_KEY"]) return;

  const upcoming = await fetchFinnhubUpcomingEarnings(upperTicker, trigger);
  if (upcoming.length > 0) await writeEarningsHistory(upperTicker, upcoming);
}

/**
 * Next (future) scheduled earnings report date per ticker, read straight from
 * earnings_calendar — does NOT trigger a live fetch for tickers with no row
 * yet (that's ensureUpcomingEarnings's job, called elsewhere on a schedule).
 * Used by the portfolio earnings-risk flag, which needs a cheap batched
 * lookup on every page load, not a blocking per-ticker API call.
 */
export async function getUpcomingEarningsDates(tickers: string[]): Promise<Record<string, string | null>> {
  const normalized = [...new Set(tickers.map(t => t.toUpperCase()))];
  const out: Record<string, string | null> = {};
  for (const t of normalized) out[t] = null;
  if (normalized.length === 0) return out;

  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ ticker: earningsCalendar.ticker, reportDate: earningsCalendar.reportDate })
    .from(earningsCalendar)
    .where(and(inArray(earningsCalendar.ticker, normalized), sql`${earningsCalendar.reportDate} >= ${today}`))
    .orderBy(earningsCalendar.reportDate);

  // Earliest future date per ticker — rows are ordered ascending, so the
  // first one seen per ticker wins.
  for (const r of rows) {
    if (out[r.ticker] == null) out[r.ticker] = r.reportDate;
  }
  return out;
}


// Capped per run so a full-universe backlog (first run after shipping this feature)
// spreads across several nightly runs instead of one big burst against FMP/Finnhub.
const MAX_PER_RUN = 60;
const GAP_MS = 350;

// Proactively refreshes stale earnings history for the canonical ticker universe so
// stock-breakdown's Earnings tab is always DB-served — no user click should ever be
// the first thing that triggers an FMP/Finnhub call. Run nightly from the scheduler.
export async function runEarningsHistoryBackfill(trigger = "scheduled"): Promise<{ attempted: number; written: number; empty: number }> {
  // A114 — once per backfill: purge fiscal period-end past rows + seed LSEG announcement dates.
  await repairPastEarningsFromLseg().catch((err) => {
    logger.warn({ err }, "A114 repair skipped");
  });

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
