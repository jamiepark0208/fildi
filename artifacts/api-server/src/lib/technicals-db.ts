import YahooFinanceClass from "yahoo-finance2";
import { RSI, MFI, ATR, MACD, Stochastic, BollingerBands } from "technicalindicators";
import { eq, sql, desc } from "drizzle-orm";
import { db, tickerTechnicals, indicatorCache, type TickerTechnicalsRow } from "@workspace/db";
import { readOHLCVFromDB, fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

const STALE_HOURS = 23;

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Fraction of `series` values strictly below `current`. [0,1]. Null if fewer than minN finite values. */
function percentileRank(current: number, series: number[], minN = 60): number | null {
  const finite = series.filter(v => Number.isFinite(v));
  if (finite.length < minN) return null;
  let below = 0;
  for (const v of finite) if (v < current) below++;
  return below / finite.length;
}

/** Compare recent slope of histogram vs noise. */
function macdTrendDirection(histSeries: number[]): "UP" | "DOWN" | "FLAT" | null {
  if (histSeries.length < 4) return null;
  const recent = histSeries.slice(-3);
  const slope = recent[recent.length - 1] - recent[0];
  const noise = Math.max(0.001, Math.abs(recent[0]) * 0.05);
  if (slope > noise) return "UP";
  if (slope < -noise) return "DOWN";
  return "FLAT";
}

function simpleSMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const sl = values.slice(-period);
  return sl.reduce((s, v) => s + v, 0) / period;
}

function swingHighLow(closes: number[], lookback: number): { high: number | null; low: number | null } {
  if (closes.length < lookback + 4) return { high: null, low: null };
  const slice = closes.slice(-(lookback + 4));
  let high: number | null = null;
  let low: number | null = null;
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c > slice[i - 2] && c > slice[i + 2]) {
      if (high === null || c > high) high = c;
    }
    if (c < slice[i - 2] && c < slice[i + 2]) {
      if (low === null || c < low) low = c;
    }
  }
  return { high, low };
}

function r2(n: number): number { return Math.round(n * 100) / 100; }
function num(v: number | null | undefined): string | null { return v != null ? String(r2(v)) : null; }

function findClosestStrike(contracts: any[], targetStrike: number): any | null {
  if (!contracts.length) return null;
  return contracts.reduce((best: any, c: any) => {
    const dist = Math.abs((c.strike ?? 0) - targetStrike);
    const bestDist = Math.abs((best.strike ?? 0) - targetStrike);
    return dist < bestDist ? c : best;
  });
}

// ── OHLCV computation ─────────────────────────────────────────────────────────

function computeFromOHLCV(closes: number[], highs: number[], lows: number[], volumes: number[]) {
  const price = closes[closes.length - 1];

  // ── RSI ──────────────────────────────────────────────────────────────────────
  let rsi14: number | null = null;
  let rsi14Pct: number | null = null;
  let rsiVelocity: number | null = null;
  try {
    const rsiSeries = RSI.calculate({ period: 14, values: closes });
    if (rsiSeries.length > 0) {
      rsi14 = r2(rsiSeries[rsiSeries.length - 1]);
      rsi14Pct = percentileRank(rsi14, rsiSeries, 20);
      if (rsiSeries.length >= 4) {
        rsiVelocity = r2(rsi14 - rsiSeries[rsiSeries.length - 4]);
      }
    }
  } catch {}

  // ── MFI ──────────────────────────────────────────────────────────────────────
  let mfi14: number | null = null;
  let mfi14Pct: number | null = null;
  try {
    const mfiSeries = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });
    if (mfiSeries.length > 0) {
      mfi14 = r2(mfiSeries[mfiSeries.length - 1]);
      mfi14Pct = percentileRank(mfi14, mfiSeries, 20);
    }
  } catch {}

  // ── Stochastic ───────────────────────────────────────────────────────────────
  let stoch: number | null = null;
  let stochPct: number | null = null;
  try {
    const stochSeries = Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: closes });
    const kSeries = stochSeries.map(s => s.k);
    if (kSeries.length > 0) {
      stoch = r2(kSeries[kSeries.length - 1]);
      stochPct = percentileRank(stoch, kSeries, 20);
    }
  } catch {}

  // ── MACD ─────────────────────────────────────────────────────────────────────
  let macdHist: number | null = null;
  let macdDirection: "UP" | "DOWN" | "FLAT" | null = null;
  try {
    const macdSeries = MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      values: closes, SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const histSeries = macdSeries
      .filter(v => v.MACD != null && v.signal != null)
      .map(v => v.MACD! - v.signal!);
    if (histSeries.length > 0) {
      macdHist = r2(histSeries[histSeries.length - 1]);
      macdDirection = macdTrendDirection(histSeries);
    }
  } catch {}

  // ── ATR ───────────────────────────────────────────────────────────────────────
  let atr14: number | null = null;
  let atr14Pct: number | null = null;
  try {
    const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    if (atrSeries.length > 0) {
      atr14 = r2(atrSeries[atrSeries.length - 1]);
      atr14Pct = percentileRank(atr14, atrSeries, 20);
    }
  } catch {}

  // ── Volume ratio ─────────────────────────────────────────────────────────────
  let volumeRatio: number | null = null;
  let volumeRatioPct: number | null = null;
  if (volumes.length >= 21) {
    const prior20 = volumes.slice(-21, -1);
    const avgVol = prior20.reduce((s, v) => s + v, 0) / 20;
    if (avgVol > 0) {
      volumeRatio = r2(volumes[volumes.length - 1] / avgVol);
      const volRatioSeries: number[] = [];
      for (let i = 20; i < volumes.length; i++) {
        const window = volumes.slice(i - 20, i);
        const avg = window.reduce((s, v) => s + v, 0) / 20;
        if (avg > 0) volRatioSeries.push(volumes[i] / avg);
      }
      volumeRatioPct = percentileRank(volumeRatio, volRatioSeries, 30);
    }
  }

  // ── Realized volatility 20d ───────────────────────────────────────────────────
  let realizedVol20d: number | null = null;
  if (closes.length >= 21) {
    const sl = closes.slice(-21);
    const lr = sl.slice(1).map((c, i) => Math.log(c / sl[i]));
    const mean = lr.reduce((s, v) => s + v, 0) / lr.length;
    const variance = lr.reduce((s, v) => s + (v - mean) ** 2, 0) / (lr.length - 1);
    realizedVol20d = r2(Math.sqrt(variance * 252) * 100);
  }

  // ivRank / ivPercentile from realized vol rolling history
  // NOTE: true ATM IV rank requires historical options data (not yet stored).
  //       Using realized vol percentile as proxy — correlated but not identical.
  let ivRank: number | null = null;
  let ivPercentile: number | null = null;
  if (closes.length >= 31 && realizedVol20d !== null) {
    const volSeries: number[] = [];
    for (let end = 30; end < closes.length; end++) {
      const sl = closes.slice(end - 30, end + 1);
      const lr = sl.slice(1).map((c, i) => Math.log(c / sl[i]));
      const m = lr.reduce((s, v) => s + v, 0) / lr.length;
      const vr = lr.reduce((s, v) => s + (v - m) ** 2, 0) / (lr.length - 1);
      volSeries.push(Math.sqrt(vr * 252) * 100);
    }
    ivRank = percentileRank(realizedVol20d, volSeries, 20);
    if (ivRank !== null) ivPercentile = r2(ivRank * 100);
  }

  // ── Bollinger Bands ───────────────────────────────────────────────────────────
  let bbUpper: number | null = null;
  let bbLower: number | null = null;
  let bbWidth: number | null = null;
  let bbWidthPct: number | null = null;
  try {
    const bbSeries = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    if (bbSeries.length > 0) {
      const last = bbSeries[bbSeries.length - 1];
      bbUpper = r2(last.upper);
      bbLower = r2(last.lower);
      if (last.middle > 0) {
        bbWidth = r2((last.upper - last.lower) / last.middle);
        const widthSeries = bbSeries.map(b => (b.upper - b.lower) / b.middle);
        bbWidthPct = percentileRank(bbWidth, widthSeries, 30);
      }
    }
  } catch {}

  // ── Price Z-Score vs 20d ──────────────────────────────────────────────────────
  let priceZScore: number | null = null;
  if (closes.length >= 20) {
    const w20 = closes.slice(-20);
    const mean20 = w20.reduce((s, v) => s + v, 0) / 20;
    const std20 = Math.sqrt(w20.reduce((s, v) => s + (v - mean20) ** 2, 0) / 19);
    priceZScore = std20 > 0 ? r2((price - mean20) / std20) : 0;
  }

  // ── Moving averages ───────────────────────────────────────────────────────────
  const ma20v = simpleSMA(closes, 20);
  const ma50v = simpleSMA(closes, 50);
  const ma200v = simpleSMA(closes, 200);

  let ma50Slope10d: number | null = null;
  if (closes.length >= 60 && ma50v !== null) {
    const ma50Past = simpleSMA(closes.slice(0, -10), 50);
    if (ma50Past !== null && ma50Past > 0) {
      ma50Slope10d = r2((ma50v - ma50Past) / ma50Past);
    }
  }

  const priceVsMa20Atr = (ma20v !== null && atr14 !== null && atr14 > 0) ? r2((price - ma20v) / atr14) : null;
  const priceVsMa50Atr = (ma50v !== null && atr14 !== null && atr14 > 0) ? r2((price - ma50v) / atr14) : null;
  const priceVsMa200Atr = (ma200v !== null && atr14 !== null && atr14 > 0) ? r2((price - ma200v) / atr14) : null;

  // ── Support / Resistance ─────────────────────────────────────────────────────
  const { high: swingHigh20d, low: swingLow20d } = swingHighLow(closes, 20);
  const { high: swingHigh50d, low: swingLow50d } = swingHighLow(closes, 50);

  let vwap20d: number | null = null;
  let priceVsVwapPct: number | null = null;
  if (closes.length >= 20 && volumes.length >= 20) {
    const vClose = closes.slice(-20);
    const vVol = volumes.slice(-20);
    const sumCV = vClose.reduce((s, c, i) => s + c * vVol[i], 0);
    const sumV = vVol.reduce((s, v) => s + v, 0);
    if (sumV > 0) {
      vwap20d = r2(sumCV / sumV);
      priceVsVwapPct = r2((price - vwap20d) / vwap20d * 100);
    }
  }

  let pivotPoint: number | null = null;
  let pivotR1: number | null = null;
  let pivotS1: number | null = null;
  if (highs.length >= 2) {
    const pH = highs[highs.length - 2];
    const pL = lows[lows.length - 2];
    const pC = closes[closes.length - 2];
    pivotPoint = r2((pH + pL + pC) / 3);
    pivotR1 = r2(2 * pivotPoint - pL);
    pivotS1 = r2(2 * pivotPoint - pH);
  }

  const supports = [swingLow20d, pivotS1].filter((v): v is number => v !== null);
  const resistances = [swingHigh20d, pivotR1].filter((v): v is number => v !== null);
  const nearestSupportDistPct = supports.length > 0
    ? r2(Math.min(...supports.map(s => Math.abs(price - s) / price * 100)))
    : null;
  const nearestResistDistPct = resistances.length > 0
    ? r2(Math.min(...resistances.map(r => Math.abs(r - price) / price * 100)))
    : null;

  // ── Regime ────────────────────────────────────────────────────────────────────
  let regime: "BULLISH" | "NEUTRAL" | "BEARISH" = "NEUTRAL";
  if (ma50v !== null && ma200v !== null && ma50Slope10d !== null) {
    if (price > ma50v && ma50v > ma200v && ma50Slope10d > 0) regime = "BULLISH";
    else if (price < ma50v && ma50v < ma200v && ma50Slope10d < 0) regime = "BEARISH";
  }

  const fallingKnife =
    priceVsMa50Atr !== null && priceVsMa50Atr < -2.0 &&
    priceVsMa200Atr !== null && priceVsMa200Atr < -2.0 &&
    macdDirection === "DOWN" ? 1 : 0;

  return {
    rsi14, rsi14Pct, mfi14, mfi14Pct, stoch, stochPct,
    macdHist, macdDirection,
    atr14, atr14Pct, rsiVelocity,
    volumeRatio, volumeRatioPct,
    realizedVol20d,
    ivRank, ivPercentile,
    bbUpper, bbLower, bbWidth, bbWidthPct,
    priceZScore,
    ma20: ma20v !== null ? r2(ma20v) : null,
    ma50: ma50v !== null ? r2(ma50v) : null,
    ma200: ma200v !== null ? r2(ma200v) : null,
    ma50Slope10d, priceVsMa20Atr, priceVsMa50Atr, priceVsMa200Atr,
    swingHigh20d, swingLow20d, swingHigh50d, swingLow50d,
    vwap20d, priceVsVwapPct,
    pivotPoint, pivotR1, pivotS1,
    nearestSupportDistPct, nearestResistDistPct,
    regime, fallingKnife,
  };
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
    const atmPutIv = atmPutIvDecimal !== null ? r2(atmPutIvDecimal * 100) : null; // convert to %

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
    const rows = await db.select({ earningsDate: indicatorCache.earningsDate })
      .from(indicatorCache)
      .where(eq(indicatorCache.ticker, ticker))
      .orderBy(desc(indicatorCache.scoredDate))
      .limit(1);
    const date = rows[0]?.earningsDate;
    if (!date) return null;
    const days = Math.round((new Date(date + "T12:00:00").getTime() - Date.now()) / 86400000);
    return days > 0 ? days : null;
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

    ivRank:                     num(ohlcv.ivRank),
    ivPercentile:               num(ohlcv.ivPercentile),
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

  await db.insert(tickerTechnicals)
    .values(values)
    .onConflictDoUpdate({ target: tickerTechnicals.ticker, set: { ...values, ticker: undefined } });
}

export async function readTechnicalsRow(ticker: string): Promise<TickerTechnicalsRow | null> {
  const rows = await db.select().from(tickerTechnicals)
    .where(eq(tickerTechnicals.ticker, ticker.toUpperCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllTechnicalsRows(): Promise<TickerTechnicalsRow[]> {
  return db.select().from(tickerTechnicals);
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
  // Bootstrap: if fewer than 200 trading rows, fetch the full 420-day window from Yahoo.
  // This is a one-time cost per ticker until pricesHistorical is fully populated.
  if (rows.length < 200) {
    try {
      rows = await fetchAndStoreOHLCV(key);
      logger.info({ ticker: key, rows: rows.length }, "technicals: fetched OHLCV history");
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
}
