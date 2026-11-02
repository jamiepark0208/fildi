import { isFactsetRulerField } from "./factset-ruler-table.js";

/**
 * Database Agent — Needs Review mediation (cheapest accurate gold).
 *
 * Pure decision helpers + note encoding. No API I/O here so unit tests stay free.
 *
 * Cost ladder (prefer left):
 *   yahoo → edgar → finnhub → polygon → alpha_vantage → fmp → factset
 * Research refs (0 API when local): wrds finratio, lseg gold_audit, schwab quote-derived.
 * Web: last resort only (never default).
 */

export const AGENT_NOTE_PREFIX = "agent:v1";

/** Cheapest → dearest among free/paid silver we already store. */
export const SOURCE_COST_RANK: Record<string, number> = {
  yahoo: 10,
  edgar: 15,
  finnhub: 20,
  polygon: 25,
  alpha_vantage: 35,
  fmp: 45,
  derived: 50,
  factset: 90,
  schwab: 55,
  wrds: 5, // local cache — free after sync
  lseg: 70,
  manual: 100,
};

export type SourceQuote = {
  source: string;
  value: number;
  /** true = local research / already-paid cache, not a live vendor pull */
  cached?: boolean;
};

export type ResolveDecision =
  | {
      action: "override";
      source: string;
      value: number;
      reason:
        | "majority_cheap"
        | "factset_nearest_free"
        | "research_confirms_cheap"
        | "research_nearest_free"
        | "derived_confirms_cheap"
        | "primary_vs_edgar"
        | "scale_outlier_drop"
        | "singleton_cheap"
        | "manual_literal";
      cluster: SourceQuote[];
      rejected: SourceQuote[];
      research: SourceQuote[];
    }
  | {
      action: "skip";
      reason: "ambiguous" | "no_sources" | "already_ok";
      cluster: SourceQuote[];
      rejected: SourceQuote[];
      research: SourceQuote[];
    };

/** Fields where EDGAR is a different window / last-resort — don't let it veto yahoo. */
export const EDGAR_SECONDARY_FIELDS = new Set([
  "grossProfit",
  "totalRevenue",
  "netIncome",
  "ebitda",
  "ebit",
  "freeCashFlow",
  "sharesOutstanding",
  "sharesOutstandingPrior",
]);

/** Relative closeness for clustering (matches merge referee spirit). */
export function valuesClose(a: number, b: number, tol = 0.15): boolean {
  const absA = Math.abs(a), absB = Math.abs(b);
  const maxAbs = Math.max(absA, absB);
  if (maxAbs < 0.02) return true;
  if ((a > 0) !== (b > 0)) return false;
  return Math.abs(a - b) / maxAbs <= tol;
}

function costOf(src: string): number {
  return SOURCE_COST_RANK[src] ?? 80;
}

/** Pick cheapest source in a set (stable by name on ties). */
export function cheapestOf(quotes: SourceQuote[]): SourceQuote | null {
  if (quotes.length === 0) return null;
  return [...quotes].sort((a, b) => costOf(a.source) - costOf(b.source) || a.source.localeCompare(b.source))[0];
}

/** Greedy clusters by relative closeness; largest cluster wins. */
export function clusterQuotes(quotes: SourceQuote[], tol = 0.15): SourceQuote[][] {
  const remaining = [...quotes];
  const clusters: SourceQuote[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const cluster = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (cluster.some((c) => valuesClose(c.value, remaining[i].value, tol))) {
        cluster.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  clusters.sort((a, b) => b.length - a.length || costOf(cheapestOf(a)!.source) - costOf(cheapestOf(b)!.source));
  return clusters;
}

function nearestTo(target: number, quotes: SourceQuote[]): { q: SourceQuote; dist: number } | null {
  let best: { q: SourceQuote; dist: number } | null = null;
  for (const q of quotes) {
    const dist = Math.abs(q.value - target) / Math.max(Math.abs(target), 1e-9);
    if (!best || dist < best.dist) best = { q, dist };
  }
  return best;
}

/**
 * Decide gold for one (ticker, field) given bronze + optional research/derived refs.
 * Prefer majority free cluster's cheapest member; FactSet/research/derived tip fights;
 * edgar-secondary fields drop edgar when a cheaper TTM source exists.
 */
export function decideNeedsReview(input: {
  field?: string;
  free: SourceQuote[];
  factset?: SourceQuote | null;
  research?: SourceQuote[];
  /** Gold-derived value (e.g. price/book from primitives) — 0 API tip. */
  derived?: SourceQuote | null;
}): ResolveDecision {
  let free = input.free.filter((q) => Number.isFinite(q.value));
  const research = (input.research ?? []).filter((q) => Number.isFinite(q.value));
  const factset = input.factset && Number.isFinite(input.factset.value) ? input.factset : null;
  const derived = input.derived && Number.isFinite(input.derived.value) ? input.derived : null;
  const field = input.field;

  if (free.length === 0 && !factset) {
    return { action: "skip", reason: "no_sources", cluster: [], rejected: [], research };
  }

  // Drop ≥3x scale outliers vs the cheapest source — only when ≥3 free quotes
  // (a 2-way fight at 3x+ is ambiguous, not a unit bug we can auto-call).
  const cheapSeed = cheapestOf(free);
  let scaleDropped: SourceQuote[] = [];
  if (cheapSeed && free.length >= 3) {
    const kept: SourceQuote[] = [];
    for (const q of free) {
      const maxAbs = Math.max(Math.abs(q.value), Math.abs(cheapSeed.value));
      const minAbs = Math.min(Math.abs(q.value), Math.abs(cheapSeed.value));
      if (minAbs > 0 && maxAbs / minAbs >= 3 && q.source !== cheapSeed.source) {
        scaleDropped.push(q);
      } else {
        kept.push(q);
      }
    }
    if (kept.length >= 1 && scaleDropped.length > 0) free = kept;
  }

  // Edgar secondary: if yahoo/fmp/finnhub exist, ignore edgar for mediation.
  if (field && EDGAR_SECONDARY_FIELDS.has(field)) {
    const nonEdgar = free.filter((q) => q.source !== "edgar");
    const edgarOnly = free.filter((q) => q.source === "edgar");
    if (nonEdgar.length >= 1 && edgarOnly.length >= 1) {
      const clusters0 = clusterQuotes(nonEdgar);
      if (clusters0[0]?.length >= 1) {
        const pick = cheapestOf(clusters0[0])!;
        // If non-edgar already agree, or only one non-edgar left after scale drop
        if (clusters0[0].length >= 2 || nonEdgar.length === 1 || clusters0.length === 1) {
          return {
            action: "override",
            source: pick.source,
            value: pick.value,
            reason: "primary_vs_edgar",
            cluster: clusters0[0],
            rejected: [...edgarOnly, ...scaleDropped, ...clusters0.slice(1).flat()],
            research,
          };
        }
      }
    }
  }

  const clusters = clusterQuotes(free);
  const best = clusters[0] ?? [];
  const rejected = [...clusters.slice(1).flat(), ...scaleDropped];

  // Majority (≥2 agreeing) → cheapest in cluster
  if (best.length >= 2) {
    const pick = cheapestOf(best)!;
    return {
      action: "override",
      source: pick.source,
      value: pick.value,
      reason: scaleDropped.length ? "scale_outlier_drop" : "majority_cheap",
      cluster: best,
      rejected,
      research,
    };
  }

  // Research: confirm singleton OR pick free nearest to research median
  if (research.length > 0 && free.length > 0) {
    const researchAnchor = research[0].value;
    if (best.length === 1 && valuesClose(best[0].value, researchAnchor, 0.2)) {
      return {
        action: "override",
        source: best[0].source,
        value: best[0].value,
        reason: "research_confirms_cheap",
        cluster: best,
        rejected,
        research,
      };
    }
    const near = nearestTo(researchAnchor, free);
    if (near && near.dist <= 0.2) {
      return {
        action: "override",
        source: near.q.source,
        value: near.q.value,
        reason: "research_nearest_free",
        cluster: [near.q],
        rejected: free.filter((f) => f.source !== near.q.source).concat(scaleDropped),
        research,
      };
    }
  }

  // FactSet tips only on ruler fields (A318 segment 0). Never store FactSet as gold elsewhere.
  if (factset && free.length > 0 && (!field || isFactsetRulerField(field))) {
    const near = nearestTo(factset.value, free);
    if (near && near.dist <= 0.2) {
      return {
        action: "override",
        source: near.q.source,
        value: near.q.value,
        reason: "factset_nearest_free",
        cluster: [near.q],
        rejected: free.filter((f) => f.source !== near.q.source).concat(scaleDropped),
        research,
      };
    }
  }

  if (free.length >= 1 && field && !isFactsetRulerField(field) && best.length < 2) {
    const pick = cheapestOf(free.length ? free : best)!;
    return {
      action: "override",
      source: pick.source,
      value: pick.value,
      reason: "singleton_cheap",
      cluster: best.length >= 1 ? best : [pick],
      rejected,
      research,
    };
  }

  // Derived gold tip (P/B from price÷book) when FactSet absent. Prefer derived literal
  // when ≥1 free source within 25% (sanity) — matches merge computePriceToBook.
  if (derived && free.length > 0) {
    const inBand = free.filter(
      (q) => Math.abs(q.value - derived.value) / Math.max(Math.abs(derived.value), 1e-9) <= 0.25,
    );
    if (inBand.length > 0) {
      return {
        action: "override",
        source: "manual",
        value: derived.value,
        reason: "derived_confirms_cheap",
        cluster: [{ source: "derived", value: derived.value }, ...inBand],
        rejected: free.filter((f) => !inBand.includes(f)).concat(scaleDropped),
        research: [...research, derived],
      };
    }
  }

  // After scale drop, only one free left
  if (best.length === 1 && rejected.filter((r) => !scaleDropped.includes(r)).length === 0) {
    const pick = best[0];
    return {
      action: "override",
      source: pick.source,
      value: pick.value,
      reason: scaleDropped.length ? "scale_outlier_drop" : "singleton_cheap",
      cluster: best,
      rejected,
      research,
    };
  }

  if (best.length === 1 && scaleDropped.length > 0 && clusters.length === 1) {
    return {
      action: "override",
      source: best[0].source,
      value: best[0].value,
      reason: "scale_outlier_drop",
      cluster: best,
      rejected,
      research,
    };
  }

  return { action: "skip", reason: "ambiguous", cluster: best, rejected, research };
}

/** Encode decision into manual_overrides.note — shown in cell popup. */
export function encodeAgentNote(d: Extract<ResolveDecision, { action: "override" }>, extra?: string): string {
  const fmt = (q: SourceQuote) => `${q.source}:${Number(q.value.toPrecision(6))}`;
  const parts = [
    AGENT_NOTE_PREFIX,
    `chose=${d.source}`,
    `val=${Number(d.value.toPrecision(6))}`,
    `reason=${d.reason}`,
    `cluster=${d.cluster.map(fmt).join(",") || "—"}`,
    d.rejected.length ? `skip=${d.rejected.map(fmt).join(",")}` : null,
    d.research.length ? `research=${d.research.map(fmt).join(",")}` : null,
    extra ? `extra=${extra}` : null,
  ].filter(Boolean);
  return parts.join("|");
}

export function isAgentNote(note: string | null | undefined): boolean {
  return typeof note === "string" && note.startsWith("agent:");
}

/** Parse chose= / val= / reason= from agent note for UI. */
export function parseAgentNote(note: string | null | undefined): {
  chose?: string;
  val?: string;
  reason?: string;
  cluster?: string;
  research?: string;
  raw: string;
} | null {
  if (!isAgentNote(note)) return null;
  const raw = note!;
  const get = (k: string) => {
    const m = raw.match(new RegExp(`(?:^|\\|)${k}=([^|]+)`));
    return m?.[1];
  };
  return {
    chose: get("chose"),
    val: get("val"),
    reason: get("reason"),
    cluster: get("cluster"),
    research: get("research"),
    raw,
  };
}

/** Map tfCol → WRDS finratio_snapshot column (and transform). */
export const WRDS_FIELD_MAP: Record<
  string,
  { col: string; transform?: (v: number) => number }
> = {
  peRatio: { col: "pe_exi" },
  // WRDS bm = book/market → P/B = 1/bm
  priceToBook: { col: "bm", transform: (bm) => (bm > 0 ? 1 / bm : NaN) },
  priceToSales: { col: "ps" },
  returnOnEquity: { col: "roe" },
  returnOnAssets: { col: "roa" },
  netMargin: { col: "npm" },
  grossMargin: { col: "gpm" },
  debtToEquity: { col: "de_ratio" },
  currentRatio: { col: "curr_ratio" },
};
