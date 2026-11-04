/**
 * A329 Stock DB audit — L0 identities + L1 cross-source (pure; DB in script).
 * Reuses pickFieldGold / materiality band from merge-trusted (same as NR queue).
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
import { hasNegativeEquity } from "./negative-equity-policy.js";
import {
  missingL0Inputs,
  nonUsdSkipReason,
  shouldFlagPickerDrift,
  shouldFlagVendorGap,
  statementLevelSignIssue,
} from "./stock-db-audit-guards.js";
import {
  CAUSE_META,
  inferSpecCause,
  type SkipReason,
  type SpecCause,
} from "./stock-db-audit-l3.js";
import { inBand, pickFieldGold, type GoldQuote } from "./gold-pick.js";

export const SMOKE_TICKERS = [
  "AAPL", "BABA", "TSM", "TCOM", "KKR", "TKO", "C", "ASML", "RKT", "SKWD",
] as const;

/** A329 round 3 — leverage + returns segment (all filer types). */
export const SEGMENT_LEVERAGE_RETURNS_FIELDS = new Set([
  "debtToEquity",
  "returnOnEquity",
  "returnOnAssets",
  "grossMargin",
  "operatingMargin",
  "netMargin",
]);

/** A329 round 5 — statement $ levels (revenue, NI, equity, debt, cash, EBITDA, FCF). */
export const SEGMENT_STATEMENT_LEVELS_FIELDS = new Set([
  "totalRevenue",
  "netIncome",
  "totalStockholdersEquity",
  "totalDebt",
  "cashAndEquivalents",
  "ebitda",
  "freeCashFlow",
]);

/** A329 segment 3 — per-share metrics + share counts (SEC truth vs yahoo/FMP gold). */
export const SEGMENT_PER_SHARE_FIELDS = new Set([
  "earningsPerShare",
  "sharesOutstanding",
  "sharesOutstandingPrior",
  "tangibleBookValuePerShare",
]);

export type AuditLayer = "L0" | "L1";
export type RowStatus = "ok" | "flag" | "skip";

export type ErrorClass =
  | "identity_mismatch"
  | "vendor_disagreement"
  | "divergent_open"
  | "gold_picker_drift"
  | "unit_scale"
  | "share_mcap_mismatch"
  | "input_missing";

export type ClassMeta = {
  rootCause: string;
  guard: string;
  test: string;
};

/** L3 guard map — spec causes (class column) for recurring-bugs / Claude review. */
export const ERROR_CLASS_META = CAUSE_META;

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
  /** Spec L3 cause (stored in DB class column). */
  class: SpecCause | null;
  skipReason: SkipReason | null;
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

function finalizeFlag(
  base: AuditFinding,
  pipelineClass: ErrorClass,
  input: AuditInput,
  evidence: string,
): AuditFinding {
  const cause = inferSpecCause(pipelineClass, input, evidence);
  const meta = CAUSE_META[cause];
  return {
    ...base,
    status: "flag",
    class: cause,
    skipReason: null,
    rootCause: meta.rootCause,
    evidence,
    fix: meta.guard,
  };
}

function finalizeSkip(base: AuditFinding, reason: SkipReason, detail?: string): AuditFinding {
  return {
    ...base,
    status: "skip",
    skipReason: reason,
    evidence: detail ? `skipReason=${reason}; ${detail}` : `skipReason=${reason}`,
  };
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
    skipReason: null,
    rootCause: null,
    evidence: null,
    fix: null,
  };

  const nonUsd = nonUsdSkipReason(input.fund, field);
  if (nonUsd) {
    return finalizeSkip(base, "non_usd", nonUsd);
  }

  if (gold == null) return finalizeSkip(base, "gold_null");

  const stmtSign = statementLevelSignIssue(field, gold);
  if (stmtSign) {
    return finalizeFlag(base, "input_missing", input, stmtSign);
  }

  const bookEq = num(input.fund.totalStockholdersEquity);
  if (
    hasNegativeEquity(bookEq)
    && (field === "debtToEquity" || field === "returnOnEquity")
  ) {
    return finalizeFlag(
      base,
      "identity_mismatch",
      input,
      `negative_equity gold=${gold} equity=${bookEq}`,
    );
  }

  if (FRACTION_FIELDS.has(field) && Math.abs(gold) > 1.5 && field !== "debtToEquity") {
    return finalizeFlag(
      base,
      "unit_scale",
      input,
      `gold=${gold} looks like percent not fraction`,
    );
  }

  const missing = missingL0Inputs(field, input.fund, input.price);
  if (missing.length > 0 && l0Expected(field, input.fund, input.price) == null) {
    return finalizeFlag(base, "input_missing", input, `missing=${missing.join(",")}`);
  }

  const price = input.price;
  const sh = num(input.fund.sharesOutstanding);
  if (price != null && sh != null && sh > 0) {
    const mcapField = num(input.fund.marketCap as string | number | null | undefined);
    const implied = price * sh;
    if (mcapField != null && mcapField > 0 && relGap(mcapField, implied) > 0.25) {
      return finalizeFlag(
        base,
        "share_mcap_mismatch",
        input,
        `mcap=${mcapField.toExponential(3)} vs px×sh=${implied.toExponential(3)}`,
      );
    }
  }

  const expected = l0Expected(field, input.fund, price);
  if (expected == null) return finalizeSkip(base, "no_l0_identity");
  if (!inBand(field, expected, gold)) {
    return finalizeFlag(
      base,
      "identity_mismatch",
      input,
      `identity=${expected.toPrecision(6)} gold=${gold.toPrecision(6)}`,
    );
  }
  return { ...base, status: "ok", skipReason: null, evidence: null };
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
    skipReason: gold == null ? "gold_null" : null,
    rootCause: null,
    evidence: gold == null ? "skipReason=gold_null" : null,
    fix: null,
  };
  if (gold == null) return base;

  if (divergent) {
    return finalizeFlag(
      base,
      "divergent_open",
      input,
      `provenance divergent=true source=${input.winningSource ?? "?"}`,
    );
  }

  const disagreements: string[] = [];
  for (const s of sources) {
    if (s.source === "factset") continue;
    if (shouldFlagVendorGap(field, gold, s.value)) {
      disagreements.push(`${s.source}=${s.value.toPrecision(4)}`);
    }
  }
  if (disagreements.length > 0) {
    return finalizeFlag(
      base,
      "vendor_disagreement",
      input,
      disagreements.slice(0, 4).join("; "),
    );
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
    if (
      picked.source !== "none"
      && !picked.hold
      && shouldFlagPickerDrift(field, gold, picked.value)
    ) {
      return finalizeFlag(
        base,
        "gold_picker_drift",
        input,
        `pick=${picked.source}:${picked.value.toPrecision(6)} gold=${gold.toPrecision(6)}`,
      );
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

export type { SpecCause, SkipReason };
