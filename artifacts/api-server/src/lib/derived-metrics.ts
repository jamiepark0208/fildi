/**
 * Derived fundamentals TradeDash owns (not vendor label copies).
 *
 * Rule: if a field mixes primitives with incompatible vendor definitions,
 * derive gold from gold primitives — never vote across vendor "PEG"/"margin" labels.
 *
 * Coverage > null: we fill PE/PEG whenever math is defined (finite, non-zero
 * denominator). Distorted values (tiny growth → huge PEG, losses → negative PE)
 * stay in gold so FactSet referee / Needs Review can mediate — hiding them as
 * null removes signal from the deterministic pipeline.
 */

/** Growth usable in PEG: any finite non-zero rate (negative = declining EPS). */
export function isUsablePegGrowth(g: number | null | undefined): g is number {
  return g != null && isFinite(g) && g !== 0;
}

/**
 * Prefer trailing YoY EPS growth; if missing/zero, fall back to near-term
 * forward growth (forwardEps − trailingEps) / |trailingEps|.
 */
export function resolvePegGrowth(opts: {
  epsGrowth?: number | null;
  trailingEps?: number | null;
  forwardEps?: number | null;
}): number | null {
  if (isUsablePegGrowth(opts.epsGrowth)) return opts.epsGrowth!;
  const te = opts.trailingEps;
  const fe = opts.forwardEps;
  if (te == null || fe == null || !isFinite(te) || !isFinite(fe) || te === 0) return null;
  const fwdG = (fe - te) / Math.abs(te);
  return isUsablePegGrowth(fwdG) ? fwdG : null;
}

export function computeTrailingPeg(
  pe: number | null | undefined,
  epsGrowth: number | null | undefined,
): number | null {
  if (pe == null || !isFinite(pe)) return null;
  if (!isUsablePegGrowth(epsGrowth)) return null;
  const peg = pe / (epsGrowth * 100);
  return isFinite(peg) ? peg : null;
}

export function computeForwardPeg(
  forwardPe: number | null | undefined,
  epsGrowth: number | null | undefined,
): number | null {
  if (forwardPe == null || !isFinite(forwardPe)) return null;
  if (!isUsablePegGrowth(epsGrowth)) return null;
  const peg = forwardPe / (epsGrowth * 100);
  return isFinite(peg) ? peg : null;
}

export const computeCanonicalPeg = computeTrailingPeg;

export function computeForwardPeFromPriceEps(
  price: number | null | undefined,
  forwardEps: number | null | undefined,
): number | null {
  if (price == null || forwardEps == null || !isFinite(price) || !isFinite(forwardEps)) return null;
  if (price <= 0 || forwardEps === 0) return null;
  const pe = price / forwardEps;
  return isFinite(pe) ? pe : null;
}

export function computePeFromPriceEps(
  price: number | null | undefined,
  eps: number | null | undefined,
): number | null {
  if (price == null || eps == null || !isFinite(price) || !isFinite(eps)) return null;
  if (price <= 0 || eps === 0) return null;
  const pe = price / eps;
  return isFinite(pe) ? pe : null;
}

export function computeNetMargin(
  netIncome: number | null | undefined,
  totalRevenue: number | null | undefined,
): number | null {
  if (netIncome == null || totalRevenue == null || !isFinite(netIncome) || !isFinite(totalRevenue)) return null;
  if (totalRevenue === 0) return null;
  const m = netIncome / totalRevenue;
  return isFinite(m) && Math.abs(m) <= 5 ? m : null;
}

export function computeDebtToEquity(
  totalDebt: number | null | undefined,
  equity: number | null | undefined,
): number | null {
  if (totalDebt == null || equity == null || !isFinite(totalDebt) || !isFinite(equity)) return null;
  if (equity === 0 || equity < 0) return null;
  const r = totalDebt / equity;
  return isFinite(r) && r >= 0 && r < 1000 ? r : null;
}

/** Market cap / revenue. Revenue must be positive. */
export function computePriceToSales(
  price: number | null | undefined,
  revenue: number | null | undefined,
  shares: number | null | undefined,
): number | null {
  if (price == null || revenue == null || shares == null) return null;
  if (!isFinite(price) || !isFinite(revenue) || !isFinite(shares)) return null;
  if (price <= 0 || shares <= 0 || revenue <= 0) return null;
  const ps = (price * shares) / revenue;
  return isFinite(ps) ? ps : null;
}

/** (price × shares + debt − cash) / denominator. Debt and cash are required so a missing leg cannot invent an EV. */
export function computeEvRatio(
  price: number | null | undefined,
  shares: number | null | undefined,
  debt: number | null | undefined,
  cash: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  if (price == null || shares == null || debt == null || cash == null || denominator == null) return null;
  if (![price, shares, debt, cash, denominator].every((n) => n != null && isFinite(n))) return null;
  if (price <= 0 || shares <= 0 || denominator === 0) return null;
  const ev = price * shares + debt - cash;
  const ratio = ev / denominator;
  return isFinite(ratio) ? ratio : null;
}

/** Same tolerance used for P/S currency-mix gate and per-ratio vendor agreement. */
export function priceRatiosAgree(derived: number, vendor: number): boolean {
  const absA = Math.abs(derived);
  const absB = Math.abs(vendor);
  const maxAbs = Math.max(absA, absB);
  const minAbs = Math.min(absA, absB);
  if (maxAbs < 0.02) return true;
  if ((derived > 0) !== (vendor > 0)) return false;
  if (minAbs > 0 && maxAbs / minAbs >= 3) return false;
  const absDiff = Math.abs(derived - vendor);
  if (absDiff / maxAbs > 0.25) return false;
  return true;
}

/** EV/EBITDA outside this band is not gold (vendor garbage or unit mix). */
export function isEvEbitdaGoldCandidate(val: number): boolean {
  return isFinite(val) && val > 0 && val <= 200;
}

/** GICS Financials — EV ratios are not meaningful on banks/brokers. */
export function isGicsFinancialsSector(sector: string | null | undefined): boolean {
  if (!sector?.trim()) return false;
  return /financial/i.test(sector.trim());
}

/**
 * Force-derived price ratio from USD close + gold levels.
 * USD filers: always when math is defined.
 * Unknown currency: only when derived agrees with that field's current vendor gold.
 */
export function shouldForceDerivedPriceRatio(opts: {
  financialCurrency: string | null | undefined;
  derived: number | null;
  vendorGold: number | null | undefined;
  /** Other vendor ratios for the same field (priority order) when currency is unknown. */
  vendorAlternates?: Array<number | null | undefined>;
}): boolean {
  const fc = opts.financialCurrency?.trim().toUpperCase();
  if (fc && fc !== "USD") return false;
  if (opts.derived == null || !isFinite(opts.derived)) return false;
  if (fc === "USD") return true;
  const vendors = [opts.vendorGold, ...(opts.vendorAlternates ?? [])].filter(
    (v): v is number => v != null && isFinite(v),
  );
  if (vendors.length === 0) return false;
  return vendors.some((v) => priceRatiosAgree(opts.derived!, v));
}

/** GICS Financials and financial peer groups — EV ratios are not meaningful. */
export function skipDerivedEvRatios(opts: {
  sector: string | null | undefined;
  peerGroupId: string | null | undefined;
}): boolean {
  if (isGicsFinancialsSector(opts.sector)) return true;
  const pg = opts.peerGroupId?.trim() ?? "";
  if (/^financials\./i.test(pg)) return true;
  if (/(broker|capital_markets|asset_management|investment_bank)/i.test(pg)) return true;
  return false;
}

/** True when gold levels are in USD (or agree with vendor P/S); else keep vendor ratios. */
export function canDerivePriceRatiosFromUsdClose(opts: {
  financialCurrency: string | null | undefined;
  price: number | null | undefined;
  revenue: number | null | undefined;
  shares: number | null | undefined;
  vendorPriceToSales: number | null | undefined;
}): boolean {
  const fc = opts.financialCurrency?.trim().toUpperCase();
  if (fc && fc !== "USD") return false;
  if (fc === "USD") return true;
  const derivedPs = computePriceToSales(opts.price, opts.revenue, opts.shares);
  const vendorPs = opts.vendorPriceToSales;
  if (derivedPs == null || vendorPs == null) return false;
  return priceRatiosAgree(derivedPs, vendorPs);
}

export function computePriceToBook(
  price: number | null | undefined,
  equity: number | null | undefined,
  shares: number | null | undefined,
): number | null {
  if (price == null || equity == null || shares == null) return null;
  if (!isFinite(price) || !isFinite(equity) || !isFinite(shares) || shares <= 0 || equity <= 0 || price <= 0) {
    return null;
  }
  const bvps = equity / shares;
  if (bvps <= 0) return null;
  const pb = price / bvps;
  return isFinite(pb) && pb < 5000 ? pb : null;
}

/** Approx ROIC = NOPAT / (debt + equity - cash); rough but fills nulls when vendors omit ROIC. */
export function computeApproxRoic(input: {
  ebit?: number | null;
  taxRate?: number | null;
  totalDebt?: number | null;
  equity?: number | null;
  cash?: number | null;
}): number | null {
  const { ebit, taxRate, totalDebt, equity, cash } = input;
  if (ebit == null || !isFinite(ebit)) return null;
  const t = taxRate != null && isFinite(taxRate) && taxRate >= 0 && taxRate < 1 ? taxRate : 0.21;
  const nopat = ebit * (1 - t);
  const d = totalDebt ?? 0;
  const e = equity ?? 0;
  const c = cash ?? 0;
  const invested = d + e - c;
  if (!isFinite(invested) || invested <= 0) return null;
  const roic = nopat / invested;
  return isFinite(roic) && Math.abs(roic) < 5 ? roic : null;
}

/** Operating margin from EBIT / revenue — fills when vendors omit margin but report both legs. */
export function computeOperatingMargin(
  ebit: number | null | undefined,
  totalRevenue: number | null | undefined,
): number | null {
  if (ebit == null || totalRevenue == null || !isFinite(ebit) || !isFinite(totalRevenue)) return null;
  if (totalRevenue === 0) return null;
  const m = ebit / totalRevenue;
  return isFinite(m) && Math.abs(m) <= 5 ? m : null;
}

/** ROE = NI / equity — fills when vendors omit ROE but report both legs. */
export function computeReturnOnEquity(
  netIncome: number | null | undefined,
  equity: number | null | undefined,
): number | null {
  if (netIncome == null || equity == null || !isFinite(netIncome) || !isFinite(equity)) return null;
  if (equity === 0 || equity < 0) return null;
  const r = netIncome / equity;
  return isFinite(r) && Math.abs(r) <= 5 ? r : null;
}

/** GAAP EBITDA TTM = operating income + D&A (SEC audit truth + EV/EBITDA numerator). */
export function computeGaapEbitdaTtm(
  ebit: number | null | undefined,
  depreciationAmortization: number | null | undefined,
): number | null {
  if (ebit == null || depreciationAmortization == null) return null;
  if (!isFinite(ebit) || !isFinite(depreciationAmortization)) return null;
  const v = ebit + depreciationAmortization;
  return isFinite(v) ? v : null;
}

/** Vendor "EBITDA" often includes adjustments; >25% above GAAP OI+DA is not gold. */
export function vendorEbitdaIsAdjustedOutlier(vendorEbitda: number, gaapEbitda: number): boolean {
  if (!isFinite(vendorEbitda) || !isFinite(gaapEbitda)) return false;
  const base = Math.max(Math.abs(gaapEbitda), 1);
  return Math.abs(vendorEbitda - gaapEbitda) / base > 0.25;
}
