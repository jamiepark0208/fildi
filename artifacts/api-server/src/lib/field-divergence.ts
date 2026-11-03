/**
 * Shared materiality band for Needs Review + A329 audit (merge-trusted + stock-db-audit).
 */

export const DIVERGENCE_TOL: Record<string, number> = {
  epsGrowth: 0.50,
  revenueGrowthYoY: 0.50,
  revenueGrowthYoyPrior: 0.50,
  pegRatio: 0.40,
  peRatio: 0.25,
  forwardPe: 0.25,
  priceToBook: 0.25,
  priceToSales: 0.25,
  evEbitda: 0.25,
  evRevenue: 0.25,
  currentRatio: 0.25,
  beta: 0.35,
  dividendYield: 0.25,
  totalDebt: 0.35,
};

export const DEFAULT_DIVERGENCE_TOL = 0.20;
export const DIVERGENCE_ABS_FLOOR = 0.03;

export function isMaterialDivergence(tf: string, a: number, b: number): boolean {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  const maxAbs = Math.max(absA, absB);
  const minAbs = Math.min(absA, absB);
  if (maxAbs < 0.02) return false;
  if ((a > 0) !== (b > 0)) return true;
  if (minAbs > 0 && maxAbs / minAbs >= 3) return true;
  const absDiff = Math.abs(a - b);
  if (absDiff <= DIVERGENCE_ABS_FLOOR) return false;
  const tol = DIVERGENCE_TOL[tf] ?? DEFAULT_DIVERGENCE_TOL;
  return absDiff / maxAbs > tol;
}
