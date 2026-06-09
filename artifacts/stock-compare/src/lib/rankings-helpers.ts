export const MIN_Z_N = 8;
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
    // Winsorized z-score path
    const winsorized = winsorize(values);
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
