/**
 * A329 L3 — spec root causes, impact ranking, guard metadata for Claude review.
 */

export type SpecCause =
  | "wrong_period"
  | "currency_mix"
  | "adr_scaling"
  | "nci_vs_to_common"
  | "stale_pull"
  | "vendor_unit_bug"
  | "definition_mismatch"
  | "negative_equity"
  | "split_not_applied"
  | "stand_in_zero"
  | "two_pickers";

/** L3 causes excluded from segment error-rate totals (expected vendor definition gaps). */
export const ERROR_RATE_EXCLUDED_CAUSES = new Set<SpecCause>(["definition_mismatch"]);

export type SkipReason = "gold_null" | "no_l0_identity" | "non_usd";

export type CauseMeta = {
  rootCause: string;
  guard: string;
  test: string;
};

export const CAUSE_META: Record<SpecCause, CauseMeta> = {
  wrong_period: {
    rootCause: "Statement period or growth base differs from gold identity window.",
    guard: "stock-db-audit-guards.ts:shouldFlagVendorGap + merge-trusted PERIOD_SENSITIVE_TFCOLS refresh",
    test: "stock-db-audit.test.ts wrong_period identity",
  },
  currency_mix: {
    rootCause: "Local-currency absolute stored as USD without conversion.",
    guard: "stock-db-audit-guards.ts:nonUsdSkipReason",
    test: "stock-db-audit.test.ts non_usd skip",
  },
  adr_scaling: {
    rootCause: "ADR share ratio or line-item scale breaks mcap ÷ price identity.",
    guard: "stock-db-audit-guards.ts:missingL0Inputs + share_mcap check",
    test: "stock-db-audit.test.ts adr mcap mismatch",
  },
  nci_vs_to_common: {
    rootCause: "Net income or equity includes NCI while gold uses common-only.",
    guard: "merge-trusted.ts isMaterialDivergence sign/scale on equity fields",
    test: "stock-db-audit-l2_test.py margin band",
  },
  stale_pull: {
    rootCause: "Gold primitive older than latest filing / price snapshot.",
    guard: "gold-pick.ts pickFieldGold timeliness + SOURCE_FRESH_MS",
    test: "gold-pick.test.ts timeliness",
  },
  vendor_unit_bug: {
    rootCause: "Vendor stored percent as fraction, wrong unit, or immaterial noise flagged.",
    guard: "stock-db-audit-guards.ts:shouldFlagVendorGap",
    test: "stock-db-audit.test.ts vendor in tolerance ok",
  },
  definition_mismatch: {
    rootCause: "Vendor field uses a different formula or growth base than gold (e.g. PEG).",
    guard: "merge-trusted.ts:owned pegRatio = peRatio ÷ gold epsGrowth",
    test: "stock-db-audit.test.ts peg vendor gap → definition_mismatch",
  },
  negative_equity: {
    rootCause: "Shareholders equity is negative; D/E and ROE must not be scored from vendor ratios.",
    guard: "negative-equity-policy.ts:applyNegativeEquityGoldPolicy",
    test: "stock-db-audit.test.ts negative equity identity",
  },
  split_not_applied: {
    rootCause: "Share count or price not split-adjusted vs mcap identity.",
    guard: "stock-db-audit-guards.ts:missingL0Inputs shares+price",
    test: "stock-db-audit.test.ts share_mcap",
  },
  stand_in_zero: {
    rootCause: "Missing primitive coerced to zero or gold filled without inputs.",
    guard: "stock-db-audit-guards.ts:missingL0Inputs",
    test: "stock-db-audit.test.ts input_missing flag",
  },
  two_pickers: {
    rootCause: "Stored gold ≠ pickFieldGold replay or provenance still divergent.",
    guard: "stock-db-audit-guards.ts:shouldFlagPickerDrift",
    test: "stock-db-audit.test.ts picker drift material only",
  },
};

/** Fields that feed fund score / DCF-style ratios (impact multiplier). */
export const FUND_IMPACT_FIELDS = new Set([
  "peRatio", "pegRatio", "forwardPe", "forwardPeg", "evEbitda", "evRevenue", "priceToBook", "priceToSales",
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "epsGrowth", "debtToEquity", "freeCashFlow", "totalRevenue", "netIncome", "ebitda",
]);

function relGap(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
}

export function inferSpecCause(
  pipelineClass: string | null,
  input: { field: string; gold: number | null; fund: Record<string, unknown> },
  evidence: string | null,
): SpecCause {
  const { field, fund } = input;
  const eqRaw = fund.totalStockholdersEquity;
  const eq =
    eqRaw == null || eqRaw === ""
      ? null
      : typeof eqRaw === "number"
        ? eqRaw
        : parseFloat(String(eqRaw));
  const negativeEq = eq != null && Number.isFinite(eq) && eq < 0;
  if (
    negativeEq
    && (field === "debtToEquity" || field === "returnOnEquity")
    && (pipelineClass === "identity_mismatch" || (input.gold != null && input.gold < 0))
  ) {
    return "negative_equity";
  }
  if ((field === "pegRatio" || field === "forwardPeg") && pipelineClass === "vendor_disagreement") {
    return "definition_mismatch";
  }
  if (pipelineClass === "unit_scale") return "vendor_unit_bug";
  if (pipelineClass === "share_mcap_mismatch") {
    return evidence?.includes("mcap") ? "adr_scaling" : "split_not_applied";
  }
  if (pipelineClass === "divergent_open" || pipelineClass === "gold_picker_drift") return "two_pickers";
  if (pipelineClass === "input_missing") return "stand_in_zero";
  if (pipelineClass === "identity_mismatch") {
    if (Math.abs(input.gold ?? 0) < 0.02) return "stand_in_zero";
    return "wrong_period";
  }
  if (pipelineClass === "vendor_disagreement") {
    if (FRACTION_UNIT_FIELDS.has(field) && evidence?.includes("percent")) return "vendor_unit_bug";
    return "vendor_unit_bug";
  }
  const cur = String(fund.reportedCurrency ?? "").toUpperCase();
  if (cur && cur !== "USD") return "currency_mix";
  return "stale_pull";
}

const FRACTION_UNIT_FIELDS = new Set(["grossMargin", "operatingMargin", "netMargin", "returnOnEquity"]);

export function impactScore(
  f: { status: string; gold: number | null; field: string; ticker: string; gap?: number },
  modelList: Set<string>,
): number {
  if (f.status !== "flag" || f.gold == null) return 0;
  const gap = f.gap ?? 0.25;
  const fundW = FUND_IMPACT_FIELDS.has(f.field) ? 3 : 1;
  const mlW = modelList.has(f.ticker.toUpperCase()) ? 2 : 1;
  return gap * fundW * mlW;
}

export function parseGapFromEvidence(evidence: string | null, gold: number | null): number {
  if (!evidence || gold == null) return 0.25;
  const m = evidence.match(/identity=([\d.eE+-]+)/);
  if (m) {
    const id = parseFloat(m[1]!);
    if (Number.isFinite(id)) return relGap(id, gold);
  }
  const nums = [...evidence.matchAll(/=([\d.eE+-]+)/g)].map((x) => parseFloat(x[1]!)).filter(Number.isFinite);
  if (nums.length > 0) {
    return Math.max(...nums.map((n) => relGap(n, gold)));
  }
  return 0.25;
}

export function rankTopFlags<T extends {
  status: string;
  gold: number | null;
  field: string;
  ticker: string;
  evidence: string | null;
}>(
  flags: T[],
  modelList: Set<string>,
  limit = 20,
): (T & { gap: number; impact: number })[] {
  return flags
    .map((f) => {
      const gap = parseGapFromEvidence(f.evidence, f.gold);
      const impact = impactScore({ ...f, gap }, modelList);
      return { ...f, gap, impact };
    })
    .sort((a, b) => b.impact - a.impact || b.gap - a.gap || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}
