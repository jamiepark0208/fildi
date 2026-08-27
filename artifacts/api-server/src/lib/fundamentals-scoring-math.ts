// Pure scoring math for fundamental family scores. Deliberately free of DB imports so
// it can be unit-tested directly (importing fundamentals-db.ts drags in @workspace/db,
// which the node test runner can't resolve without a build).

// ── Coverage gating + shrinkage ───────────────────────────────────────────────
// Missing metrics used to be dropped from BOTH numerator and denominator, so a family
// score was the average of whatever happened to exist, with no penalty and no signal.
// That is how WTR — which has exactly one non-null metric (operating margin, 95th pct)
// — scored 95.1 quality and ranked #1 of 558, while growth/safety displayed a
// placeholder 50 that wasn't in the total at all.
//
// Zeroing the missing metrics instead would be just as wrong in the other direction
// (a sparse ticker would be crushed for a data-pipeline gap, not a business flaw).
// So: gate, then shrink toward neutral by how much we actually know.
//
//   score = 50 + (raw - 50) * sqrt(coverage)
//
// sqrt (rather than linear) keeps well-covered tickers essentially untouched while
// pulling thin ones hard toward neutral: coverage 1.00 -> full conviction,
// 0.50 -> 71% of the distance from neutral, 0.09 (WTR) -> 30%. This is ordinary
// empirical-Bayes shrinkage toward the prior — the prior here being "average stock".

export const NEUTRAL_SCORE = 50;
export const FAMILY_MIN_COVERAGE = 0.5; // below this the family is null (n/a), not a number
export const TOTAL_MIN_COVERAGE  = 0.4; // below this the ticker is unranked entirely

/** Pull a raw 0-100 family score toward neutral in proportion to sqrt(coverage).
 *  Returns null when coverage is too thin to publish a number at all. */
export function shrinkToNeutral(rawScore: number, coverage: number): number | null {
  if (!(coverage >= FAMILY_MIN_COVERAGE)) return null;
  const c = Math.min(1, Math.max(0, coverage));
  return NEUTRAL_SCORE + (rawScore - NEUTRAL_SCORE) * Math.sqrt(c);
}
