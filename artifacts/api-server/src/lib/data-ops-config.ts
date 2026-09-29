/**
 * Single source of truth for fundamentals data-ops constants.
 * Import from here — do not redefine STALE_DAYS / CALLS_PER_TICKER / FMP caps elsewhere.
 */

/** Gold + bronze staging considered fresh for this many days. */
export const STALE_DAYS = 7;

/** Same as STALE_DAYS — data-health dashboard must not drift. */
export const DATA_HEALTH_STALE_DAYS = STALE_DAYS;

/**
 * API calls consumed per full ticker fetch (budget math).
 * FMP fires 9 stable endpoints in fetchFMPFundamentals.
 */
export const CALLS_PER_TICKER: Record<string, number> = {
  yahoo: 1,
  edgar: 1,
  finnhub: 1,
  polygon: 1,
  alpha_vantage: 1,
  fmp: 9,
};

/** Free-plan headroom under typical ~250/day FMP limit. */
export const FMP_MAX_DAILY_CALLS = 220;

export const AV_MAX_DAILY_CALLS = 25;

/** Nightly peer-expansion cap (bug/9 — avoid unbounded fan-out). */
export const PEER_EXPANSION_CAP = 25;

/**
 * Scarce free sources (FMP, AV): prefer tickers whose cohort matches today
 * so the full universe rotates every COHORT_MODULUS days instead of the same
 * alphabetical/random subset burning budget every run.
 */
export const COHORT_MODULUS = 14;

export const SCARCE_SOURCES = new Set(["fmp", "alpha_vantage"]);

/** Cheap → scarce. Matches nightly SOURCE_ORDER. */
export const SOURCE_ORDER = [
  "yahoo",
  "edgar",
  "finnhub",
  "polygon",
  "alpha_vantage",
  "fmp",
] as const;

export type EnrichSource = (typeof SOURCE_ORDER)[number];

/** Stable hash → cohort bucket 0..COHORT_MODULUS-1. */
export function tickerCohort(ticker: string): number {
  const s = ticker.toUpperCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % COHORT_MODULUS;
}

/** Day-of-year bucket (UTC) mod COHORT_MODULUS. */
export function todayCohort(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const day = Math.floor((now.getTime() - start) / 86_400_000);
  return day % COHORT_MODULUS;
}

export function isCohortDueToday(ticker: string, now = new Date()): boolean {
  return tickerCohort(ticker) === todayCohort(now);
}
