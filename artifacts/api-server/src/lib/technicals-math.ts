import { RSI, MFI, ATR, MACD, Stochastic, BollingerBands } from "technicalindicators";

/** Trailing window for percentile inputs — fixed so backfills don't rewrite live scores (A25 T1). */
export const PCT_WINDOW = 252;

/**
 * Fraction of trailing `series` values strictly below `current` ([0,1]).
 * Uses the last `window` finite points (default 252 trading days). `minN` is the
 * minimum sample size — not a lookback (call sites historically misread this).
 */
export function percentileRank(
  current: number,
  series: number[],
  minN = 60,
  window = PCT_WINDOW,
): number | null {
  const finite = series.filter((v) => Number.isFinite(v));
  const sample = finite.length > window ? finite.slice(-window) : finite;
  if (sample.length < minN) return null;
  let below = 0;
  for (const v of sample) if (v < current) below++;
  return below / sample.length;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

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

export function r2(n: number): number { return Math.round(n * 100) / 100; }

// ── OHLCV computation ─────────────────────────────────────────────────────────

export function computeFromOHLCV(closes: number[], highs: number[], lows: number[], volumes: number[]) {
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
