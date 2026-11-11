/**
 * North-star #5 — forward probability cone + strike odds from ATM IV.
 * Lognormal, zero drift: band_k(d) = S·exp(±k·σ·√(d/365)). Not a forecast — the options-implied range.
 */

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, |err| < 7.5e-8). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

export type ConePoint = { time: number; value: number };
export type Cone = { up1: ConePoint[]; dn1: ConePoint[]; up2: ConePoint[]; dn2: ConePoint[] };

/**
 * Cone from the last bar (unix seconds) out `horizonDays` calendar days, one point per weekday.
 * `iv` = annualised ATM IV as a fraction (0.45 = 45 %).
 */
export function probabilityCone(spot: number, iv: number, startTime: number, horizonDays: number): Cone | null {
  if (!(spot > 0) || !(iv > 0) || !(horizonDays > 0)) return null;
  const cone: Cone = { up1: [], dn1: [], up2: [], dn2: [] };
  const push = (time: number, d: number) => {
    const s = iv * Math.sqrt(d / 365);
    cone.up1.push({ time, value: spot * Math.exp(s) });
    cone.dn1.push({ time, value: spot * Math.exp(-s) });
    cone.up2.push({ time, value: spot * Math.exp(2 * s) });
    cone.dn2.push({ time, value: spot * Math.exp(-2 * s) });
  };
  push(startTime, 0);
  for (let d = 1; d <= horizonDays; d++) {
    const time = startTime + d * 86_400;
    const dow = new Date(time * 1000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    push(time, d);
  }
  return cone;
}

export type StrikeOdds = { sigmas: number; pBelow: number; pTouch: number };

/**
 * Short put at `strike`, `days` calendar days to expiry: distance in σ (positive = OTM),
 * P(close below strike at expiry) and P(touch before expiry) ≈ 2·P(below) (reflection, capped at 1).
 */
export function putStrikeOdds(spot: number, strike: number, iv: number, days: number): StrikeOdds | null {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0)) return null;
  const t = Math.max(days, 0.5) / 365;
  const z = Math.log(strike / spot) / (iv * Math.sqrt(t));
  const pBelow = normCdf(z);
  return { sigmas: -z, pBelow, pTouch: Math.min(1, 2 * pBelow) };
}

/** Calendar days from `fromIso` (YYYY-MM-DD or ISO) to `expiryIso` (YYYY-MM-DD, settles that day). */
export function daysTo(expiryIso: string, from: Date = new Date()): number {
  const exp = Date.parse(`${expiryIso.slice(0, 10)}T21:00:00Z`);
  return Number.isFinite(exp) ? (exp - from.getTime()) / 86_400_000 : NaN;
}
