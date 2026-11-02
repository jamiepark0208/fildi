/**
 * Disputed-gold pick for merge-trusted.
 * FactSet is the ruler only on fields where it matched an agreeing free cluster
 * at least 80% of the time (measured 2026-10-30, n≥15). Everywhere else an
 * agreeing free cluster wins, and FactSet is not written as gold.
 * Signed values stay, including large and small negative price/earnings.
 */

import { COHORT_MODULUS } from "./data-ops-config.js";
import { factsetRulerFields, isFactsetRulerField } from "./factset-ruler-table.js";

/** @deprecated use isFactsetRulerField / loadRulerTable */
export function getFactsetRulerFields(): Set<string> {
  try {
    return factsetRulerFields();
  } catch {
    return new Set(["forwardPe"]);
  }
}

/**
 * Scarce sources refresh on a 14-day cohort, not every night.
 * A row younger than that, versus the newest pull on the cell, still votes.
 * STALE_DAYS (7) is the dashboard freshness bar. Using it here dropped NVDA's
 * June filing because Yahoo's pull was nine days later.
 */
const STALE_MS = COHORT_MODULUS * 86_400_000;

/**
 * Polygon the vendor is live (prices, grouped daily, short interest: thousands of
 * calls a week on the API tab). The fundamentals endpoint is not: /vX/reference/financials
 * returns GONE, so those rows are a frozen snapshot (polygon-client.ts).
 * A snapshot may confirm a fresh Yahoo, Finnhub, FMP, or Alpha Vantage value.
 * It may not pair with EDGAR to outvote that fresher number. A snapshot pulled
 * inside the 14-day window votes on its own.
 * FMP and Alpha Vantage rotate on the same 14-day cohort. An older pull can
 * confirm any fresh quote with the same value, including EDGAR.
 * No currency column is stored. US names stay in reported dollars. Margins are decimals.
 */
const POLYGON_CONFIRM_HOSTS = new Set(["yahoo", "finnhub", "fmp", "alpha_vantage"]);

export type GoldQuote = { src: string; val: number; pulledAt?: number | null };

export type DisputedPick = {
  source: string;
  value: number;
  divergent: boolean;
  /** Keep the number already in gold. Flag Needs Review. Do not author FactSet. */
  hold: boolean;
};

function within(a: number, b: number, relTol: number, absTol: number): boolean {
  const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return rel <= relTol || Math.abs(a - b) <= absTol;
}

function eligibleVotes(free: GoldQuote[]): GoldQuote[] {
  const times = free.map((q) => q.pulledAt).filter((t): t is number => t != null && Number.isFinite(t));
  const newest = times.length > 0 ? Math.max(...times) : null;
  const fresh = (q: GoldQuote) =>
    newest == null || q.pulledAt == null || !Number.isFinite(q.pulledAt) || newest - q.pulledAt <= STALE_MS;
  const freshOnes = free.filter(fresh);
  const confirms = (q: GoldQuote, hosts: GoldQuote[]) =>
    hosts.some((f) => within(q.val, f.val, 0.15, 0.03));
  return free.filter((q) => {
    if (fresh(q) && q.src !== "polygon") return true;
    if (q.src === "polygon") {
      if (fresh(q)) return true;
      const hosts = freshOnes.filter((f) => POLYGON_CONFIRM_HOSTS.has(f.src));
      return confirms(q, hosts);
    }
    return confirms(q, freshOnes);
  });
}

/** Sign flip or a 3× scale gap. Ordinary vendor gaps are not a review. */
function hardFight(a: number, b: number): boolean {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA < 0.02 && absB < 0.02) return false;
  if ((a > 0) !== (b > 0) && absA >= 0.02 && absB >= 0.02) return true;
  const lo = Math.min(absA, absB);
  const hi = Math.max(absA, absB);
  return lo > 0 && hi / lo >= 3;
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** Largest subset that pairwise agrees (15% or 3 percentage points). Priority order kept. */
function numericCluster(free: GoldQuote[]): GoldQuote[] {
  let best: GoldQuote[] = [];
  const n = free.length;
  const agree = (a: number, b: number) => within(a, b, 0.15, 0.03);
  for (let mask = 1; mask < (1 << n); mask++) {
    const group: GoldQuote[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) group.push(free[i]!);
    if (group.length < 2 || group.length < best.length) continue;
    let ok = true;
    for (let i = 0; i < group.length && ok; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!agree(group[i]!.val, group[j]!.val)) { ok = false; break; }
      }
    }
    if (ok) best = group;
  }
  return best;
}

/**
 * Free sources that share a sign opposite FactSet. That is a basis mismatch
 * (GAAP loss vs adjusted profit), not a reason to store FactSet.
 */
function basisCluster(free: GoldQuote[], factset: number | undefined): GoldQuote[] {
  if (factset == null || !Number.isFinite(factset)) return [];
  const fs = sign(factset);
  if (fs === 0) return [];
  const same = free.filter((q) => sign(q.val) !== 0 && sign(q.val) !== fs);
  const signs = new Set(same.map((q) => sign(q.val)));
  if (same.length >= 2 && signs.size === 1) return same;
  return [];
}

/**
 * No agreeing cluster. Store the priority source.
 * Needs Review only when another same-concept quote flips the sign or is 3× away.
 * A plain gap is vendor noise; the field definition already names the source.
 */
function settlePriority(fallback: GoldQuote, rest: GoldQuote[], forceReview: boolean): DisputedPick {
  const review = forceReview || rest.some((q) => q.src !== fallback.src && hardFight(fallback.val, q.val));
  return { source: fallback.src, value: fallback.val, divergent: review, hold: false };
}

export function pickDisputedGold(args: {
  field: string;
  /** Priority order. First is cheapest (Yahoo before Finnhub before FMP). */
  free: GoldQuote[];
  factset?: number;
  existing?: number | null;
}): DisputedPick {
  const free = eligibleVotes(args.free.filter((q) => Number.isFinite(q.val)));
  const existing = args.existing ?? null;
  const factset = args.factset != null && Number.isFinite(args.factset) ? args.factset : undefined;

  if (free.length === 0) {
    if (factset != null && isFactsetRulerField(args.field)) {
      return { source: "factset", value: factset, divergent: false, hold: false };
    }
    return { source: "none", value: existing ?? NaN, divergent: true, hold: existing != null };
  }

  if (isFactsetRulerField(args.field) && factset != null) {
    const inBand = free.filter((q) => within(q.val, factset, 0.20, 0.02));
    if (inBand.length > 0) {
      return { source: inBand[0]!.src, value: inBand[0]!.val, divergent: false, hold: false };
    }
    const rulerCluster = numericCluster(free);
    if (rulerCluster.length >= 2) {
      return { source: rulerCluster[0]!.src, value: rulerCluster[0]!.val, divergent: false, hold: false };
    }
    return settlePriority(free[0]!, free, true);
  }

  const numeric = numericCluster(free);
  const basis = basisCluster(free, factset);
  const basisTight = numericCluster(basis);
  const cluster = numeric.length >= 2 ? numeric : basisTight;
  if (cluster.length >= 2) {
    return { source: cluster[0]!.src, value: cluster[0]!.val, divergent: false, hold: false };
  }
  return settlePriority(free[0]!, free, false);
}
