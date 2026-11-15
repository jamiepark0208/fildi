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
  "grossProfit", "annualOperatingCashFlow", "interestExpense",   // 11-11: were left local → GPA/accruals/intcov mixed units
  "totalAssets",   // 11-11: sec_local (IFRS 20-F Assets, TSM/ASML) + fmp are reporting currency
] as const;

const NON_USD_PER_SHARE_FIELDS = ["earningsPerShare", "tangibleBookValuePerShare"] as const;   // TM finnhub TBVPS 2956 = JPY
/**
 * 11-04: Yahoo per-share values are already USD per US-listed share (price/trailingEps = trailingPE on all
 * 22 non-USD filers checked: TM 22.76, JD 1.43, ASML 40.64). Only fallback vendors carry reporting-currency EPS.
 */
const PRICE_CONSISTENT_PER_SHARE_SOURCES = new Set(["yahoo"]);

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

/** Vendors whose statement absolutes are in the filer's reporting currency (TSM yahoo 4.94T TWD vs factset 169B USD). */
const LOCAL_CURRENCY_SOURCES = new Set(["yahoo", "fmp", "finnhub", "alpha_vantage", "sec_local"]);
/** Converted value vs FactSet USD beyond this ratio gap → divergent (Needs Review), not silently trusted. */
const FX_CROSSCHECK_TOL = 0.35;

export type NonUsdOutcome = { field: string; action: "converted" | "factset" | "cleared"; detail: string };

/**
 * FMP/Yahoo local-currency absolutes stored as if USD (A318 / ADR reporters).
 * 11-11 (Jamie: "TSM is not pre-revenue… find a better source"): convert, don't blank —
 *   1. local-currency source + FX rate → value × usdPerUnit (source "<src>+fx"), cross-checked vs FactSet USD;
 *   2. else FactSet USD bronze for the field;
 *   3. else clear (unknown) — every outcome is returned so the caller logs it for review.
 */
export function applyNonUsdAbsoluteGoldPolicy(
  update: Record<string, number>,
  provenanceBatch: ProvenanceEntry[],
  financialCurrency: string | null | undefined,
  fx?: { usdPerUnit: number | null; bronze?: Map<string, Map<string, number>> },
): string[] {
  return applyNonUsdAbsoluteGoldPolicyDetailed(update, provenanceBatch, financialCurrency, fx).cleared;
}

export function applyNonUsdAbsoluteGoldPolicyDetailed(
  update: Record<string, number>,
  provenanceBatch: ProvenanceEntry[],
  financialCurrency: string | null | undefined,
  fx?: { usdPerUnit: number | null; bronze?: Map<string, Map<string, number>> },
): { cleared: string[]; outcomes: NonUsdOutcome[] } {
  const fc = financialCurrency?.trim().toUpperCase();
  const outcomes: NonUsdOutcome[] = [];
  if (!fc || fc === "USD") return { cleared: [], outcomes };
  const rate = fx?.usdPerUnit != null && Number.isFinite(fx.usdPerUnit) && fx.usdPerUnit > 0 ? fx.usdPerUnit : null;
  const cleared: string[] = [];
  for (const field of NON_USD_ABSOLUTE_FIELDS) {
    const factset = fx?.bronze?.get(field)?.get("factset") ?? null;
    const pi = provenanceBatch.findIndex((p) => p.field === field);
    const src = pi >= 0 ? provenanceBatch[pi]!.result.source : null;
    const local = update[field];
    if (local == null && factset == null) continue;
    if (local != null && rate != null && src && LOCAL_CURRENCY_SOURCES.has(src)) {
      const usd = local * rate;
      const divergent =
        factset != null && Math.abs(factset) > 0 && Math.abs(usd / factset - 1) > FX_CROSSCHECK_TOL;
      update[field] = usd;
      const result = { source: `${src}+fx`, value: usd, isOverride: false, divergent };
      provenanceBatch[pi]!.result = result;
      outcomes.push({ field, action: "converted",
        detail: `${src} ${local} ${fc} × ${rate} = ${usd.toFixed(0)} USD` + (factset != null ? ` · factset ${factset}` : "") +
          (divergent ? " · DIVERGENT vs factset" : "") });
      continue;
    }
    if (factset != null) {
      setDerivedGold(field, factset, update, provenanceBatch);
      provenanceBatch.find((p) => p.field === field)!.result.source = "factset";
      outcomes.push({ field, action: "factset", detail: `no FX-convertible ${fc} source (${src ?? "none"}) → factset USD ${factset}` });
      continue;
    }
    delete update[field];
    if (pi >= 0) provenanceBatch.splice(pi, 1);
    cleared.push(field);
    outcomes.push({ field, action: "cleared", detail: `${src ?? "?"} value in ${fc}, no FX rate${rate == null ? "" : " for this source"} and no factset USD` });
  }
  for (const field of NON_USD_PER_SHARE_FIELDS) {
    if (update[field] == null) continue;
    const pi = provenanceBatch.findIndex((p) => p.field === field);
    const src = pi >= 0 ? provenanceBatch[pi]!.result.source : null;
    if (src && PRICE_CONSISTENT_PER_SHARE_SOURCES.has(src)) continue;
    if (src === "factset") continue; // FactSet overview highlights already USD
    const factsetPs = fx?.bronze?.get(field)?.get("factset") ?? null;
    if (factsetPs != null && Number.isFinite(factsetPs)) {
      setDerivedGold(field, factsetPs, update, provenanceBatch);
      provenanceBatch.find((p) => p.field === field)!.result.source = "factset";
      outcomes.push({ field, action: "factset", detail: `non-USD per-share (${src ?? "?"}) → factset USD ${factsetPs}` });
      continue;
    }
    delete update[field];
    if (pi >= 0) provenanceBatch.splice(pi, 1);
    cleared.push(field);
    outcomes.push({ field, action: "cleared", detail: `per-share in ${fc} from a non-price-consistent source` });
  }
  return { cleared, outcomes };
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
  fx?: { usdPerUnit: number | null; bronze?: Map<string, Map<string, number>> };
}): { clearedNonUsd: string[]; gaapEbitda: boolean; nonUsdOutcomes: NonUsdOutcome[] } {
  const { cleared: clearedNonUsd, outcomes: nonUsdOutcomes } = applyNonUsdAbsoluteGoldPolicyDetailed(
    opts.update,
    opts.provenanceBatch,
    opts.financialCurrency,
    opts.fx,
  );
  const gaapEbitda = applyGaapEbitdaGoldPolicy(opts.update, opts.provenanceBatch, opts.existing);
  return { clearedNonUsd, gaapEbitda, nonUsdOutcomes };
}
