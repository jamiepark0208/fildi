export const MIN_Z_N = 8;
export const MIN_TIGHT_N = 20;   // groups ≥ this use 2nd/98th winsorization
export const MAX_CASH_RUNWAY_QUARTERS = 20;
export const MAX_INTEREST_COVERAGE = 50;
export const MIN_SECTOR_N = 6;

export function safeDiv(
  num: number | null | undefined,
  den: number | null | undefined,
): number | null {
  if (num == null || den == null || den === 0 || !isFinite(den) || !isFinite(num)) return null;
  const r = num / den;
  return isFinite(r) ? r : null;
}

export function winsorize(
  values: (number | null)[],
  pLow = 0.05,
  pHigh = 0.95,
): (number | null)[] {
  const finite = values
    .filter((v): v is number => v != null && isFinite(v))
    .sort((a, b) => a - b);
  if (finite.length < 3) return values;
  const lo = finite[Math.floor((finite.length - 1) * pLow)];
  const hi = finite[Math.ceil((finite.length - 1) * pHigh)];
  return values.map(v => (v == null || !isFinite(v) ? null : Math.max(lo, Math.min(hi, v))));
}

export interface NormalizeOptions {
  higherIsBetter: boolean;
}

/**
 * Auto-selects z-score (winsorized) when >= MIN_Z_N non-null values exist in the group,
 * otherwise ordinal rank. Both return [0,1] scores; nulls remain null.
 * Safe for the 5-ticker compare view (n<8 → ordinal rank, no z-score instability).
 */
export function normalize(
  values: (number | null)[],
  opts: NormalizeOptions,
): (number | null)[] {
  const nonNull: { v: number; i: number }[] = [];
  values.forEach((v, i) => {
    if (v != null && isFinite(v)) nonNull.push({ v, i });
  });

  const out: (number | null)[] = values.map(() => null);
  if (nonNull.length === 0) return out;

  if (nonNull.length >= MIN_Z_N) {
    // Winsorized z-score path — tighter bounds for large groups
    const winsorized = nonNull.length >= MIN_TIGHT_N
      ? winsorize(values, 0.02, 0.98)
      : winsorize(values);
    const wNonNull = nonNull.map(({ i }) => winsorized[i] as number);
    const mean = wNonNull.reduce((s, v) => s + v, 0) / wNonNull.length;
    const variance = wNonNull.reduce((s, v) => s + (v - mean) ** 2, 0) / wNonNull.length;
    const std = Math.sqrt(variance);

    nonNull.forEach(({ i }) => {
      const wv = winsorized[i] as number;
      // std === 0 means all values are equal → neutral 0.5
      let z = std === 0 ? 0 : (wv - mean) / std;
      z = Math.max(-3, Math.min(3, z));
      const score01 = (z + 3) / 6;
      out[i] = opts.higherIsBetter ? score01 : 1 - score01;
    });
  } else {
    // Ordinal rank path — best gets 1.0, worst gets 0.0, single value gets 1.0
    const sorted = [...nonNull].sort((a, b) =>
      opts.higherIsBetter ? b.v - a.v : a.v - b.v,
    );
    sorted.forEach(({ i }, rankIdx) => {
      out[i] =
        nonNull.length > 1 ? (nonNull.length - 1 - rankIdx) / (nonNull.length - 1) : 1;
    });
  }

  return out;
}

// ─── Phase 2: Safety / Quality helper functions ──────────────────────────────

/**
 * Cash runway in quarters. Infinity when OCF ≥ 0 (no burn).
 * Result capped at MAX_CASH_RUNWAY_QUARTERS when there is a burn rate.
 * Null when either input is missing.
 */
export function cashRunway(
  cash: number | null | undefined,
  quarterlyOCF: number | null | undefined,
): number | null {
  if (cash == null || quarterlyOCF == null || !isFinite(cash) || !isFinite(quarterlyOCF))
    return null;
  if (quarterlyOCF >= 0) return Infinity;
  const quarters = cash / Math.abs(quarterlyOCF);
  return isFinite(quarters) ? Math.min(MAX_CASH_RUNWAY_QUARTERS, quarters) : null;
}

/**
 * Share-count dilution rate: (current - prior) / prior. Positive = dilution, negative = buyback.
 * Clamped to [-0.5, 1.0]. Null when either input is missing or prior is 0.
 */
export function dilutionRate(
  current: number | null | undefined,
  prior: number | null | undefined,
): number | null {
  if (current == null || prior == null || !isFinite(current) || !isFinite(prior) || prior === 0)
    return null;
  const rate = (current - prior) / prior;
  return isFinite(rate) ? Math.max(-0.5, Math.min(1.0, rate)) : null;
}

/**
 * Interest coverage ratio: EBIT / interestExpense, capped at MAX_INTEREST_COVERAGE.
 * Returns MAX_INTEREST_COVERAGE when interestExpense is 0 (debt-free = best coverage).
 * Null when EBIT or interestExpense is missing. Negative values (distressed) are valid.
 */
export function interestCoverage(
  ebit: number | null | undefined,
  interestExpense: number | null | undefined,
): number | null {
  if (ebit == null || interestExpense == null || !isFinite(ebit) || !isFinite(interestExpense))
    return null;
  if (interestExpense === 0) return MAX_INTEREST_COVERAGE;
  const ratio = ebit / interestExpense;
  if (!isFinite(ratio)) return null;
  return Math.min(MAX_INTEREST_COVERAGE, ratio);
}

export interface WACCParams {
  beta: number | null | undefined;
  totalDebt: number | null | undefined;
  totalStockholdersEquity: number | null | undefined;
  effectiveTaxRate: number | null | undefined;
  interestExpense: number | null | undefined;
  riskFreeRate?: number;       // default 0.045
  equityRiskPremium?: number;  // default 0.055
}

/**
 * Approximate WACC via CAPM. Use only as fallback when FMP wacc is null.
 * Returns decimal (e.g. 0.09 = 9%). Null when beta or equity is missing.
 */
export function approxWACC(params: WACCParams): number | null {
  const { beta, totalStockholdersEquity, effectiveTaxRate, interestExpense } = params;
  const rfr = params.riskFreeRate ?? 0.045;
  const erp = params.equityRiskPremium ?? 0.055;

  if (beta == null || !isFinite(beta)) return null;
  if (totalStockholdersEquity == null || !isFinite(totalStockholdersEquity)) return null;

  const costOfEquity = rfr + beta * erp;
  const debt = (params.totalDebt != null && isFinite(params.totalDebt)) ? params.totalDebt : 0;
  const taxRate =
    effectiveTaxRate != null && isFinite(effectiveTaxRate)
      ? Math.max(0, Math.min(1, effectiveTaxRate))
      : 0.21;

  let costOfDebt: number;
  if (debt <= 0 || interestExpense == null || !isFinite(interestExpense) || interestExpense <= 0) {
    costOfDebt = rfr;
  } else {
    costOfDebt = Math.max(rfr, interestExpense / debt);
  }

  const afterTaxCostOfDebt = costOfDebt * (1 - taxRate);
  const totalCapital = debt + totalStockholdersEquity;
  if (totalCapital <= 0 || !isFinite(totalCapital)) return null;

  const equityWeight = totalStockholdersEquity / totalCapital;
  const debtWeight = debt / totalCapital;
  const wacc = equityWeight * costOfEquity + debtWeight * afterTaxCostOfDebt;
  return isFinite(wacc) ? wacc : null;
}

/**
 * ROIC minus WACC spread. Positive = value creation, negative = value destruction.
 * Both inputs expected as decimals (e.g. 0.15 = 15%). Null when either is missing.
 */
export function roicWaccSpread(
  roic: number | null | undefined,
  wacc: number | null | undefined,
): number | null {
  if (roic == null || wacc == null || !isFinite(roic) || !isFinite(wacc)) return null;
  return roic - wacc;
}

// ─── Phase 2 (Technical V2): Self-relative scoring helpers ───────────────────
// All functions are pure, self-contained, and operate on a single ticker's own
// history. No cross-sectional comparison. Used by computeTechnicalRankingsV2.

/**
 * Fraction of `series` values strictly below `current`. Result in [0,1].
 * 0.0 = at/below minimum (most oversold for this stock).
 * 1.0 = at/above maximum (most overbought).
 * Linear interpolation is NOT applied — this is a strict rank fraction.
 * Returns null if fewer than `minN` finite values exist in `series`.
 */
export function percentileRank(
  current: number,
  series: number[],
  minN = 60,
): number | null {
  if (!isFinite(current)) return null;
  const finite = series.filter(v => isFinite(v));
  if (finite.length < minN) return null;
  let below = 0;
  for (const v of finite) if (v < current) below++;
  return below / finite.length;
}

/**
 * Maps `current` to [0,1] using its z-score within `series`.
 * z = (current - mean) / std, clipped to [-3,3], then mapped via (z+3)/6.
 * Returns 0.5 (neutral) when std === 0 (all values identical).
 * Returns null if fewer than `minN` finite values.
 */
export function zScoreVsHistory(
  current: number,
  series: number[],
  minN = 60,
): number | null {
  if (!isFinite(current)) return null;
  const finite = series.filter(v => isFinite(v));
  if (finite.length < minN) return null;
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  const variance = finite.reduce((s, v) => s + (v - mean) ** 2, 0) / finite.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0.5;
  const z = Math.max(-3, Math.min(3, (current - mean) / std));
  return (z + 3) / 6;
}

/**
 * Determines if the MACD histogram trend is improving (UP), deteriorating (DOWN),
 * or within noise (FLAT) by comparing the slope of the last `lookback` bars.
 * UP = potential reversal / momentum building.
 * Noise threshold = 5% of the absolute value of the oldest bar in the window.
 * Returns null if series is too short (< lookback + 1).
 */
export function macdTurnDirection(
  histSeries: number[],
  lookback = 3,
): "UP" | "DOWN" | "FLAT" | null {
  if (histSeries.length < lookback) return null;
  const window = histSeries.slice(-lookback);
  const slope = window[window.length - 1] - window[0];
  const noise = Math.max(0.001, Math.abs(window[0]) * 0.05);
  if (slope > noise) return "UP";
  if (slope < -noise) return "DOWN";
  return "FLAT";
}

/**
 * Classifies a stock's price regime from its own MAs and slope.
 * BULLISH  = price > ma50 > ma200 AND ma50Slope10d > 0
 * BEARISH  = price < ma50 < ma200 AND ma50Slope10d < 0
 * NEUTRAL  = everything else (including when ma50 or ma200 are null)
 * Uses ONLY the stock's own price data — no macro view.
 */
export function regimeFromPrice(
  price: number,
  ma50: number | null,
  ma200: number | null,
  ma50Slope10d: number | null,
): "BULLISH" | "NEUTRAL" | "BEARISH" {
  if (ma50 == null || ma200 == null || ma50Slope10d == null) return "NEUTRAL";
  if (price > ma50 && ma50 > ma200 && ma50Slope10d > 0) return "BULLISH";
  if (price < ma50 && ma50 < ma200 && ma50Slope10d < 0) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Detects a confirmed stock-specific breakdown (falling knife).
 * Returns true when ALL of:
 *   priceVsMa50Atr  < -2.0  (price >2 ATR below MA50)
 *   priceVsMa200Atr < -2.0  (price >2 ATR below MA200; null if MA200 unavailable)
 *   macdDirection   = 'DOWN' (momentum still deteriorating)
 * When priceVsMa200Atr is null (MA200 unavailable), uses priceVsMa50Atr alone.
 * NEVER triggered by macro view — stock-specific breakdown only.
 */
export function fallingKnifeDetect(
  priceVsMa50Atr: number | null,
  priceVsMa200Atr: number | null,
  macdDirection: string | null,
): boolean {
  if (priceVsMa50Atr == null || macdDirection !== "DOWN") return false;
  if (priceVsMa50Atr >= -2.0) return false;
  // If MA200 is available, require both conditions; otherwise MA50 alone suffices
  if (priceVsMa200Atr !== null && priceVsMa200Atr >= -2.0) return false;
  return true;
}

/**
 * Annualized realized volatility from `window` daily log returns.
 * Returns percentage (e.g. 35.2 for 35.2% annualized vol).
 * Returns null if fewer than `window` finite close prices provided.
 */
export function realizedVolatility(
  dailyCloses: number[],
  window = 20,
): number | null {
  if (dailyCloses.length < window + 1) return null;
  const slice = dailyCloses.slice(-(window + 1));
  const logReturns = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const finite = logReturns.filter(v => isFinite(v));
  if (finite.length < window) return null;
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  const variance = finite.reduce((s, v) => s + (v - mean) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

/**
 * Finds the highest swing high and lowest swing low within `lookback` closes.
 * Swing high: close[i] > close[i-2] AND close[i] > close[i+2]  (local maximum)
 * Swing low:  close[i] < close[i-2] AND close[i] < close[i+2]  (local minimum)
 * Requires i±2 neighbors, so the last 2 bars can never be swing points.
 * Returns { high: null, low: null } when data is insufficient or no swing found.
 */
export function swingHighLow(
  closes: number[],
  lookback: number,
): { high: number | null; low: number | null } {
  if (closes.length < lookback + 4) return { high: null, low: null };
  const slice = closes.slice(-(lookback + 4));
  let high: number | null = null;
  let low: number | null = null;
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (!isFinite(c)) continue;
    if (c > slice[i - 2] && c > slice[i + 2]) {
      if (high === null || c > high) high = c;
    }
    if (c < slice[i - 2] && c < slice[i + 2]) {
      if (low === null || c < low) low = c;
    }
  }
  return { high, low };
}

/**
 * Volume-weighted average price over the last `window` bars.
 * vwap = sum(close × volume) / sum(volume)
 * Returns null if window not met, volumes are missing, or total volume is 0.
 */
export function vwap(
  closes: number[],
  volumes: number[],
  window = 20,
): number | null {
  if (closes.length < window || volumes.length < window) return null;
  const c = closes.slice(-window);
  const v = volumes.slice(-window);
  const sumCV = c.reduce((s, ci, i) => s + ci * v[i], 0);
  const sumV = v.reduce((s, vi) => s + vi, 0);
  if (sumV === 0 || !isFinite(sumCV) || !isFinite(sumV)) return null;
  return sumCV / sumV;
}
