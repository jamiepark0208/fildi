/**
 * A329 segment 2 — align statement gold with FIELD_DEFS definitions (SEC truth parity).
 */
import {
  computeGaapEbitdaTtm,
  vendorEbitdaIsAdjustedOutlier,
} from "./derived-metrics.js";

const NON_USD_ABSOLUTE_FIELDS = [
  "totalRevenue",
  "netIncome",
  "ebitda",
  "ebit",
  "totalDebt",
  "cashAndEquivalents",
  "freeCashFlow",
  "quarterlyOperatingCashFlow",
  "totalStockholdersEquity",
] as const;

type ProvenanceEntry = {
  field: string;
  result: { source: string; value: number | null; isOverride: boolean; divergent: boolean };
};

function setDerivedGold(
  field: string,
  value: number,
  update: Record<string, number>,
  provenanceBatch: ProvenanceEntry[],
): void {
  update[field] = value;
  const prev = provenanceBatch.find((p) => p.field === field);
  const result = { source: "derived", value, isOverride: false, divergent: false };
  if (prev) prev.result = result;
  else provenanceBatch.push({ field, result });
}

/** FMP/Yahoo local-currency absolutes stored as if USD (A318 / ADR reporters). */
export function applyNonUsdAbsoluteGoldPolicy(
  update: Record<string, number>,
  provenanceBatch: ProvenanceEntry[],
  financialCurrency: string | null | undefined,
): string[] {
  const fc = financialCurrency?.trim().toUpperCase();
  if (!fc || fc === "USD") return [];
  const cleared: string[] = [];
  for (const field of NON_USD_ABSOLUTE_FIELDS) {
    if (update[field] == null) continue;
    delete update[field];
    const pi = provenanceBatch.findIndex((p) => p.field === field);
    if (pi >= 0) provenanceBatch.splice(pi, 1);
    cleared.push(field);
  }
  return cleared;
}

/** Gold EBITDA = GAAP operating income + D&A TTM; vendor adjusted labels stay in source_fundamentals only. */
export function applyGaapEbitdaGoldPolicy(
  update: Record<string, number>,
  provenanceBatch: ProvenanceEntry[],
  existing?: Record<string, unknown> | null,
): boolean {
  const ebit = update.ebit ?? (existing?.ebit != null ? Number(existing.ebit) : null);
  const da =
    update.depreciationAmortization ??
    (existing?.depreciationAmortization != null ? Number(existing.depreciationAmortization) : null);
  const gaap = computeGaapEbitdaTtm(ebit, da);
  if (gaap == null) return false;
  const vendor = update.ebitda ?? (existing?.ebitda != null ? Number(existing.ebitda) : null);
  if (vendor != null && !vendorEbitdaIsAdjustedOutlier(vendor, gaap)) return false;
  setDerivedGold("ebitda", gaap, update, provenanceBatch);
  return true;
}

export function applyStatementGoldPolicies(opts: {
  update: Record<string, number>;
  provenanceBatch: ProvenanceEntry[];
  existing?: Record<string, unknown> | null;
  financialCurrency: string | null | undefined;
}): { clearedNonUsd: string[]; gaapEbitda: boolean } {
  const clearedNonUsd = applyNonUsdAbsoluteGoldPolicy(
    opts.update,
    opts.provenanceBatch,
    opts.financialCurrency,
  );
  const gaapEbitda = applyGaapEbitdaGoldPolicy(opts.update, opts.provenanceBatch, opts.existing);
  return { clearedNonUsd, gaapEbitda };
}
