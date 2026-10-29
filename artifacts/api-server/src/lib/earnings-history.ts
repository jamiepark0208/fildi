import { sleep } from "./http-client.js";
import { inArray, sql, eq, and, isNotNull, gte, lte } from "drizzle-orm";
import { db, earningsCalendar, fmpFundamentals, appConfig } from "@workspace/db";
import { fetchFMPEarningsHistory } from "./fmp-client.js";
import {
  fetchFinnhubPeriodEps,
  fetchFinnhubUpcomingEarnings,
  mapPeriodEpsToAnnouncementDates,
} from "./finnhub-client.js";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { isExcludedEtf } from "./etf-exclusions.js";
import { logger } from "./logger.js";

const STALE_DAYS = 30; // earnings only report ~4x/year — no need to re-fetch often
const UPCOMING_STALE_DAYS = 3; // consensus EPS estimates move more often than reported actuals
const MAX_QUARTERS = 10; // 8 reported for 2Y view + room for upcoming + 1 spare
/** Morning/scheduled: watchlist + near-term earnings first (A236 — full-universe was ~29 min). */
const MAX_PER_RUN_MORNING = 25;
const A114_REPAIR_DAY_KEY = "a114_earnings_repair_et_day";

export function etDayKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

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
      // Finnhub calendar often returns dates without EPS; /stock/earnings has actuals but
      // fiscal period ends (A114). Map EPS onto LSEG/DB announcement dates (+ calendar if any).
      const periodEps = await fetchFinnhubPeriodEps(ticker, trigger);
      const dbDates = await db
        .select({ reportDate: earningsCalendar.reportDate })
        .from(earningsCalendar)
        .where(eq(earningsCalendar.ticker, ticker.toUpperCase()));
      const announceDates = dbDates.map((r) => r.reportDate.slice(0, 10));
      rows = mapPeriodEpsToAnnouncementDates(periodEps, announceDates);
      if (rows.length === 0) {
        logger.warn({ ticker, periodEps: periodEps.length, announceDates: announceDates.length },
          "Finnhub EPS present but no announcement-date match");
      }
    } catch (err) {
      logger.warn({ ticker, err }, "Finnhub period-EPS fallback failed");
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

/** Tickers with zero earnings_calendar row dated today-or-later (A240) — stale regardless of
 *  actual-EPS freshness. Catches a report date rolling into the past before the next-quarter
 *  row gets fetched (e.g. NFLX reported 10-20, stayed "fresh" under the 30d actual check with
 *  no forward date). Self-limiting: drops out once any future row exists. */
export async function getTickersMissingUpcomingDate(allTickers: string[]): Promise<string[]> {
  if (allTickers.length === 0) return [];
  const normalized = [...new Set(allTickers.map(t => t.toUpperCase()))];
  // A240 fix-up (157b21d0 review finding 2): UTC slice flags a today-ET report as
  // "missing" after ~17:00 PT (UTC already rolled to tomorrow) — wasted fetch.
  const today = etDayKey();
  const futureRows = await db
    .select({ ticker: earningsCalendar.ticker })
    .from(earningsCalendar)
    .where(and(inArray(earningsCalendar.ticker, normalized), gte(earningsCalendar.reportDate, today)));
  const haveFuture = new Set(futureRows.map(r => r.ticker.toUpperCase()));
  return normalized.filter(t => !haveFuture.has(t));
}

const MISSING_UPCOMING_EMPTY_KEY = "a240_missing_upcoming_empty_attempts";
const EMPTY_ATTEMPT_SKIP_DAYS = 7;

/** A240 fix-up (157b21d0 review finding 1) — per-ticker ET-day of the last fetch attempt that
 *  came back empty, so `missingUpcoming` stops re-trying a name that can't ever resolve (ETF,
 *  ADR/foreign with no Finnhub calendar coverage) every single morning run. Stored in app_config
 *  (no schema change) since this is scoped to earnings-history.ts only. */
async function getEmptyAttemptMap(): Promise<Record<string, string>> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, MISSING_UPCOMING_EMPTY_KEY)).limit(1);
  const value = rows[0]?.value;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

async function recordEmptyAttempts(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  const day = etDayKey();
  const existing = await getEmptyAttemptMap();
  for (const t of tickers) existing[t.toUpperCase()] = day;
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, MISSING_UPCOMING_EMPTY_KEY)).limit(1);
  if (rows.length === 0) await db.insert(appConfig).values({ key: MISSING_UPCOMING_EMPTY_KEY, value: existing });
  else await db.update(appConfig).set({ value: existing, updatedAt: new Date() }).where(eq(appConfig.key, MISSING_UPCOMING_EMPTY_KEY));
}

/**
 * A240 fix-up (157b21d0 review finding 1) — pure so it's unit-testable without a DB. Drops
 * ETFs (never report earnings) and anything whose last empty attempt is < 7 ET-days old, then
 * orders what's left oldest-attempt-first (never-attempted = oldest) so the cap-25 morning run
 * rotates through starving names instead of the same front-of-list ones winning every day.
 */
export function prioritizeMissingUpcoming(
  tickers: string[],
  emptyAttempts: Record<string, string>,
  today: string = etDayKey(),
): string[] {
  const todayMs = Date.parse(today);
  const lastAttemptMs = (t: string): number => {
    const last = emptyAttempts[t.toUpperCase()];
    return last ? Date.parse(last) : -Infinity;
  };
  return tickers
    .filter((t) => {
      const upper = t.toUpperCase();
      if (isExcludedEtf(upper)) return false;
      const lastMs = lastAttemptMs(upper);
      if (lastMs === -Infinity) return true;
      return (todayMs - lastMs) / (24 * 60 * 60 * 1000) >= EMPTY_ATTEMPT_SKIP_DAYS;
    })
    .sort((a, b) => lastAttemptMs(a) - lastAttemptMs(b));
}

/**
 * A240 — the Model List candidate pool (model_recs weekly picks ∪ option_score_snapshots daily
 * universe ranking) is NOT a subset of fmp_fundamentals: 162/317 pool tickers (10-21 audit) have
 * no fmp_fundamentals row at all (NEM, FCX, UPS, ETN, CMCSA, UAL, BMY, DXCM, IDXX, …), so the old
 * fmp_fundamentals-only universe below silently never fetched an earnings date for them — root
 * cause of the ~23 % "no earnings date known" gap on sell_puts candidates. Union both pools'
 * latest snapshot into the earnings backfill universe. Raw SQL: these tables are written by the
 * Python watchlist_sync side and have no TS query helper of their own.
 */
async function getModelListPoolTickers(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM model_recs
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
    UNION
    SELECT DISTINCT UPPER(ticker) AS ticker FROM option_score_snapshots
    WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
    UNION
    -- 10-26: the put engine (put_recs.py) prices every saved-chain name; 39 of them had no earnings date at all, so the
    -- "farther strike before earnings" rule could never fire for them
    SELECT DISTINCT UPPER(ticker) AS ticker FROM option_chain_history
    WHERE as_of = (SELECT MAX(as_of) FROM option_chain_history)
  `);
  const list = (Array.isArray(res) ? res : (res as unknown as { rows?: { ticker: string }[] }).rows) ?? [];
  return list.map((r) => String((r as { ticker: string }).ticker).toUpperCase());
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

/** A114 repair once per ET day — re-running the LSEG bulk insert every morning dominated precompute. */
export async function repairPastEarningsFromLsegIfDue(force = false): Promise<{ skipped: boolean; deleted?: number; inserted?: number }> {
  const day = etDayKey();
  if (!force) {
    const rows = await db.select().from(appConfig).where(eq(appConfig.key, A114_REPAIR_DAY_KEY)).limit(1);
    if (rows[0]?.value === day) {
      logger.info({ day }, "A114 repair already ran today (ET) — skip");
      return { skipped: true };
    }
  }
  const r = await repairPastEarningsFromLseg();
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, A114_REPAIR_DAY_KEY)).limit(1);
  if (existing.length === 0) await db.insert(appConfig).values({ key: A114_REPAIR_DAY_KEY, value: day });
  else await db.update(appConfig).set({ value: day, updatedAt: new Date() }).where(eq(appConfig.key, A114_REPAIR_DAY_KEY));
  return { skipped: false, ...r };
}

/** Names with a calendar print in ±14d — Model List earnings re-strike cares about these. */
async function earningsWindowTickers(): Promise<string[]> {
  const today = etDayKey();
  const lo = new Date(`${today}T12:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 1);
  const hi = new Date(`${today}T12:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 14);
  const loS = lo.toISOString().slice(0, 10);
  const hiS = hi.toISOString().slice(0, 10);
  const rows = await db
    .select({ ticker: earningsCalendar.ticker })
    .from(earningsCalendar)
    .where(and(gte(earningsCalendar.reportDate, loS), lte(earningsCalendar.reportDate, hiS)));
  return [...new Set(rows.map((r) => r.ticker.toUpperCase()))];
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

// Proactively refreshes stale earnings history so stock-breakdown's Earnings tab is
// DB-served. Morning/scheduled: watchlist + ±14d earnings window first (A236).
function rowsOfEngine(res: unknown): string[] {
  const list = (Array.isArray(res) ? res : (res as { rows?: { ticker: string }[] }).rows) ?? [];
  return (list as { ticker: string }[]).map((r) => String(r.ticker).toUpperCase());
}

export async function runEarningsHistoryBackfill(trigger = "scheduled"): Promise<{ attempted: number; written: number; empty: number }> {
  await repairPastEarningsFromLsegIfDue().catch((err) => {
    logger.warn({ err }, "A114 repair skipped");
  });

  const fmpUniverse = await db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals);
  const poolTickers = await getModelListPoolTickers().catch((err) => {
    logger.warn({ err }, "A240: getModelListPoolTickers failed — falling back to fmp_fundamentals-only universe");
    return [] as string[];
  });
  // 10-29 (ALAB/COHR reported 11-03/11-04 with no date on file while the engine sold 11-06 puts on them): put-engine names
  // must be IN the universe — the 10-28 queue-jump below only reorders names already in it.
  const engine = new Set(rowsOfEngine(await db.execute(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM watchlist_sync.put_recs_daily
    WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND payload->>'strike' IS NOT NULL`).catch(() => [])));
  const universeTickers = [...new Set([...fmpUniverse.map((r) => r.ticker.toUpperCase()), ...poolTickers, ...engine])];

  const [staleActuals, missingUpcoming] = await Promise.all([
    getStaleEarningsTickers(universeTickers),
    getTickersMissingUpcomingDate(universeTickers),
  ]);
  const stale = [...new Set([...staleActuals, ...missingUpcoming])];
  const morningish = /^(scheduled|morning|maintain)/i.test(trigger);
  let ordered = stale;
  if (morningish) {
    const [watch, window, emptyAttempts] = await Promise.all([
      getUnionWatchlistTickers(),
      earningsWindowTickers(),
      getEmptyAttemptMap().catch((err) => {
        logger.warn({ err }, "A240: getEmptyAttemptMap failed — no empty-attempt skip this run");
        return {} as Record<string, string>;
      }),
    ]);
    // A240: tickers with no forward date at all go first — they're the ones showing as "no
    // earnings date known" on the Model List, highest-value fetch under the cap. Fix-up
    // (157b21d0 finding 1): drop ETFs and names re-fetched empty within 7d from that priority
    // slot so they stop starving the rest of the queue every morning run.
    // 10-28 (VRT reported with no date on file; 13 of 101 engine picks had none): names the put engine prices jump the queue —
    // the 25-name morning cap never reached them behind the watchlist + window lists.
    const prioritizedMissing = [
      ...missingUpcoming.filter((t) => engine.has(t.toUpperCase())),
      ...prioritizeMissingUpcoming(missingUpcoming, emptyAttempts).filter((t) => !engine.has(t.toUpperCase())),
    ];
    const pri = new Set([...prioritizedMissing, ...watch, ...window].map((t) => t.toUpperCase()));
    const priRest = stale.filter((t) => pri.has(t.toUpperCase()) && !prioritizedMissing.includes(t.toUpperCase()));
    ordered = [...prioritizedMissing, ...priRest, ...stale.filter((t) => !pri.has(t.toUpperCase()))];
  }
  const cap = morningish ? MAX_PER_RUN_MORNING : MAX_PER_RUN;
  const batch = ordered.slice(0, cap);

  let written = 0;
  let empty = 0;
  const emptyTickers: string[] = [];
  for (const ticker of batch) {
    try {
      const rows = await fetchLiveEarningsHistory(ticker, trigger);
      if (rows.length > 0) {
        await writeEarningsHistory(ticker, rows);
        written++;
      } else {
        empty++;
        emptyTickers.push(ticker);
      }
    } catch (err) {
      logger.warn({ ticker, err }, "runEarningsHistoryBackfill: ticker failed");
    }
    await sleep(GAP_MS);
  }
  if (emptyTickers.length > 0) {
    await recordEmptyAttempts(emptyTickers).catch((err) => {
      logger.warn({ err }, "A240: recordEmptyAttempts failed");
    });
  }

  logger.info(
    { trigger, universeSize: universeTickers.length, staleCount: stale.length, missingUpcoming: missingUpcoming.length, attempted: batch.length, written, empty, cap },
    "runEarningsHistoryBackfill complete",
  );
  return { attempted: batch.length, written, empty };
}
