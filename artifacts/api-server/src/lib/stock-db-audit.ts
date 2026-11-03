/**
 * A329 Stock DB audit — L0 identities + L1 cross-source (pure; DB in script).
 * Reuses pickFieldGold / inBand from gold-pick (same band as merge-trusted).
 */

import {
  computeDebtToEquity,
  computeForwardPeFromPriceEps,
  computeForwardPeg,
  computeNetMargin,
  computeOperatingMargin,
  computePeFromPriceEps,
  computePriceToBook,
  computePriceToSales,
  computeReturnOnEquity,
  computeTrailingPeg,
} from "./derived-metrics.js";
import { inBand, pickFieldGold, type GoldQuote } from "./gold-pick.js";

export const SMOKE_TICKERS = [
  "AAPL", "BABA", "TSM", "TCOM", "KKR", "TKO", "C", "ASML", "RKT", "SKWD",
] as const;

export type AuditLayer = "L0" | "L1";
export type RowStatus = "ok" | "flag" | "skip";

export type ErrorClass =
  | "identity_mismatch"
  | "vendor_disagreement"
  | "divergent_open"
  | "gold_picker_drift"
  | "unit_scale"
  | "share_mcap_mismatch";

export type ClassMeta = {
  rootCause: string;
  guard: string;
  test: string;
};

/** L3 guard map — one row per class for recurring-bugs / Claude review. */
export const ERROR_CLASS_META: Record<ErrorClass, ClassMeta> = {
  identity_mismatch: {
    rootCause: "Gold ratio/derive disagrees with recomputed identity from gold primitives + last close.",
    guard: "derived-metrics.ts applyDerived + merge-trusted applyDerived overwrite vendor ratios",
    test: "stock-db-audit.test.ts identity AAPL peRatio",
  },
  vendor_disagreement: {
    rootCause: "Stored vendor value material vs gold outside FIELD_DEFS band.",
    guard: "gold-pick.ts inBand + merge-trusted isMaterialDivergence",
    test: "gold-pick.test.ts inBand fraction floor",
  },
  divergent_open: {
    rootCause: "field_provenance.divergent still true — free sources disagree and NR unsettled.",
    guard: "database-agent-resolve.ts pickFieldGold mediation",
    test: "database-agent-resolve.test.ts",
  },
  gold_picker_drift: {
    rootCause: "Stored gold ≠ pickFieldGold on same bronze cluster (second picker avoided in merge).",
    guard: "merge-trusted.ts resolveField uses pickFieldGold when divergent",
    test: "gold-pick.test.ts pickFieldGold timeliness",
  },
  unit_scale: {
    rootCause: "Fraction field looks like percent (|v|>1.5) or 100× scale error vs peers.",
    guard: "merge-trusted populate heuristics + recurring-bugs Yahoo D/E percent",
    test: "stock-db-audit.test.ts unit_scale fixture",
  },
  share_mcap_mismatch: {
    rootCause: "marketCap ≠ close × shares beyond 25% (ADR/split/currency).",
    guard: "merge-trusted sharesOutstanding >0 gate",
    test: "stock-db-audit.test.ts mcap identity",
  },
};

const FRACTION_FIELDS = new Set([
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "revenueGrowthYoyPrior", "epsGrowth", "dividendYield", "effectiveTaxRate",
  "debtToEquity",
]);

export type FundRow = Record<string, string | number | null | undefined>;

export type SourceVal = { source: string; field: string; value: number; fetchedAt?: string | null };

export type AuditInput = {
  ticker: string;
  field: string;
  gold: number | null;
  price: number | null;
  fund: FundRow;
  sources: SourceVal[];
  divergent: boolean;
  winningSource: string | null;
};

export type AuditFinding = {
  ticker: string;
  field: string;
  layer: AuditLayer;
  status: RowStatus;
  gold: number | null;
  class: ErrorClass | null;
  rootCause: string | null;
  evidence: string | null;
  fix: string | null;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function relGap(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
}

/** Hand-check anchor: price 100, EPS 5 → PE 20 (see fixture). */
export function l0Expected(field: string, fund: FundRow, price: number | null): number | null {
  const f = fund;
  switch (field) {
    case "peRatio":
      return computePeFromPriceEps(price, num(f.earningsPerShare));
    case "forwardPe":
      return computeForwardPeFromPriceEps(price, num(f.forwardEps));
    case "priceToBook":
      return computePriceToBook(price, num(f.totalStockholdersEquity), num(f.sharesOutstanding));
    case "priceToSales":
      return computePriceToSales(price, num(f.totalRevenue), num(f.sharesOutstanding));
    case "netMargin":
      return computeNetMargin(num(f.netIncome), num(f.totalRevenue));
    case "operatingMargin":
      return computeOperatingMargin(num(f.ebit), num(f.totalRevenue));
    case "pegRatio":
      return computeTrailingPeg(num(f.peRatio), num(f.epsGrowth));
    case "forwardPeg":
      return computeForwardPeg(num(f.forwardPe), num(f.epsGrowth));
    case "debtToEquity":
      return computeDebtToEquity(num(f.totalDebt), num(f.totalStockholdersEquity));
    case "returnOnEquity":
      return computeReturnOnEquity(num(f.netIncome), num(f.totalStockholdersEquity));
    default:
      return null;
  }
}

export function auditL0(input: AuditInput): AuditFinding {
  const { ticker, field, gold } = input;
  const base: AuditFinding = {
    ticker,
    field,
    layer: "L0",
    status: "skip",
    gold,
    class: null,
    rootCause: null,
    evidence: null,
    fix: null,
  };
  if (gold == null) return { ...base, status: "skip" };

  if (FRACTION_FIELDS.has(field) && Math.abs(gold) > 1.5 && field !== "debtToEquity") {
    return {
      ...base,
      status: "flag",
      class: "unit_scale",
      rootCause: ERROR_CLASS_META.unit_scale.rootCause,
      evidence: `gold=${gold} looks like percent not fraction`,
      fix: ERROR_CLASS_META.unit_scale.guard,
    };
  }

  const price = input.price;
  const sh = num(input.fund.sharesOutstanding);
  if (price != null && sh != null && sh > 0) {
    const mcapField = num(input.fund.marketCap as string | number | null | undefined);
    const implied = price * sh;
    const mcap = mcapField ?? implied;
    if (mcapField != null && mcapField > 0 && relGap(mcapField, implied) > 0.25) {
      return {
        ...base,
        status: "flag",
        class: "share_mcap_mismatch",
        rootCause: ERROR_CLASS_META.share_mcap_mismatch.rootCause,
        evidence: `mcap=${mcapField.toExponential(3)} vs px×sh=${implied.toExponential(3)}`,
        fix: ERROR_CLASS_META.share_mcap_mismatch.guard,
      };
    }
  }

  const expected = l0Expected(field, input.fund, price);
  if (expected == null) return base;
  if (!inBand(field, expected, gold)) {
    return {
      ...base,
      status: "flag",
      class: "identity_mismatch",
      rootCause: ERROR_CLASS_META.identity_mismatch.rootCause,
      evidence: `identity=${expected.toPrecision(6)} gold=${gold.toPrecision(6)}`,
      fix: ERROR_CLASS_META.identity_mismatch.guard,
    };
  }
  return { ...base, status: "ok" };
}

function materialVsGold(field: string, gold: number, srcVal: number): boolean {
  return !inBand(field, gold, srcVal);
}

export function auditL1(input: AuditInput): AuditFinding {
  const { ticker, field, gold, sources, divergent } = input;
  const base: AuditFinding = {
    ticker,
    field,
    layer: "L1",
    status: gold == null ? "skip" : "ok",
    gold,
    class: null,
    rootCause: null,
    evidence: null,
    fix: null,
  };
  if (gold == null) return base;

  if (divergent) {
    return {
      ...base,
      status: "flag",
      class: "divergent_open",
      rootCause: ERROR_CLASS_META.divergent_open.rootCause,
      evidence: `provenance divergent=true source=${input.winningSource ?? "?"}`,
      fix: ERROR_CLASS_META.divergent_open.guard,
    };
  }

  const disagreements: string[] = [];
  for (const s of sources) {
    if (s.source === "factset") continue;
    if (materialVsGold(field, gold, s.value)) {
      disagreements.push(`${s.source}=${s.value.toPrecision(4)}`);
    }
  }
  if (disagreements.length > 0) {
    return {
      ...base,
      status: "flag",
      class: "vendor_disagreement",
      rootCause: ERROR_CLASS_META.vendor_disagreement.rootCause,
      evidence: disagreements.slice(0, 4).join("; "),
      fix: ERROR_CLASS_META.vendor_disagreement.guard,
    };
  }

  const freeQuotes: GoldQuote[] = sources
    .filter((s) => s.source !== "factset" && Number.isFinite(s.value))
    .map((s) => ({
      src: s.source,
      val: s.value,
      pulledAt: s.fetchedAt ? Date.parse(s.fetchedAt) : null,
    }));
  const fs = sources.find((s) => s.source === "factset")?.value;
  if (freeQuotes.length >= 2) {
    const picked = pickFieldGold({
      field,
      free: freeQuotes,
      factset: fs,
      existing: gold,
    });
    if (picked.source !== "none" && !picked.hold && Math.abs(picked.value - gold) / Math.max(Math.abs(gold), 1e-9) > 0.001) {
      return {
        ...base,
        status: "flag",
        class: "gold_picker_drift",
        rootCause: ERROR_CLASS_META.gold_picker_drift.rootCause,
        evidence: `pick=${picked.source}:${picked.value.toPrecision(6)} gold=${gold.toPrecision(6)}`,
        fix: ERROR_CLASS_META.gold_picker_drift.guard,
      };
    }
  }

  return base;
}

export function auditCell(input: AuditInput): AuditFinding[] {
  return [auditL0(input), auditL1(input)];
}

export function wilsonCi(successes: number, n: number, z = 1.96): { lo: number; hi: number; rate: number } {
  if (n <= 0) return { lo: 0, hi: 0, rate: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    rate: p,
    lo: Math.max(0, (center - margin) / denom),
    hi: Math.min(1, (center + margin) / denom),
  };
}
