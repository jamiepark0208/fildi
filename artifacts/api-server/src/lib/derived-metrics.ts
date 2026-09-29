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
  if (equity === 0) return null;
  const r = totalDebt / Math.abs(equity);
  return isFinite(r) && r >= 0 && r < 1000 ? r : null;
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
  if (equity === 0) return null;
  const r = netIncome / Math.abs(equity);
  return isFinite(r) && Math.abs(r) <= 5 ? r : null;
}
