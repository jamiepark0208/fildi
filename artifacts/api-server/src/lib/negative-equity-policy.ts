/**
 * A329 segment 1 — negative book equity: clear gold D/E + ROE; fund score skips those metrics
 * (net debt/EBITDA + interest coverage still score leverage).
 */
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
  existing?: Record<string, unknown> | null,
): string[] {
  const eqRaw = update.totalStockholdersEquity ?? existing?.totalStockholdersEquity;
  const eq = typeof eqRaw === "number" ? eqRaw : eqRaw != null ? Number(eqRaw) : null;
  if (!hasNegativeEquity(eq)) {
    if (existing?.negativeEquity === true || update.negativeEquity === true) {
      update.negativeEquity = false;
    }
    return [];
  }
  update.negativeEquity = true;
  const cleared: string[] = [];
  for (const field of LEVERAGE_RETURN_FIELDS) {
    const hadGold = update[field] != null || existing?.[field] != null;
    update[field] = null;
    const pi = provenanceBatch.findIndex((p) => p.field === field);
    if (pi >= 0) provenanceBatch.splice(pi, 1);
    if (hadGold) cleared.push(field);
  }
  return cleared;
}
