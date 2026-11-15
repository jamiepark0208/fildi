import { yahooFinance } from "./yahoo-client.js";
import { eq, sql, desc, and, inArray } from "drizzle-orm";
import {
  db, tickerTechnicals, indicatorCache, earningsCalendar,
  tickerFundamentals, pricesHistorical, tickerRegistry, tickerAtmIvSnapshots,
  yahooFundamentals,
  type TickerTechnicalsRow,
} from "@workspace/db";
import { readOHLCVFromDB, fetchAndStoreOHLCV, latestOHLCVDate, isOHLCVStale } from "./indicators.js";
import { logger } from "./logger.js";
import { r2, computeFromOHLCV } from "./technicals-math.js";

export { percentileRank, computeFromOHLCV } from "./technicals-math.js";


const STALE_HOURS = 23;

function num(v: number | null | undefined): string | null { return v != null ? String(r2(v)) : null; }

function findClosestStrike(contracts: any[], targetStrike: number): any | null {
  if (!contracts.length) return null;
  return contracts.reduce((best: any, c: any) => {
    const dist = Math.abs((c.strike ?? 0) - targetStrike);
    const bestDist = Math.abs((best.strike ?? 0) - targetStrike);
    return dist < bestDist ? c : best;
  });
}


// ── Options computation ───────────────────────────────────────────────────────

async function fetchOptionsFields(ticker: string, realizedVol20d: number | null): Promise<{
  atmPutIv: number | null;
  impliedMoveWeekly: number | null;
  ivVsRealizedVol: number | null;
  putCallVolumeRatio: number | null;
  basicSkew: number | null;
  ivTermStructure: number | null;
}> {
  const nullResult = {
    atmPutIv: null, impliedMoveWeekly: null, ivVsRealizedVol: null,
    putCallVolumeRatio: null, basicSkew: null, ivTermStructure: null,
  };
  try {
    const raw0 = await (yahooFinance as any).options(ticker, {}, { validateResult: false });
    const spot: number | undefined = raw0?.quote?.regularMarketPrice;
    if (!spot) return nullResult;

    const allDates: Date[] = (raw0.expirationDates ?? []).filter((d: any) => d instanceof Date);
    const now = Date.now();
    const targets = allDates
      .filter(d => { const dte = Math.round((d.getTime() - now) / 86400000); return dte >= 2 && dte <= 21; })
      .slice(0, 2);
    if (targets.length === 0) return nullResult;

    const firstExp = raw0.options?.[0];
    const puts0: any[] = firstExp?.puts ?? [];
    const calls0: any[] = firstExp?.calls ?? [];

    // ATM put IV — closest strike to spot
    const atmPutContract = findClosestStrike(puts0, spot);
    const atmPutIvDecimal: number | null = atmPutContract?.impliedVolatility ?? null;
    // A10: Yahoo nearest-expiry IV is often garbage off-hours (0–0.8 or absurd spikes).
    // Reject instead of writing — leave prior DB value / null rather than poison PREMIUM.
    let atmPutIv = atmPutIvDecimal !== null ? r2(atmPutIvDecimal * 100) : null; // %
    if (atmPutIv != null && (atmPutIv < 5 || atmPutIv > 200)) atmPutIv = null;

    // ATM call IV for straddle / skew
    const atmCallContract = findClosestStrike(calls0, spot);
    const atmCallIvDecimal: number | null = atmCallContract?.impliedVolatility ?? null;

    // Implied move weekly: ATM straddle / spot (preferred), fallback to atmPutIv/sqrt(52)
    let impliedMoveWeekly: number | null = null;
    if (atmPutContract && atmCallContract) {
      const putMid = ((atmPutContract.bid ?? 0) + (atmPutContract.ask ?? 0)) / 2;
      const callMid = ((atmCallContract.bid ?? 0) + (atmCallContract.ask ?? 0)) / 2;
      if (putMid > 0 && callMid > 0) {
        impliedMoveWeekly = r2((putMid + callMid) / spot);
      }
    }
    if (impliedMoveWeekly === null && atmPutIvDecimal !== null) {
      impliedMoveWeekly = r2(atmPutIvDecimal / Math.sqrt(52));
    }

    // ivVsRealizedVol: atmPutIv% / realizedVol20d%
    const ivVsRealizedVol =
      atmPutIv !== null && realizedVol20d !== null && realizedVol20d > 0
        ? r2(atmPutIv / realizedVol20d)
        : null;

    // Put/call volume ratio — sum across all strikes on near expiry
    const totalPutVol = puts0.reduce((s: number, p: any) => s + (p.volume ?? 0), 0);
    const totalCallVol = calls0.reduce((s: number, c: any) => s + (c.volume ?? 0), 0);
    const putCallVolumeRatio = totalCallVol > 0 ? r2(totalPutVol / totalCallVol) : null;

    // Basic skew: OTM put IV - OTM call IV at ~5% OTM distance, stored as % points
    let basicSkew: number | null = null;
    const otmPutContract = findClosestStrike(puts0, spot * 0.95);
    const otmCallContract = findClosestStrike(calls0, spot * 1.05);
    if (otmPutContract?.impliedVolatility != null && otmCallContract?.impliedVolatility != null) {
      basicSkew = r2((otmPutContract.impliedVolatility - otmCallContract.impliedVolatility) * 100);
    }

    // IV term structure: near expiry ATM put IV / far expiry ATM put IV
    let ivTermStructure: number | null = null;
    if (targets.length >= 2) {
      try {
        const raw1 = await (yahooFinance as any).options(ticker, { date: targets[1] }, { validateResult: false });
        const puts1: any[] = raw1?.options?.[0]?.puts ?? [];
        const atmPut1 = findClosestStrike(puts1, spot);
        const iv1: number | null = atmPut1?.impliedVolatility ?? null;
        if (atmPutIvDecimal !== null && iv1 !== null && iv1 > 0) {
          ivTermStructure = r2(atmPutIvDecimal / iv1);
        }
      } catch {}
    }

    return { atmPutIv, impliedMoveWeekly, ivVsRealizedVol, putCallVolumeRatio, basicSkew, ivTermStructure };
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "technicals: options fetch failed, options fields will be null");
    return nullResult;
  }
}

// ── Earnings ─────────────────────────────────────────────────────────────────

async function getEarningsDaysOut(ticker: string): Promise<number | null> {
  try {
    // Prefer earnings_calendar (populated for ~half the universe) over sparse indicator_cache.
    const cal = await db
      .select({ reportDate: earningsCalendar.reportDate })
      .from(earningsCalendar)
      .where(and(
        eq(earningsCalendar.ticker, ticker),
        sql`${earningsCalendar.reportDate} >= CURRENT_DATE`,
      ))
      .orderBy(earningsCalendar.reportDate)
      .limit(1);
    if (cal[0]?.reportDate) {
      const days = Math.round(
        (new Date(String(cal[0].reportDate) + "T12:00:00").getTime() - Date.now()) / 86400000,
      );
      if (days >= 0) return days;
    }

    const rows = await db.select({ earningsDate: indicatorCache.earningsDate })
      .from(indicatorCache)
      .where(eq(indicatorCache.ticker, ticker))
      .orderBy(desc(indicatorCache.scoredDate))
      .limit(1);
    const date = rows[0]?.earningsDate;
    if (!date) return null;
    const days = Math.round((new Date(date + "T12:00:00").getTime() - Date.now()) / 86400000);
    return days >= 0 ? days : null;
  } catch {
    return null;
  }
}

// ── Coverage ──────────────────────────────────────────────────────────────────

const COVERAGE_FIELDS = [
  "rsi14", "rsi14Pct", "mfi14", "mfi14Pct", "stoch", "stochPct",
  "macdHist", "macdDirection", "atr14", "atr14Pct", "rsiVelocity",
  "volumeRatio", "realizedVol20d",
  "bbUpper", "bbWidth", "bbWidthPct", "priceZScore",
  "ma20", "ma50", "ma200", "ma50Slope10d",
  "priceVsMa20Atr", "priceVsMa50Atr",
  "swingHigh20d", "swingLow20d", "vwap20d",
  "pivotPoint", "regime",
  "ivRank", "ivPercentile", "atmPutIv", "impliedMoveWeekly",
] as const;

function computeCoverage(data: Record<string, unknown>): number {
  const nonNull = COVERAGE_FIELDS.filter(f => data[f] != null).length;
  return r2(nonNull / COVERAGE_FIELDS.length);
}

// ── DB operations ─────────────────────────────────────────────────────────────

export async function writeTechnicalsRow(
  ticker: string,
  ohlcv: ReturnType<typeof computeFromOHLCV>,
  opts: Awaited<ReturnType<typeof fetchOptionsFields>>,
  earningsDaysOut: number | null,
  coverage: number,
): Promise<void> {
  const values = {
    ticker: ticker.toUpperCase(),
    technicalsLastFetched: new Date(),
    technicalsCoverage:         num(coverage),

    rsi14:                      num(ohlcv.rsi14),
    rsi14Pct:                   num(ohlcv.rsi14Pct),
    mfi14:                      num(ohlcv.mfi14),
    mfi14Pct:                   num(ohlcv.mfi14Pct),
    stoch:                      num(ohlcv.stoch),
    stochPct:                   num(ohlcv.stochPct),
    macdHist:                   num(ohlcv.macdHist),
    macdDirection:              ohlcv.macdDirection,
    atr14:                      num(ohlcv.atr14),
    atr14Pct:                   num(ohlcv.atr14Pct),
    rsiVelocity:                num(ohlcv.rsiVelocity),

    volumeRatio:                num(ohlcv.volumeRatio),
    volumeRatioPct:             num(ohlcv.volumeRatioPct),

    realizedVol20d:             num(ohlcv.realizedVol20d),
    bbUpper:                    num(ohlcv.bbUpper),
    bbLower:                    num(ohlcv.bbLower),
    bbWidth:                    num(ohlcv.bbWidth),
    bbWidthPct:                 num(ohlcv.bbWidthPct),
    priceZScore:                num(ohlcv.priceZScore),

    ma20:                       num(ohlcv.ma20),
    ma50:                       num(ohlcv.ma50),
    ma200:                      num(ohlcv.ma200),
    ma50Slope10d:               num(ohlcv.ma50Slope10d),
    priceVsMa20Atr:             num(ohlcv.priceVsMa20Atr),
    priceVsMa50Atr:             num(ohlcv.priceVsMa50Atr),
    priceVsMa200Atr:            num(ohlcv.priceVsMa200Atr),

    swingHigh20d:               num(ohlcv.swingHigh20d),
    swingLow20d:                num(ohlcv.swingLow20d),
    swingHigh50d:               num(ohlcv.swingHigh50d),
    swingLow50d:                num(ohlcv.swingLow50d),
    vwap20d:                    num(ohlcv.vwap20d),
    priceVsVwapPct:             num(ohlcv.priceVsVwapPct),
    pivotPoint:                 num(ohlcv.pivotPoint),
    pivotR1:                    num(ohlcv.pivotR1),
    pivotS1:                    num(ohlcv.pivotS1),
    nearestSupportDistPct:      num(ohlcv.nearestSupportDistPct),
    nearestResistDistPct:       num(ohlcv.nearestResistDistPct),

    regime:                     ohlcv.regime,
    fallingKnife:               ohlcv.fallingKnife,

    // ivRank stays RV-proxy for backward compat; scorer prefers hist/cross via enrichment
    ivRank:                     num(ohlcv.ivRank),
    ivPercentile:               num(ohlcv.ivPercentile),
    ivRankSource:               "rv_proxy" as string | null,
    atmPutIv:                   num(opts.atmPutIv),
    impliedMoveWeekly:          num(opts.impliedMoveWeekly),
    ivVsRealizedVol:            num(opts.ivVsRealizedVol),
    putCallVolumeRatio:         num(opts.putCallVolumeRatio),
    basicSkew:                  num(opts.basicSkew),
    ivTermStructure:            num(opts.ivTermStructure),

    // Tier 2 — always null
    gexNet: null, putWallStrike: null, callWallStrike: null, maxPainStrike: null, deltaSkew25: null,

    earningsDaysOut,
  };

  // Off-hours / garbage options: never overwrite a good prior IV with null (A10).
  await db.insert(tickerTechnicals)
    .values(values)
    .onConflictDoUpdate({
      target: tickerTechnicals.ticker,
      set: {
        ...values,
        ticker: undefined,
        atmPutIv: opts.atmPutIv != null
          ? num(opts.atmPutIv)
          : sql`${tickerTechnicals.atmPutIv}`,
        impliedMoveWeekly: opts.impliedMoveWeekly != null
          ? num(opts.impliedMoveWeekly)
          : sql`${tickerTechnicals.impliedMoveWeekly}`,
        ivVsRealizedVol: opts.ivVsRealizedVol != null
          ? num(opts.ivVsRealizedVol)
          : sql`${tickerTechnicals.ivVsRealizedVol}`,
      },
    });

  // Daily ATM IV snapshot — builds true IV-rank history over time (skip garbage/null)
  if (opts.atmPutIv != null && Number.isFinite(opts.atmPutIv) && opts.atmPutIv >= 5 && opts.atmPutIv <= 200) {
    const asOf = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    await db.insert(tickerAtmIvSnapshots)
      .values({
        ticker: ticker.toUpperCase(),
        asOf,
        atmPutIv: String(opts.atmPutIv),
        ivVsRealized: opts.ivVsRealizedVol != null ? String(opts.ivVsRealizedVol) : null,
      })
      .onConflictDoUpdate({
        target: [tickerAtmIvSnapshots.ticker, tickerAtmIvSnapshots.asOf],
        set: {
          atmPutIv: String(opts.atmPutIv),
          ivVsRealized: opts.ivVsRealizedVol != null ? String(opts.ivVsRealizedVol) : null,
        },
      });
  }
}

export async function readTechnicalsRow(ticker: string): Promise<TickerTechnicalsRow | null> {
  const rows = await db.select().from(tickerTechnicals)
    .where(eq(tickerTechnicals.ticker, ticker.toUpperCase()))
    .limit(1);
  return rows[0] ?? null;
}

/** Enriched technicals row for V2/V4 scorer — gold TP, peer group, vsSpy, hist IV rank, short. */
export type TechnicalsApiRow = TickerTechnicalsRow & {
  peerGroupId: string | null;
  analystUpside: number | null;
  vsSpy20d: number | null;
  ivRankEffective: number | null;
  shortRatio: number | null;
};

export async function getAllTechnicalsRows(): Promise<TechnicalsApiRow[]> {
  // 10-22: deactivated registry names (delisted/renamed) keep stale technicals rows → never serve them.
  const techRows = await db.select().from(tickerTechnicals).where(sql`NOT EXISTS (
    SELECT 1 FROM ticker_registry r WHERE r.ticker = ${tickerTechnicals.ticker} AND r.is_active = false)`);
  if (techRows.length === 0) return [];

  const tickers = techRows.map((r) => r.ticker);

  const [regRows, fundRows, pxRows, spyRows, ivRankDailyRows, ivSnapRows, shortRows] = await Promise.all([
    db
      .select({
        ticker: tickerRegistry.ticker,
        peerGroupId: tickerRegistry.primaryPeerGroupId,
      })
      .from(tickerRegistry)
      .where(inArray(tickerRegistry.ticker, tickers)),
    db
      .select({
        ticker: tickerFundamentals.ticker,
        target: tickerFundamentals.analystTargetPrice,
      })
      .from(tickerFundamentals)
      .where(inArray(tickerFundamentals.ticker, tickers)),
    db.execute(sql`
      SELECT DISTINCT ON (ticker) ticker, close::float8 AS close
      FROM prices_historical
      WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
      ORDER BY ticker, date DESC
    `),
    // 20d returns for SPY + all tickers (2 closes ~20 trading days apart)
    db.execute(sql`
      WITH ranked AS (
        SELECT ticker, date, close::float8 AS close,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM prices_historical
        WHERE ticker IN (${sql.join([...tickers, "SPY"].map((t) => sql`${t}`), sql`, `)})
      )
      SELECT ticker,
             MAX(close) FILTER (WHERE rn = 1) AS close_now,
             MAX(close) FILTER (WHERE rn = 21) AS close_20d
      FROM ranked
      WHERE rn IN (1, 21)
      GROUP BY ticker
    `),
    // Canonical 1-year IV percentile resolver (watchlist_sync.iv_rank_daily: LSEG → none, FACTOR_MAP single home)
    db.execute(sql`
      SELECT DISTINCT ON (ticker) ticker, pctile::float8 AS pctile, source
      FROM watchlist_sync.iv_rank_daily
      WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
        AND date >= (CURRENT_DATE - INTERVAL '14 days')
        AND pctile IS NOT NULL
      ORDER BY ticker, date DESC
    `).catch(() => ({ rows: [] })),
    db.execute(sql`
      SELECT ticker, atm_put_iv::float8 AS atm_put_iv
      FROM ticker_atm_iv_snapshots
      WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
        AND as_of >= (CURRENT_DATE - INTERVAL '400 days')
      ORDER BY ticker, as_of
    `),
    db
      .select({
        ticker: yahooFundamentals.ticker,
        shortRatio: yahooFundamentals.yahooShortRatio,
      })
      .from(yahooFundamentals)
      .where(inArray(yahooFundamentals.ticker, tickers)),
  ]);

  const peerBy = new Map(regRows.map((r) => [r.ticker, r.peerGroupId ?? null]));
  const tpBy = new Map(
    fundRows.map((r) => [r.ticker, r.target != null ? parseFloat(String(r.target)) : null]),
  );
  const pxBy = new Map<string, number>();
  for (const r of ((pxRows as any).rows ?? pxRows) as any[]) {
    if (r.close != null && Number(r.close) > 0) pxBy.set(String(r.ticker), Number(r.close));
  }

  // vsSpy20d = ticker 20d return − SPY 20d return (percentage points)
  const ret20 = new Map<string, number>();
  for (const r of ((spyRows as any).rows ?? spyRows) as any[]) {
    const now = Number(r.close_now);
    const past = Number(r.close_20d);
    if (now > 0 && past > 0) ret20.set(String(r.ticker), ((now / past) - 1) * 100);
  }
  const spyRet = ret20.get("SPY") ?? null;

  // Canonical 1-yr IV percentile from watchlist_sync.iv_rank_daily (FACTOR_MAP single home)
  const ivRankResolverBy = new Map<string, { pctile: number; source: string }>();
  for (const r of ((ivRankDailyRows as any).rows ?? ivRankDailyRows) as any[]) {
    const p = Number(r.pctile);
    if (Number.isFinite(p) && p >= 0 && p <= 1) {
      ivRankResolverBy.set(String(r.ticker), { pctile: p, source: String(r.source ?? "lseg") });
    }
  }

  // Hist ATM IV series per ticker (fallback when resolver lacks coverage)
  const ivHist = new Map<string, number[]>();
  for (const r of ((ivSnapRows as any).rows ?? ivSnapRows) as any[]) {
    const t = String(r.ticker);
    const iv = Number(r.atm_put_iv);
    if (!Number.isFinite(iv) || iv <= 0) continue;
    if (!ivHist.has(t)) ivHist.set(t, []);
    ivHist.get(t)!.push(iv);
  }

  const shortBy = new Map<string, number | null>();
  for (const r of shortRows) {
    const n = r.shortRatio != null ? parseFloat(String(r.shortRatio)) : NaN;
    shortBy.set(r.ticker, Number.isFinite(n) && n > 0 ? n : null);
  }

  return techRows.map((r) => {
    const tp = tpBy.get(r.ticker);
    const px = pxBy.get(r.ticker);
    const analystUpside =
      tp != null && Number.isFinite(tp) && tp > 0 && px != null && px > 0 ? tp / px - 1 : null;

    const tRet = ret20.get(r.ticker) ?? null;
    const vsSpy20d =
      tRet != null && spyRet != null ? parseFloat((tRet - spyRet).toFixed(2)) : null;

    // Prefer canonical iv_rank_daily resolver; fall back to local ATM IV snapshots (≥10 obs)
    let ivRankEffective: number | null = null;
    let ivRankSource = r.ivRankSource;
    const resolved = ivRankResolverBy.get(r.ticker);
    if (resolved) {
      ivRankEffective = resolved.pctile;
      ivRankSource = resolved.source;
    } else {
      const series = ivHist.get(r.ticker);
      const curIv = r.atmPutIv != null ? parseFloat(String(r.atmPutIv)) : NaN;
      if (series && series.length >= 10 && Number.isFinite(curIv) && curIv > 0) {
        let below = 0;
        for (const v of series) if (v < curIv) below++;
        ivRankEffective = below / series.length;
        ivRankSource = "atm_snapshots";
      }
    }

    return {
      ...r,
      ivRankSource,
      peerGroupId: peerBy.get(r.ticker) ?? null,
      analystUpside,
      vsSpy20d,
      ivRankEffective,
      shortRatio: shortBy.get(r.ticker) ?? null,
    };
  });
}

/** Seed today's ATM IV snapshots from existing ticker_technicals.atm_put_iv (one-shot bootstrap). */
export async function seedAtmIvSnapshotsFromTechnicals(): Promise<{ inserted: number }> {
  const result = await db.execute(sql`
    INSERT INTO ticker_atm_iv_snapshots (ticker, as_of, atm_put_iv, iv_vs_realized)
    SELECT ticker,
           (CURRENT_DATE AT TIME ZONE 'America/New_York')::date,
           atm_put_iv,
           iv_vs_realized_vol
    FROM ticker_technicals
    WHERE atm_put_iv IS NOT NULL
      AND atm_put_iv::float8 > 0
    ON CONFLICT (ticker, as_of) DO UPDATE SET
      atm_put_iv = EXCLUDED.atm_put_iv,
      iv_vs_realized = EXCLUDED.iv_vs_realized
    RETURNING ticker
  `);
  return { inserted: ((result as any).rows ?? result)?.length ?? 0 };
}

/** Fast DB-only backfill of earnings_days_out from earnings_calendar (no Yahoo). */
export async function backfillEarningsDaysOut(): Promise<{ updated: number; withDate: number }> {
  const result = await db.execute(sql`
    WITH next_earn AS (
      SELECT ticker, MIN(report_date) AS next_d
      FROM earnings_calendar
      WHERE report_date >= CURRENT_DATE
      GROUP BY ticker
    )
    UPDATE ticker_technicals t
    SET earnings_days_out = (n.next_d - CURRENT_DATE)
    FROM next_earn n
    WHERE n.ticker = t.ticker
    RETURNING t.ticker
  `);
  const updated = ((result as any).rows ?? result)?.length ?? 0;
  const withDate = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM ticker_technicals WHERE earnings_days_out IS NOT NULL
  `);
  return {
    updated,
    withDate: Number(((withDate as any).rows?.[0] ?? withDate)?.n ?? 0),
  };
}

export async function getStaleTechnicalTickers(allTickers: string[]): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
  const freshRows = await db.select({ ticker: tickerTechnicals.ticker })
    .from(tickerTechnicals)
    .where(sql`${tickerTechnicals.technicalsLastFetched} > ${cutoff}`);
  const freshSet = new Set(freshRows.map(r => r.ticker.toUpperCase()));
  return allTickers.map(t => t.toUpperCase()).filter(t => !freshSet.has(t));
}

export async function getAllTechnicalsStatus(): Promise<
  Array<{ ticker: string; lastFetched: Date | null; coveragePct: number | null }>
> {
  const rows = await db.select({
    ticker:                tickerTechnicals.ticker,
    technicalsLastFetched: tickerTechnicals.technicalsLastFetched,
    technicalsCoverage:    tickerTechnicals.technicalsCoverage,
  }).from(tickerTechnicals);

  return rows.map(r => ({
    ticker:      r.ticker,
    lastFetched: r.technicalsLastFetched ?? null,
    coveragePct: r.technicalsCoverage != null ? parseFloat(r.technicalsCoverage) * 100 : null,
  }));
}

// ── Per-ticker computation ────────────────────────────────────────────────────

async function computeTechnicals(ticker: string): Promise<void> {
  const key = ticker.toUpperCase();

  let rows = await readOHLCVFromDB(key);
  // Must refresh when the latest bar is stale — NOT only when row-count < 200.
  // Bug A12: once a ticker had ≥200 bars in the cutoff window, daily technicals
  // kept recomputing from a frozen July series and never appended new closes.
  const latest = await latestOHLCVDate(key);
  if (rows.length < 200 || isOHLCVStale(latest)) {
    try {
      rows = await fetchAndStoreOHLCV(key);
      logger.info({ ticker: key, rows: rows.length, prevLatest: latest }, "technicals: fetched OHLCV history");
    } catch (err) {
      logger.warn({ ticker: key, err: String(err) }, "technicals: OHLCV bootstrap failed, using cached data");
    }
  }
  if (rows.length < 60) {
    logger.warn({ ticker: key, rows: rows.length }, "technicals: insufficient OHLCV, skipping");
    return;
  }

  const closes  = rows.map(r => r.close);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  const ohlcv = computeFromOHLCV(closes, highs, lows, volumes);
  const opts  = await fetchOptionsFields(key, ohlcv.realizedVol20d);
  const earningsDaysOut = await getEarningsDaysOut(key);

  const allData: Record<string, unknown> = { ...ohlcv, ...opts, earningsDaysOut };
  const coverage = computeCoverage(allData);

  await writeTechnicalsRow(key, ohlcv, opts, earningsDaysOut, coverage);
  logger.debug({ ticker: key, coverage }, "technicals: ticker computed");
}

export async function refreshTechnicalsForTicker(ticker: string): Promise<TickerTechnicalsRow | null> {
  const key = ticker.toUpperCase();
  await computeTechnicals(key);
  return readTechnicalsRow(key);
}

// ── Batch refresh (exported for route + startup) ──────────────────────────────

export async function refreshTechnicals(tickers: string[]): Promise<void> {
  logger.info({ count: tickers.length }, "technicals: starting refresh");
  const BATCH = 3;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.all(batch.map(t =>
      computeTechnicals(t).catch(err =>
        logger.warn({ ticker: t, err: String(err?.message ?? err) }, "technicals: ticker failed")
      )
    ));
    if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 500));
  }
  logger.info({ count: tickers.length }, "technicals: refresh complete");
  try {
    const { persistTechScoreSnapshots } = await import("./tech-score-snapshots.js");
    await persistTechScoreSnapshots({ trigger: "technicals_refresh" });
  } catch (err) {
    logger.warn({ err: String(err) }, "technicals: tech_score_snapshots persist failed");
  }
}
