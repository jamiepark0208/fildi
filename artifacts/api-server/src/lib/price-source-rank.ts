/**
 * A63 — source rank for prices_historical upserts.
 * Jamie 10-14: Yahoo last. Schwab > FMP/Polygon > LSEG > Yahoo.
 * Claude plan: only replace when incoming outranks AND |Δclose| < 2% (else conflict).
 */

export const PRICE_SOURCE_RANK: Record<string, number> = {
  schwab: 40,
  fmp: 30,
  polygon: 30,
  lseg: 20,
  yahoo: 10,
  unknown: 0,
};

/** Max relative close change allowed when overwriting a lower-ranked bar (Claude A63). */
export const PRICE_REPLACE_MAX_REL = 0.02;

export function priceSourceRank(source: string | null | undefined): number {
  if (!source) return PRICE_SOURCE_RANK.unknown;
  return PRICE_SOURCE_RANK[source.toLowerCase()] ?? PRICE_SOURCE_RANK.unknown;
}

export type PriceReplaceDecision =
  | { action: "insert" }
  | { action: "replace" }
  | { action: "keep"; reason: "rank" | "jump" | "same" };

/**
 * Decide whether an incoming bar should replace a stored one.
 * - No existing → insert
 * - Incoming rank ≤ stored → keep (unless stored unknown and incoming known — still need rank >)
 * - Incoming outranks but |new/old−1| ≥ 2% → keep + jump (caller logs conflict)
 * - Incoming outranks and close within 2% → replace
 */
export function decidePriceReplace(opts: {
  existingClose: number | null | undefined;
  existingSource: string | null | undefined;
  incomingClose: number;
  incomingSource: string;
}): PriceReplaceDecision {
  const { existingClose, existingSource, incomingClose, incomingSource } = opts;
  if (existingClose == null || !Number.isFinite(existingClose) || existingClose <= 0) {
    return { action: "insert" };
  }
  const er = priceSourceRank(existingSource);
  const ir = priceSourceRank(incomingSource);
  if (ir < er) return { action: "keep", reason: "rank" };
  if (ir === er) {
    // Same rank: keep first writer (stable); do not thrash Yahoo↔Yahoo.
    return { action: "keep", reason: "same" };
  }
  const rel = Math.abs(incomingClose / existingClose - 1);
  if (rel >= PRICE_REPLACE_MAX_REL) return { action: "keep", reason: "jump" };
  return { action: "replace" };
}
