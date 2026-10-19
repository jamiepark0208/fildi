/**
 * Pure Black–Scholes Greeks (A83 god-file split from options.ts).
 * No IO — unit-testable without Yahoo/Schwab.
 */

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz–Stegun). */
export function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p =
    d *
    t *
    (0.3193815310 +
      t * (-0.3565638140 + t * (1.7814779370 + t * (-1.8212559780 + t * 1.3302744290))));
  return x > 0 ? 1 - p : p;
}

/** Black–Scholes delta/gamma/theta (theta per calendar day). */
export function bsGreeks(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  isCall: boolean,
): { delta: number; gamma: number; theta: number } {
  if (T <= 0 || sigma <= 0 || S <= 0) {
    return { delta: 0, gamma: 0, theta: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = normPDF(d1);

  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = nd1 / (S * sigma * sqrtT);
  const thetaAnnual = isCall
    ? -S * nd1 * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)
    : -S * nd1 * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2);

  return { delta, gamma, theta: thetaAnnual / 365 };
}
