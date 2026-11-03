/**
 * A318 segments 1+2 — one pick function for disputed gold.
 * Timeliness first, then cheapest free source inside the ruler band (FIELD_DEFS order).
 * FactSet is ruler only on measured ruler fields; never gold elsewhere.
 */

import { COHORT_MODULUS } from "./data-ops-config.js";
import { isFactsetRulerField } from "./factset-ruler-table.js";

export type GoldQuote = { src: string; val: number; pulledAt?: number | null };

export type DisputedPick = {
  source: string;
  value: number;
  divergent: boolean;
  /** Keep the number already in gold. Flag Needs Review. Do not author FactSet. */
  hold: boolean;
};

export type PickFieldGoldResult = DisputedPick & {
  /** Ruler field: FactSet present but free cluster won in band. */
  factsetDisagrees?: boolean;
  ruler?: number;
  bandRel?: number;
  bandAbs?: number;
};

/** Flow / TTM fields — EDGAR annual never wins the cheap pick. */
export const FLOW_FIELDS = new Set([
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "revenueGrowthYoyPrior", "epsGrowth",
  "totalRevenue", "netIncome", "ebitda", "ebit", "interestExpense", "effectiveTaxRate", "earningsPerShare",
  "freeCashFlow", "quarterlyOperatingCashFlow",
]);

/** Band uses 3 pp absolute floor on these (20% relative OR 3 pp, whichever is wider). */
export const FRACTION_FIELDS = new Set([
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "revenueGrowthYoyPrior", "epsGrowth", "dividendYield", "effectiveTaxRate",
]);

const REL_BAND = 0.2;
const PP_BAND = 0.03;
const EDGAR_BALANCE_MAX_LAG_MS = 120 * 86_400_000;
const STALE_MS = COHORT_MODULUS * 86_400_000;

const SOURCE_FRESH_MS: Record<string, number> = {
  yahoo: 7 * 86_400_000,
  finnhub: 14 * 86_400_000,
  fmp: 1 * 86_400_000,
  alpha_vantage: 30 * 86_400_000,
  factset: 1 * 86_400_000,
  polygon: STALE_MS,
  edgar: EDGAR_BALANCE_MAX_LAG_MS,
  /** Filed date stored in fetched_at — allow up to ~15mo stale vs newest pull in band. */
  sec: 450 * 86_400_000,
};

const POLYGON_CONFIRM_HOSTS = new Set(["yahoo", "finnhub", "fmp", "alpha_vantage"]);

export function bandTolerances(field: string): { rel: number; abs: number } {
  const abs = FRACTION_FIELDS.has(field) ? PP_BAND : 0;
  return { rel: REL_BAND, abs };
}

/** Value b within band of ruler a (relative 20% or fraction pp, whichever is wider). */
export function inBand(field: string, ruler: number, candidate: number): boolean {
  const { rel, abs } = bandTolerances(field);
  const denom = Math.max(Math.abs(ruler), Math.abs(candidate), 1e-9);
  if (Math.abs(candidate - ruler) / denom <= rel) return true;
  if (abs > 0 && Math.abs(candidate - ruler) <= abs) return true;
  return false;
}

function within(a: number, b: number, relTol: number, absTol: number): boolean {
  const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return rel <= relTol || (absTol > 0 && Math.abs(a - b) <= absTol);
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function hardFight(a: number, b: number): boolean {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA < 0.02 && absB < 0.02) return false;
  if ((a > 0) !== (b > 0) && absA >= 0.02 && absB >= 0.02) return true;
  const lo = Math.min(absA, absB);
  const hi = Math.max(absA, absB);
  return lo > 0 && hi / lo >= 3;
}

/** Polygon snapshot may confirm fresher hosts; stale alone does not vote with EDGAR. */
function eligibleVotes(free: GoldQuote[]): GoldQuote[] {
  const times = free.map((q) => q.pulledAt).filter((t): t is number => t != null && Number.isFinite(t));
  const newest = times.length > 0 ? Math.max(...times) : null;
  const fresh = (q: GoldQuote) =>
    newest == null || q.pulledAt == null || !Number.isFinite(q.pulledAt) || newest - q.pulledAt <= STALE_MS;
  const freshOnes = free.filter(fresh);
  const confirms = (q: GoldQuote, hosts: GoldQuote[]) =>
    hosts.some((f) => within(q.val, f.val, 0.15, PP_BAND));
  return free.filter((q) => {
    // SEC rows use filing date in pulledAt — not subject to the 14d bronze staleness gate.
    if (q.src === "sec") return true;
    if (fresh(q) && q.src !== "polygon") return true;
    if (q.src === "polygon") {
      if (fresh(q)) return true;
      const hosts = freshOnes.filter((f) => POLYGON_CONFIRM_HOSTS.has(f.src));
      return confirms(q, hosts);
    }
    return confirms(q, freshOnes);
  });
}

/** Drop EDGAR on flow fields; drop stale EDGAR on balance sheet vs newest pull. */
export function filterTimely(field: string, free: GoldQuote[]): GoldQuote[] {
  const eligible = eligibleVotes(free);
  if (FLOW_FIELDS.has(field)) {
    return eligible.filter((q) => q.src !== "edgar");
  }
  const times = eligible
    .map((q) => q.pulledAt)
    .filter((t): t is number => t != null && Number.isFinite(t));
  const newest = times.length > 0 ? Math.max(...times) : null;
  return eligible.filter((q) => {
    if (q.src !== "edgar" || newest == null || q.pulledAt == null) return true;
    return newest - q.pulledAt <= EDGAR_BALANCE_MAX_LAG_MS;
  });
}

/** SEC companyfacts TTM — prefer filing when still inside the ruler band (pull-time vendors lie). */
const SEC_TTM_FIELDS = new Set([
  "freeCashFlow", "totalRevenue", "netIncome", "grossMargin", "operatingMargin", "netMargin",
  "returnOnAssets", "currentRatio", "priceToBook",
]);

/** Among in-band candidates, drop stale vs newest pull, then FIELD_DEFS order (array order). */
function pickCheapestTimely(field: string, ordered: GoldQuote[], ruler: number): GoldQuote | null {
  const inBandQ = ordered.filter((q) => inBand(field, ruler, q.val));
  if (inBandQ.length === 0) return null;
  if (SEC_TTM_FIELDS.has(field)) {
    const sec = inBandQ.find((q) => q.src === "sec");
    if (sec) return sec;
  }
  const times = inBandQ
    .map((q) => q.pulledAt)
    .filter((t): t is number => t != null && Number.isFinite(t));
  const newest = times.length > 0 ? Math.max(...times) : null;
  const freshEnough = inBandQ.filter((q) => {
    if (newest == null || q.pulledAt == null || !Number.isFinite(q.pulledAt)) return true;
    const window = SOURCE_FRESH_MS[q.src] ?? STALE_MS;
    return newest - q.pulledAt <= window;
  });
  const hasStaleConfirm = inBandQ.some(
    (stale) =>
      stale.pulledAt != null &&
      newest != null &&
      newest - stale.pulledAt > STALE_MS &&
      inBandQ.some(
        (fresh) =>
          fresh !== stale &&
          fresh.val === stale.val &&
          fresh.pulledAt != null &&
          newest - fresh.pulledAt <= STALE_MS,
      ),
  );
  const pool = hasStaleConfirm ? inBandQ : freshEnough.length > 0 ? freshEnough : inBandQ;
  const sameVal = pool.length >= 2 && pool.every((q) => q.val === pool[0]!.val);
  if (sameVal) {
    for (const q of ordered) {
      if (pool.some((p) => p.src === q.src && p.val === q.val)) return q;
    }
  }
  if (newest != null && pool.some((q) => q.pulledAt != null)) {
    const maxT = Math.max(...pool.map((q) => q.pulledAt ?? newest));
    const freshest = pool.filter((q) => (q.pulledAt ?? newest) >= maxT);
    for (const q of ordered) {
      if (freshest.some((f) => f.src === q.src && f.val === q.val)) return q;
    }
    return freshest[0] ?? pool[0]!;
  }
  return pool[0]!;
}

/** Largest subset pairwise agreeing at cluster band (20% / 3 pp). Preserves priority order. */
function numericCluster(field: string, free: GoldQuote[]): GoldQuote[] {
  const { rel, abs } = bandTolerances(field);
  let best: GoldQuote[] = [];
  const n = free.length;
  const agree = (a: number, b: number) => within(a, b, rel, abs);
  for (let mask = 1; mask < (1 << n); mask++) {
    const group: GoldQuote[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) group.push(free[i]!);
    if (group.length < 2 || group.length < best.length) continue;
    let ok = true;
    for (let i = 0; i < group.length && ok; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!agree(group[i]!.val, group[j]!.val)) {
          ok = false;
          break;
        }
      }
    }
    if (ok) best = group;
  }
  return best;
}

function basisCluster(free: GoldQuote[], factset: number | undefined): GoldQuote[] {
  if (factset == null || !Number.isFinite(factset)) return [];
  const fs = sign(factset);
  if (fs === 0) return [];
  const same = free.filter((q) => sign(q.val) !== 0 && sign(q.val) !== fs);
  const signs = new Set(same.map((q) => sign(q.val)));
  if (same.length >= 2 && signs.size === 1) return same;
  return [];
}

function settlePriority(fallback: GoldQuote, rest: GoldQuote[], forceReview: boolean): DisputedPick {
  const review = forceReview || rest.some((q) => q.src !== fallback.src && hardFight(fallback.val, q.val));
  return { source: fallback.src, value: fallback.val, divergent: review, hold: false };
}

/**
 * Single pick for merge-trusted disputed branch and database-agent NR.
 * `free` must be in FIELD_DEFS priority order (cheapest first).
 */
export function pickFieldGold(args: {
  field: string;
  free: GoldQuote[];
  factset?: number;
  existing?: number | null;
}): PickFieldGoldResult {
  const timely = filterTimely(args.field, args.free.filter((q) => Number.isFinite(q.val)));
  const existing = args.existing ?? null;
  const factset = args.factset != null && Number.isFinite(args.factset) ? args.factset : undefined;
  const { rel, abs } = bandTolerances(args.field);

  if (timely.length === 0) {
    if (factset != null && isFactsetRulerField(args.field)) {
      return {
        source: "factset",
        value: factset,
        divergent: false,
        hold: false,
        ruler: factset,
        bandRel: rel,
        bandAbs: abs,
      };
    }
    return {
      source: "none",
      value: existing ?? NaN,
      divergent: true,
      hold: existing != null,
      ruler: factset,
      bandRel: rel,
      bandAbs: abs,
    };
  }

  if (isFactsetRulerField(args.field) && factset != null) {
    const inBandPick = pickCheapestTimely(args.field, timely, factset);
    if (inBandPick) {
      return {
        source: inBandPick.src,
        value: inBandPick.val,
        divergent: false,
        hold: false,
        ruler: factset,
        bandRel: rel,
        bandAbs: abs,
      };
    }
    const rulerCluster = numericCluster(args.field, timely);
    if (rulerCluster.length >= 2) {
      return {
        source: rulerCluster[0]!.src,
        value: rulerCluster[0]!.val,
        divergent: false,
        hold: false,
        factsetDisagrees: true,
        ruler: factset,
        bandRel: rel,
        bandAbs: abs,
      };
    }
    return {
      ...settlePriority(timely[0]!, timely, true),
      factsetDisagrees: true,
      ruler: factset,
      bandRel: rel,
      bandAbs: abs,
    };
  }

  const numeric = numericCluster(args.field, timely);
  const basis = basisCluster(timely, factset);
  const basisTight = numericCluster(args.field, basis);
  const cluster = numeric.length >= 2 ? numeric : basisTight;
  if (cluster.length >= 2) {
    const ruler = cluster[0]!.val;
    const picked = pickCheapestTimely(args.field, cluster, ruler) ?? cluster[0]!;
    return {
      source: picked.src,
      value: picked.val,
      divergent: false,
      hold: false,
      ruler,
      bandRel: rel,
      bandAbs: abs,
    };
  }

  const fallback = timely[0]!;
  return {
    ...settlePriority(fallback, timely, false),
    ruler: factset ?? fallback.val,
    bandRel: rel,
    bandAbs: abs,
  };
}

/** @deprecated alias */
export function pickDisputedGold(args: Parameters<typeof pickFieldGold>[0]): DisputedPick {
  const { factsetDisagrees: _f, ruler: _r, bandRel: _br, bandAbs: _ba, ...pick } = pickFieldGold(args);
  return pick;
}
