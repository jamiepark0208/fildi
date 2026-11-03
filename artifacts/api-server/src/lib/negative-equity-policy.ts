/**
 * A329 segment 1 — negative book equity: do not score vendor D/E or ROE; fund score uses worst leverage.
 */
export const NEGATIVE_EQUITY_WORST_DE = 999;

export function hasNegativeEquity(equity: number | null | undefined): boolean {
  return equity != null && Number.isFinite(equity) && equity < 0;
}

const LEVERAGE_RETURN_FIELDS = ["debtToEquity", "returnOnEquity"] as const;

type ProvenanceEntry = {
  field: string;
  result: { source: string; value: number | null; isOverride: boolean; divergent: boolean };
};

/** After vendor pick + derives: clear leverage/return gold when equity is negative. */
export function applyNegativeEquityGoldPolicy(
  update: Record<string, unknown>,
  provenanceBatch: ProvenanceEntry[],
): void {
  const eq = update.totalStockholdersEquity;
  if (!hasNegativeEquity(typeof eq === "number" ? eq : Number(eq))) {
    return;
  }
  update.negativeEquity = true;
  for (const field of LEVERAGE_RETURN_FIELDS) {
    if (update[field] == null) continue;
    update[field] = null;
    const pi = provenanceBatch.findIndex((p) => p.field === field);
    if (pi >= 0) provenanceBatch.splice(pi, 1);
  }
}
