/**
 * Premium-rich universe selection + simple income/OTM viability for Overall options.
 * Cheap DB-only prefilter — no chain fetch. Prefer elevated ATM IV / IV>RV.
 *
 * Viability (strike-level): enough weekly income AND enough distance to strike.
 * Fixed floors — NOT a sliding "higher income ⇒ more OTM" curve (that was wrong).
 * Bad Yahoo quotes are handled separately by isPlausibleOptionQuote.
 */
export interface PremiumCandidateInput {
  ticker: string;
  atmPutIv: number | string | null | undefined;
  ivVsRealizedVol?: number | string | null | undefined;
  technicalsCoverage?: number | string | null | undefined;
  putCallVolumeRatio?: number | string | null | undefined;
}

/** Fixed min OTM for a short-premium strike to count as having distance (matches chain band). */
export const MIN_OTM_FOR_PREMIUM = 0.03; // 3%

function pf(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Soft richness score [0,∞) — higher = more likely a sell-premium name. */
export function premiumRichnessScore(row: PremiumCandidateInput): number {
  const iv = pf(row.atmPutIv);
  if (iv == null || iv <= 0) return 0;
  const vr = pf(row.ivVsRealizedVol);
  const abs = Math.min(1.4, Math.max(0, (iv - 10) / 40));
  const prem = vr != null && vr > 0 ? Math.min(0.5, Math.max(0, (vr - 0.85) / 0.9) * 0.5) : 0;
  return abs + prem;
}

/**
 * Select top-N premium-rich tickers from technicals rows.
 * Wide by design — GO/WATCH is NOT used. Chain scoring + quote gates do the rest.
 */
export function selectPremiumCandidates(
  rows: PremiumCandidateInput[],
  limit = 200,
  opts?: { minAtmIv?: number; minCoverage?: number },
): string[] {
  const minIv = opts?.minAtmIv ?? 12;
  const minCov = opts?.minCoverage ?? 0.15;

  const scored = rows
    .map((r) => {
      const cov = pf(r.technicalsCoverage);
      const iv = pf(r.atmPutIv);
      if (cov != null && cov < minCov) return null;
      if (iv == null || iv < minIv) return null;
      return { ticker: r.ticker.toUpperCase(), score: premiumRichnessScore(r) };
    })
    .filter((x): x is { ticker: string; score: number } => x != null && x.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.ticker)) continue;
    seen.add(s.ticker);
    out.push(s.ticker);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Enough income AND enough distance — fixed floors.
 * Example: 0.5%/wk at ≥3% OTM passes; 0.9%/wk at 2% OTM fails on distance (not on income).
 */
export function isViablePremiumIncome(
  weeklyIncome: number,
  otmPct: number,
  opts?: { incomeFloor?: number; minOtm?: number },
): boolean {
  const floor = opts?.incomeFloor ?? 0.45;
  const minOtm = opts?.minOtm ?? MIN_OTM_FOR_PREMIUM;
  if (!Number.isFinite(weeklyIncome) || weeklyIncome < floor) return false;
  if (!Number.isFinite(otmPct) || otmPct < minOtm) return false;
  return true;
}

/**
 * Reject Yahoo garbage before ranking (e.g. inverted OTM last trades). Live bids only.
 * This is quote sanity — not an income-cap filter.
 */
export function isPlausibleOptionQuote(
  premium: number,
  strike: number,
  spot: number,
  otmPct: number,
): boolean {
  if (!(premium > 0 && strike > 0 && spot > 0)) return false;
  if (!(otmPct >= 0)) return false;
  // Premium as share of strike: >35% for an OTM short is almost never a real weekly bid
  if (premium / strike > 0.35) return false;
  // Penny/micro strikes amplify Yahoo lastPrice nonsense
  if (strike < 1.0 && premium / strike > 0.15) return false;
  return true;
}
