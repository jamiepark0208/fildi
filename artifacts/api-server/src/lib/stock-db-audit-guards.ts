/**
 * A329 — guards referenced from audit findings (file:line in fix column).
 * Each function is a regression-tested gate the audit uses before flagging.
 */
import { isMaterialDivergence } from "./field-divergence.js";

/** L1: only surface vendor gaps that would open Needs Review (merge-trusted band). */
export function shouldFlagVendorGap(field: string, gold: number, srcVal: number): boolean {
  return isMaterialDivergence(field, gold, srcVal);
}

/** L1: picker replay drift must clear materiality, not float noise. */
export function shouldFlagPickerDrift(field: string, gold: number, picked: number): boolean {
  return isMaterialDivergence(field, gold, picked);
}

const L0_PRIMITIVE: Record<string, string[]> = {
  peRatio: ["earningsPerShare"],
  forwardPe: ["forwardEps"],
  priceToBook: ["totalStockholdersEquity", "sharesOutstanding"],
  priceToSales: ["totalRevenue", "sharesOutstanding"],
  netMargin: ["netIncome", "totalRevenue"],
  operatingMargin: ["ebit", "totalRevenue"],
  pegRatio: ["peRatio", "epsGrowth"],
  forwardPeg: ["forwardPe", "epsGrowth"],
  debtToEquity: ["totalDebt", "totalStockholdersEquity"],
  returnOnEquity: ["netIncome", "totalStockholdersEquity"],
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** L0: gold present but identity inputs missing → auditable finding (not silent skip). */
export function missingL0Inputs(
  field: string,
  fund: Record<string, unknown>,
  price: number | null,
): string[] {
  const need = L0_PRIMITIVE[field];
  if (!need) return [];
  const missing: string[] = [];
  for (const k of need) {
    if (num(fund[k]) == null) missing.push(k);
  }
  if ((field === "peRatio" || field === "forwardPe" || field === "priceToBook" || field === "priceToSales") && price == null) {
    missing.push("price");
  }
  return missing;
}

/** L0: non-USD reporters — absolute $ fields need currency guard (FMP reportedCurrency when present). */
export function nonUsdSkipReason(fund: Record<string, unknown>, field: string): string | null {
  const cur = String(fund.reportedCurrency ?? fund.currency ?? "USD").toUpperCase();
  if (cur === "USD" || cur === "") return null;
  const absFields = new Set([
    "totalRevenue", "netIncome", "ebitda", "ebit", "totalDebt", "cashAndEquivalents",
    "freeCashFlow", "quarterlyOperatingCashFlow", "marketCap",
  ]);
  if (absFields.has(field)) return `non_usd:${cur}`;
  return null;
}
