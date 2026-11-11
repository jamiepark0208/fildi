/**
 * Merge fundamentals into ticker_fundamentals using per-field source priority.
 * Also writes field_provenance records and consults manual_overrides.
 *
 * Priority rules (first non-null source wins per field):
 *   Valuation ratios:   yahoo → finnhub → fmp
 *   Margins/returns:    yahoo → finnhub → fmp  (never edgar — period mismatch)
 *   Growth:             yahoo(revenueGrowth) → finnhub(revenueGrowth) → fmp(revenueGrowthYoY)
 *   debtToEquity:       yahoo → fmp  (never finnhub — different definition)
 *   Balance sheet:      yahoo → finnhub → edgar → fmp
 *   Income statement $: yahoo(annual) → fmp → edgar
 *   Cash flow:          yahoo → fmp → edgar
 *   Market/other:       yahoo → finnhub → fmp
 *
 * Existing ticker_fundamentals values are preserved when no source has data for that field.
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/merge-trusted.ts
 */

import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, sourceFundamentals, tickerFundamentals, tickerRegistry,
  fieldProvenance, manualOverrides, pricesHistorical,
  type ManualOverridesRow,
} from "@workspace/db";
import { pickFieldGold } from "../lib/gold-pick.js";
import { isMaterialDivergence } from "../lib/field-divergence.js";
import { isFactsetRulerField } from "../lib/factset-ruler-table.js";
import {
  computeTrailingPeg,
  computeForwardPeg,
  computeNetMargin,
  computeDebtToEquity,
  computePeFromPriceEps,
  computePriceToTbv,
  computeForwardPeFromPriceEps,
  computePriceToBook,
  computePriceToSales,
  computeEvRatio,
  computeApproxRoic,
  computeOperatingMargin,
  computeReturnOnEquity,
  resolvePegGrowth,
  shouldForceDerivedPriceRatio,
  isEvEbitdaGoldCandidate,
  skipDerivedEvRatios,
} from "../lib/derived-metrics.js";
import { applyNegativeEquityGoldPolicy, applyNegativeTbvGoldPolicy } from "../lib/negative-equity-policy.js";
import { applyStatementGoldPolicies } from "../lib/statement-gold-policy.js";
import { skipYahooZeroDividend } from "../lib/dividend-yield-merge.js";
import { parseYahooMostRecentQuarter, pickEarningsPerShareByPeriod } from "../lib/shares-gold-pick.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { computeTrailingPeg as computeCanonicalPeg, computeForwardPeg } from "../lib/derived-metrics.js";

// ── Per-field source priority: [source, sf_field] pairs in priority order ────
// sf_field = the canonical field name as stored in source_fundamentals
// tf_col   = the ticker_fundamentals JS property to write

type SFPair = [source: string, sfField: string];
type FieldDef = { tfCol: string; priority: SFPair[] };

const SEC_OWNED_TFCOLS = new Set(["sharesOutstanding", "sharesOutstandingPrior", "tangibleBookValuePerShare",
  "totalAssets"]);   // 11-11: AAPL fmp FY25 359 B outvoted SEC FY26 404 B on pull date

export const FIELD_DEFS: FieldDef[] = [
  // ── Valuation ratios ──────────────────────────────────────────────────────
  // factset is last-resort referee (null fill / divergence settle) — never ahead of free sources.
  { tfCol: "peRatio",            priority: [["yahoo","peRatio"],      ["finnhub","peRatio"],      ["fmp","peRatio"],      ["alpha_vantage","peRatio"], ["factset","peRatio"]] },
  { tfCol: "forwardPe",          priority: [["yahoo","forwardPe"],    ["finnhub","forwardPe"],    ["fmp","forwardPe"],    ["alpha_vantage","forwardPe"], ["factset","forwardPe"]] },
  // Vendor PEGs are NOT comparable (Yahoo≈5yr expected, FMP=own mix, Finnhub=forwardPEG).
  // Gold PEG is overwritten by computeTrailingPeg(pe, epsGrowth). Priority list only
  // seeds provenance display / rare fallback before that overwrite.
  { tfCol: "pegRatio",           priority: [["yahoo","pegRatio"],     ["fmp","pegRatio"],         ["alpha_vantage","pegRatio"], ["factset","pegRatio"]] },
  // Gold-only derived companion — never vendor-voted (see applyDerived in runMergeTrusted).
  { tfCol: "forwardPeg",         priority: [] },
  { tfCol: "evEbitda",           priority: [["yahoo","evEbitda"],     ["fmp","evEbitda"]] },
  { tfCol: "evRevenue",          priority: [["yahoo","evRevenue"],    ["fmp","evRevenue"]] },
  { tfCol: "priceToBook",        priority: [["sec","priceToBook"], ["yahoo","priceToBook"],  ["finnhub","priceToBook"], ["fmp","priceToBook"],  ["alpha_vantage","priceToBook"], ["factset","priceToBook"]] },
  { tfCol: "priceToSales",       priority: [["yahoo","priceToSales"], ["finnhub","psRatio"], ["fmp","priceToSales"]] },
  // 11-04 A329 seg3: sec = (common equity − preferred − goodwill − intangibles) / shares, one filing (sec_gold_fields.py).
  // Vendor TBVPS definitions diverge (PG vendor +14.0 vs SEC −3.5; SLB 14.1 vs 2.6) → fallback only where SEC has none.
  { tfCol: "tangibleBookValuePerShare", priority: [["sec","tangibleBookValuePerShare"], ["finnhub","tangibleBookValuePerShare"], ["fmp","tangibleBookValuePerShare"], ["factset","tangibleBookValuePerShare"]] },
  // A266 dropped fields — display / provenance. Not score weights.
  { tfCol: "pegTtm",             priority: [["finnhub","pegTtm"]] },
  { tfCol: "epsGrowth5Y",        priority: [["finnhub","epsGrowth5Y"]] },
  { tfCol: "revenueGrowth5Y",    priority: [["finnhub","revenueGrowth5Y"]] },
  { tfCol: "payoutRatio",        priority: [["fmp","payoutRatio"], ["finnhub","payoutRatio"]] },
  { tfCol: "interestCoverage",   priority: [["fmp","interestCoverage"], ["finnhub","interestCoverage"]] },
  { tfCol: "priceToFcf",         priority: [["fmp","priceToFcf"]] },
  { tfCol: "fcfYield",           priority: [["fmp","fcfYield"]] },
  { tfCol: "sbcToRevenue",       priority: [["fmp","sbcToRevenue"]] },
  { tfCol: "incomeQuality",      priority: [["fmp","incomeQuality"]] },
  { tfCol: "priceToTbv",         priority: [["finnhub","priceToTbv"]] },
  { tfCol: "tier1CapitalRatio",  priority: [["factset","tier1CapitalRatio"]] },
  { tfCol: "totalCapitalRatio",  priority: [["factset","totalCapitalRatio"]] },
  { tfCol: "rotce",              priority: [["factset","rotce"]] },
  { tfCol: "netInterestIncome",  priority: [["factset","netInterestIncome"]] },
  { tfCol: "totalDeposits",      priority: [["factset","totalDeposits"]] },
  // REIT FFO proxy input — EDGAR D&A (free); ffoProxy derived in applyDerived
  { tfCol: "depreciationAmortization", priority: [["edgar","depreciationAmortization"]] },
  { tfCol: "ffoProxy",           priority: [] },

  // ── Margins & returns (TTM: yahoo → finnhub → fmp → av → factset) ─────────────
  // A84: polygon last-resort = stored bronze only (fetch dead); fills when free sources null.
  { tfCol: "grossMargin",        priority: [["sec","grossMargin"],      ["yahoo","grossMargin"],      ["finnhub","grossMargin"],      ["fmp","grossMargin"],      ["factset","grossMargin"], ["polygon","grossMargin"]] },
  { tfCol: "operatingMargin",    priority: [["sec","operatingMargin"],  ["yahoo","operatingMargin"],  ["finnhub","operatingMargin"],  ["fmp","operatingMargin"],  ["alpha_vantage","operatingMargin"], ["factset","operatingMargin"], ["polygon","operatingMargin"]] },
  { tfCol: "netMargin",          priority: [["sec","netMargin"],        ["yahoo","netMargin"],        ["finnhub","netMargin"],        ["fmp","netMargin"],        ["alpha_vantage","netMargin"], ["factset","netMargin"]] },
  { tfCol: "returnOnEquity",     priority: [["yahoo","returnOnEquity"],   ["finnhub","returnOnEquity"],   ["fmp","returnOnEquity"],   ["alpha_vantage","returnOnEquity"], ["factset","returnOnEquity"]] },
  { tfCol: "returnOnAssets",     priority: [["sec","returnOnAssets"],   ["yahoo","returnOnAssets"],   ["finnhub","returnOnAssets"],   ["fmp","returnOnAssets"], ["factset","returnOnAssets"]] },
  { tfCol: "roic",               priority: [["yahoo","roic"],             ["finnhub","roic"],           ["fmp","roic"]] },

  // ── Growth ────────────────────────────────────────────────────────────────
  // Basis = annual YoY (matches the "YoY" name and the growth score's intent). Yahoo's
  // annualRevenueYoy equals FMP's revenueGrowthYoY exactly (same annual basis); Yahoo's
  // quarterly revenueGrowth (MRQ-YoY) and Finnhub's TTM-YoY answer different questions,
  // so they drop to last-resort for the ~4 tickers missing an annual figure.
  { tfCol: "revenueGrowthYoY",      priority: [["yahoo","annualRevenueYoy"], ["fmp","revenueGrowthYoY"],  ["finnhub","revenueGrowth"], ["yahoo","revenueGrowth"], ["factset","revenueGrowthYoY"]] },
  { tfCol: "revenueGrowthYoyPrior", priority: [["yahoo","revenueGrowthYoyPrior"], ["fmp","revenueGrowthYoyPrior"]] },
  // Yahoo epsGrowth is already annual and matches FMP; Finnhub is TTM (different basis),
  // so FMP is the fallback and Finnhub drops to last.
  { tfCol: "epsGrowth",             priority: [["yahoo","epsGrowth"],       ["fmp","epsGrowth"],          ["finnhub","epsGrowth"], ["factset","epsGrowth"]] },

  // ── debtToEquity: yahoo only → fmp fallback (never finnhub — different def) ─
  { tfCol: "debtToEquity",       priority: [["yahoo","debtToEquity"],  ["fmp","debtToEquity"], ["factset","debtToEquity"]] },

  // ── Balance sheet ─────────────────────────────────────────────────────────
  // EDGAR is last resort everywhere — it's annual 10-K data (lags), so it only wins a
  // field when every timelier source is null. It stays in the chain for completeness.
  // Concept = cash & short-term investments (net-debt / runway). SEC truth = CashAndCashEquivalents +
  // ShortTermInvestments / MarketableSecuritiesCurrent (see stock-db-audit-l2.py). Yahoo totalCash
  // and FactSet "Cash & ST Inv" match; FMP/EDGAR cash-only are excluded from the vote chain.
  { tfCol: "cashAndEquivalents",      priority: [["yahoo","totalCash"], ["factset","totalCash"]] },
  // Concept = total debt (short + long term). Yahoo→FMP both report this; Polygon and
  // EDGAR are dropped — they produce unreliable values for this field (Polygon includes
  // bank deposits, e.g. GS=$1.68T; EDGAR often captures only long-term debt, e.g. MSFT=$43B).
  // The residual Yahoo-vs-FMP gap is genuine operating-lease inclusion — see DIVERGENCE_TOL.
  { tfCol: "totalDebt",               priority: [["yahoo","totalDebt"],            ["fmp","totalDebt"]] },
  { tfCol: "totalStockholdersEquity", priority: [["fmp","totalStockholdersEquity"], ["yahoo","annualTotalEquity"], ["factset","totalStockholdersEquity"], ["edgar","totalEquity"], ["polygon","totalStockholdersEquity"]] },
  // Shares stay a reported count. Market cap / price is circular (the cap is shares × price) and is not a source.
  // 11-04: sec = latest filing cover (≤ 120 d old, class-summed, no ADRs); yahoo lagged buybacks (BAC +4.5 %, TMUS +4.5 %).
  { tfCol: "sharesOutstanding",       priority: [["sec","sharesOutstanding"], ["yahoo","sharesOutstanding"],    ["fmp","sharesOutstanding"],          ["edgar","sharesOutstanding"]] },
  // 11-05: sec = cover count ~1 y before the current cover (same definition → share change is real); vendors = prior-FY basic WA.
  { tfCol: "sharesOutstandingPrior",  priority: [["sec","sharesOutstandingPrior"], ["yahoo","sharesOutstandingPrior"], ["fmp","sharesOutstandingPrior"]] },
  { tfCol: "currentRatio",            priority: [["sec","currentRatio"],         ["yahoo","currentRatio"],         ["finnhub","currentRatio"],           ["fmp","currentRatio"], ["factset","currentRatio"]] },

  // ── Income statement (absolute $) ─────────────────────────────────────────
  { tfCol: "totalRevenue",       priority: [["sec","totalRevenue"], ["yahoo","annualTotalRevenue"], ["yahoo","totalRevenue"],    ["fmp","totalRevenue"],   ["alpha_vantage","totalRevenue"],  ["edgar","totalRevenue"], ["factset","totalRevenue"], ["polygon","totalRevenue"]] },
  { tfCol: "netIncome",          priority: [["sec","netIncome"],         ["yahoo","annualNetIncome"],    ["fmp","netIncome"],         ["edgar","netIncome"], ["factset","netIncome"], ["polygon","netIncome"]] },
  // Gold = GAAP operating income + D&A TTM (same as SEC audit truth); vendor adjusted EBITDA is not voted into gold.
  { tfCol: "ebitda",             priority: [["yahoo","ebitda"],             ["fmp","ebitda"],            ["alpha_vantage","ebitda"], ["edgar","ebitda"], ["factset","ebitda"]] },
  { tfCol: "ebit",               priority: [["yahoo","annualEbit"],         ["fmp","ebit"],              ["edgar","ebit"], ["factset","ebit"]] },
  { tfCol: "grossProfit",        priority: [["yahoo","annualGrossProfit"],  ["fmp","grossProfit"], ["edgar","grossProfit"]] },
  // totalAssets: Yahoo wide table has no totalAssets col. 11-11: SEC companyfacts 'Assets' (USD units only) first.
  { tfCol: "totalAssets",        priority: [["sec","totalAssets"], ["sec_local","totalAssets"], ["fmp","totalAssets"], ["factset","totalAssets"]] },
  { tfCol: "annualOperatingCashFlow", priority: [["yahoo","annualOperatingCashFlow"], ["fmp","annualOperatingCashFlow"], ["factset","annualOperatingCashFlow"]] },
  { tfCol: "interestExpense",    priority: [["yahoo","interestExpense"],    ["fmp","interestExpense"],   ["edgar","interestExpense"]] },
  { tfCol: "effectiveTaxRate",   priority: [["yahoo","effectiveTaxRate"], ["fmp","effectiveTaxRate"]] },
  { tfCol: "wacc",               priority: [["yahoo","wacc"],             ["fmp","wacc"]] },

  // ── Cash flow ─────────────────────────────────────────────────────────────
  { tfCol: "freeCashFlow",               priority: [["sec","freeCashFlow"], ["yahoo","freeCashFlow"],              ["yahoo","annualFreeCashFlow"], ["fmp","freeCashFlow"],   ["edgar","freeCashFlow"], ["factset","freeCashFlow"]] },
  // FMP "quarter" cash-flow endpoint returns YTD from 10-Q, not isolated quarter — Yahoo only.
  // FactSet NOCF allowed as last resort when Yahoo quarterly OCF is null.
  { tfCol: "quarterlyOperatingCashFlow", priority: [["yahoo","quarterlyOperatingCashFlow"]] },   // 11-11: factset's is annual

  // ── Market / other ────────────────────────────────────────────────────────
  { tfCol: "beta",               priority: [["yahoo","beta"],              ["finnhub","beta"],    ["fmp","beta"],              ["alpha_vantage","beta"]] },
  // A147: Yahoo 0 yield is often "unknown" for payers — skip when another free source > 0.5%.
  { tfCol: "dividendYield",      priority: [["yahoo","dividendYield"],     ["finnhub","dividendYield"], ["fmp","dividendYield"], ["alpha_vantage","dividendYield"]] },
  { tfCol: "analystTargetPrice", priority: [["yahoo","analystTargetPrice"],["fmp","analystTargetPrice"],                      ["alpha_vantage","analystTargetPrice"]] },
  { tfCol: "earningsPerShare",   priority: [["sec","earningsPerShare"], ["yahoo","trailingEps"],       ["finnhub","earningsPerShare"], ["fmp","earningsPerShare"], ["factset","earningsPerShare"]] },
];

export const VALID_FIELD_DEFS = FIELD_DEFS;

// ── Divergence comparison scope (period-aware) ───────────────────────────────
// A field only lands in the "Needs Review" queue when the value we CHOSE materially
// disagrees with its realistic fallback (the next period-comparable source), not
// when any two sources anywhere disagree. Two rules shape what's comparable:
//
//  DIVERGENCE_SKIP: never flag — sources use incompatible definitions.
//  PERIOD_SENSITIVE: EDGAR (annual 10-K) is excluded from the comparison for these
//    flow/margin/growth/income & cash-flow fields — it reports a different window
//    than the TTM/MRQ sources, so a gap is expected, not a data error. EDGAR still
//    stays in the value-priority chain as a last resort. Balance-sheet snapshots
//    (cash, debt, equity, shares, currentRatio) are point-in-time and remain
//    comparable to EDGAR.
//
// pegRatio is SKIPPED: Yahoo (5yr expected growth), FMP (own PE/growth mix),
// Finnhub (forwardPEG only), AV, and any FactSet-derived PEG are NOT the same
// metric. Comparing them invents fake Needs Review. Gold PEG is computed below
// from our gold peRatio + gold epsGrowth (same inputs the scorecard uses).
  // pegRatio/forwardPeg: incompatible vendor definitions — gold is derived.
  // beta: vendors use different lookbacks / adjustments — skip Needs Review noise.
  // epsGrowth / revenueGrowthYoY: vendors mix TTM vs FY vs quarterly annualized —
  // FactSet still settles gold via LTM when present; NR on growth is definition noise.
  const DIVERGENCE_SKIP_TFCOLS = new Set([
    "debtToEquity",
    "pegRatio",
    "forwardPeg",
    "beta",
    "epsGrowth",
    "revenueGrowthYoY",
    // ASC 842 / lease inclusion differs Yahoo vs FMP — not a FactSet-fixable error.
    "totalDebt",
  ]);
const PERIOD_SENSITIVE_TFCOLS = new Set([
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets", "roic",
  "revenueGrowthYoY", "revenueGrowthYoyPrior", "epsGrowth",
  "totalRevenue", "netIncome", "ebitda", "ebit", "interestExpense", "effectiveTaxRate", "earningsPerShare",
  "freeCashFlow", "quarterlyOperatingCashFlow",
]);

// ── Materiality: when is a winner-vs-fallback gap worth a human's attention? ──
// Tolerances live in field-divergence.ts (shared with A329 audit guards).

/**
 * Priority names the definition. When a later pull agrees with that definition,
 * the gold value and its age come from the later pull. A July EPS must not stay
 * gold in November just because Yahoo is first and Finnhub is within tolerance.
 * Disagreement stays on the priority source (growth basis, EDGAR period, FactSet).
 */
export function freshestAgreeing(
  tf: string,
  winner: { src: string; val: number },
  free: { src: string; val: number }[],
  pulled: Map<string, number>,
): { src: string; val: number } {
  const winnerT = pulled.get(winner.src);
  if (winnerT == null) return winner;
  let best = winner;
  let bestT = winnerT;
  for (const o of free) {
    if (o.src === best.src) continue;
    if (o.src === "factset" && !isFactsetRulerField(tf)) continue;
    if (o.src === "edgar" && PERIOD_SENSITIVE_TFCOLS.has(tf)) continue;
    const t = pulled.get(o.src);
    if (t == null || t <= bestT) continue;
    if (isMaterialDivergence(tf, winner.val, o.val)) continue;
    best = o;
    bestT = t;
  }
  return best;
}

// ── Resolution result type ────────────────────────────────────────────────────

export type ResolveResult = {
  source: string;
  value: number;
  isOverride: boolean;
  divergent: boolean;
  /** Keep the gold number already stored. Provenance stays; the cell is flagged. */
  hold?: boolean;
  /** Ruler field: FactSet out of band vs picked free gold (A318 review finding 3). */
  factsetDisagree?: { ruler: number; picked: number; bandRel: number; bandAbs: number };
} | null;

// ── Internal: resolve from a pre-built index ──────────────────────────────────
// byField: sfField → source → value  (from source_fundamentals)
// override: manual_overrides row for this (ticker, field), if any

function resolveFromIndex(
  fieldDef: FieldDef,
  byField: Map<string, Map<string, number>>,
  override: ManualOverridesRow | undefined,
  existingVal?: number | null,
  pulledByField?: Map<string, Map<string, number>>,
  priorWinningSource?: string | null,
  epsContext?: { yahooMrq: string | null; secPeriodEnd: string | null },
): ResolveResult {
  const { tfCol, priority } = fieldDef;
  const tf = tfCol as string;

  // Ordered (source → value) following priority; first sfField alias per source wins.
  const ordered: Array<{ src: string; val: number }> = [];
  const pulledForSrc = new Map<string, number>();
  const seenSrc = new Set<string>();
  for (const [src, sfField] of priority) {
    if (seenSrc.has(src)) continue;
    const val = byField.get(sfField)?.get(src);
    if (val === undefined || !isFinite(val)) continue;
    if (tf === "evEbitda" && !isEvEbitdaGoldCandidate(val)) continue;
    // EDGAR sometimes stores 0 shares. That is missing, not a count. A real
    // count from an older pull (Yahoo) has to be allowed to win.
    if ((tf === "sharesOutstanding" || tf === "sharesOutstandingPrior") && val <= 0) continue;
    if (skipYahooZeroDividend(tf, src, val, byField, priority)) continue;
    ordered.push({ src, val });
    const pull = pulledByField?.get(sfField)?.get(src);
    if (pull != null) pulledForSrc.set(src, pull);
    seenSrc.add(src);
  }
  const orderedBySrc = new Map(ordered.map(o => [o.src, o.val]));

  // Divergence = winner-vs-fallback among free sources (exclude factset from the
  // comparison pair — FactSet is the referee, not a peer that should create noise).
  let divergent = false;
  const freeOrdered = ordered.filter(o => o.src !== "factset");
  if (!DIVERGENCE_SKIP_TFCOLS.has(tf)) {
    const comparable = PERIOD_SENSITIVE_TFCOLS.has(tf)
      ? freeOrdered.filter(o => o.src !== "edgar")
      : freeOrdered;
    if (comparable.length >= 2) {
      divergent = isMaterialDivergence(tf, comparable[0].val, comparable[1].val);
    }
  }

  // Override takes precedence over normal priority. Once an admin/agent picks a source,
  // the cell leaves Needs Review (divergent cleared) even if free sources still disagree.
  if (override) {
    const overrideIsFactsetNonRuler =
      override.overrideSource === "factset" && !isFactsetRulerField(tf);
    if (!overrideIsFactsetNonRuler) {
    // Literal value override (overrideSource = 'manual')
    if (override.overrideValue !== null) {
      const v = parseFloat(String(override.overrideValue));
      if (isFinite(v)) {
        return { source: override.overrideSource, value: v, isOverride: true, divergent: false };
      }
    }
    // Source-preference override: use best value from the specified source. Look up
    // directly by canonical field name rather than the priority-ordered map — an admin
    // can deliberately override to a source excluded from normal priority (e.g. one
    // excluded for a definitional mismatch that's since been fixed at the parser).
    // Falls back to the ordered map for sources whose sfField alias differs from tfCol.
    const srcVal = byField.get(tf)?.get(override.overrideSource) ?? orderedBySrc.get(override.overrideSource);
    if (srcVal !== undefined) {
      return { source: override.overrideSource, value: srcVal, isOverride: true, divergent: false };
    }
    // overrideSource has no data — fall through to normal priority
    }
  }

  // A329 seg3 r5: SEC TTM EPS when its period end beats Yahoo MRQ; else Yahoo trailingEps.
  if (tf === "earningsPerShare" && ordered.length > 0) {
    const secEnd =
      epsContext?.secPeriodEnd ??
      (pulledForSrc.get("sec") != null
        ? new Date(pulledForSrc.get("sec")!).toISOString().slice(0, 10)
        : null);
    const picked = pickEarningsPerShareByPeriod(
      ordered,
      secEnd,
      epsContext?.yahooMrq ?? null,
    );
    if (picked) {
      return { source: picked.src, value: picked.val, isOverride: false, divergent: false };
    }
  }

  // 11-04 A329 seg3: these are defined by the filing (sec_gold_fields.py writes them only when fresh, same period).
  // A stale vendor cluster must not outvote it (BAC shares: yahoo+edgar 7.21 B vs 10-29 cover 6.90 B).
  const secOwned = SEC_OWNED_TFCOLS.has(tf) ? orderedBySrc.get("sec") : undefined;
  if (secOwned != null && Number.isFinite(secOwned)) {
    return { source: "sec", value: secOwned, isOverride: false, divergent: false };
  }

  // Disputed cells: FactSet rules only forwardPe, gross margin, current ratio,
  // equity, and price/book. Else an agreeing free cluster wins. FactSet is not
  // stored as gold when nothing cheap is close. No cluster → keep the stored
  // number and leave the cell in Needs Review.
  const factsetVal = orderedBySrc.get("factset");
  const factsetRedecide =
    priorWinningSource === "factset" &&
    !isFactsetRulerField(tf) &&
    freeOrdered.length > 0;
  if ((divergent || factsetRedecide) && freeOrdered.length > 0) {
    const picked = pickFieldGold({
      field: tf,
      free: freeOrdered.map((o) => ({
        src: o.src,
        val: o.val,
        pulledAt: pulledForSrc.get(o.src) ?? null,
      })),
      factset: factsetVal,
      existing: existingVal ?? null,
    });
    if (picked.source !== "none") {
      const out: Exclude<ResolveResult, null> = {
        source: picked.source,
        value: picked.value,
        isOverride: false,
        divergent: picked.divergent,
        hold: picked.hold,
      };
      if (picked.factsetDisagrees && picked.ruler != null && Number.isFinite(picked.ruler)) {
        out.factsetDisagree = {
          ruler: picked.ruler,
          picked: picked.value,
          bandRel: picked.bandRel ?? 0.2,
          bandAbs: picked.bandAbs ?? 0,
        };
      }
      return out;
    }
  }

  // Normal priority walk: first non-null source wins (FactSet last in FIELD_DEFS → null fill only)
  if (ordered.length > 0) {
    let winner = ordered[0]!;
    if (winner.src === "factset" && !isFactsetRulerField(tf)) {
      const alt = freeOrdered[0];
      if (alt) {
        winner = alt;
        if (!divergent && freeOrdered.length >= 2) {
          const comparable = PERIOD_SENSITIVE_TFCOLS.has(tf)
            ? freeOrdered.filter((o) => o.src !== "edgar")
            : freeOrdered;
          if (comparable.length >= 2) {
            divergent = isMaterialDivergence(tf, comparable[0]!.val, comparable[1]!.val);
          }
        }
        if (factsetRedecide || priorWinningSource === "factset") divergent = true;
      } else if (existingVal != null && Number.isFinite(existingVal)) {
        return {
          source: priorWinningSource ?? "none",
          value: existingVal,
          isOverride: false,
          divergent: true,
          hold: true,
        };
      }
    }
    winner = freshestAgreeing(tf, winner, freeOrdered, pulledForSrc);
    return { source: winner.src, value: winner.val, isOverride: false, divergent };
  }

  return null;
}

// ── Public: resolve a single (ticker, field) by querying DB ──────────────────
// Used by PUT/DELETE /api/fundamentals/override to re-resolve immediately.

export async function resolveField(ticker: string, field: string): Promise<ResolveResult> {
  const fieldDef = VALID_FIELD_DEFS.find(d => (d.tfCol as string) === field);
  if (!fieldDef) return null;

  const [sfRows, overrideRows] = await Promise.all([
    db.select().from(sourceFundamentals).where(eq(sourceFundamentals.ticker, ticker)),
    db.select().from(manualOverrides).where(
      and(eq(manualOverrides.ticker, ticker), eq(manualOverrides.field, field))
    ),
  ]);

  const byField = new Map<string, Map<string, number>>();
  for (const row of sfRows) {
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
  }

  return resolveFromIndex(fieldDef, byField, overrideRows[0]);
}

// ── Public: write a field_provenance record ───────────────────────────────────

export async function writeProvenance(
  ticker: string,
  field: string,
  result: ResolveResult,
  fetchedAt: Date,
): Promise<void> {
  if (!result) return;
  await db
    .insert(fieldProvenance)
    .values({
      ticker, field,
      winningSource: result.source,
      winningValue:  String(result.value),
      isOverride:    result.isOverride,
      divergent:     result.divergent,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [fieldProvenance.ticker, fieldProvenance.field],
      set: {
        winningSource: result.source,
        winningValue:  String(result.value),
        isOverride:    result.isOverride,
        divergent:     result.divergent,
        fetchedAt,
        updatedAt:     new Date(),
      },
    });
}

// ── Main batch runner ─────────────────────────────────────────────────────────

export async function runMergeTrusted() {
  const { ensureVendorRawSchema } = await import("../lib/vendor-raw.js");
  await ensureVendorRawSchema();
  const regRows = await db
    .select({
      ticker: tickerRegistry.ticker,
      sector: tickerRegistry.sector,
      peerGroupId: tickerRegistry.primaryPeerGroupId,
    })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true));
  const trackedTickers = new Set(regRows.map(r => r.ticker));
  const sectorByTicker = new Map(regRows.map((r) => [r.ticker, r.sector ?? null]));
  const peerGroupByTicker = new Map(regRows.map((r) => [r.ticker, r.peerGroupId ?? null]));
  console.log(`Canonical universe: ${trackedTickers.size} tickers (fetch_fundamentals=true in ticker_registry)\n`);

  const [sfRows, overrideRows, existingRows, provRows] = await Promise.all([
    db.select().from(sourceFundamentals),
    db.select().from(manualOverrides),
    db.select().from(tickerFundamentals),
    db.select({
      ticker: fieldProvenance.ticker,
      field: fieldProvenance.field,
      winningSource: fieldProvenance.winningSource,
    }).from(fieldProvenance),
  ]);
  const existingMap = new Map(existingRows.map(r => [r.ticker, r as Record<string, unknown>]));
  const priorWinMap = new Map(provRows.map((r) => [`${r.ticker}:${r.field}`, r.winningSource]));

  // A329 seg3 before/after capture: opt-in, not on every scheduled merge.
  if (process.env.A329_PRE_MERGE === "1") {
    const seg3PreMerge: Record<
      string,
      { earningsPerShare: number | null; sharesOutstanding: number | null; peRatio: number | null }
    > = {};
    for (const [ticker, ex] of existingMap) {
      seg3PreMerge[ticker] = {
        earningsPerShare:
          ex.earningsPerShare != null && ex.earningsPerShare !== ""
            ? Number(ex.earningsPerShare)
            : null,
        sharesOutstanding:
          ex.sharesOutstanding != null && ex.sharesOutstanding !== ""
            ? Number(ex.sharesOutstanding)
            : null,
        peRatio: ex.peRatio != null && ex.peRatio !== "" ? Number(ex.peRatio) : null,
      };
    }
    mkdirSync(join(dirname(fileURLToPath(import.meta.url)), "../../out/audit"), { recursive: true });
    writeFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../out/audit/a329-seg3-pre-merge.json"),
      JSON.stringify({ capturedAt: new Date().toISOString(), tickers: seg3PreMerge }, null, 2),
    );
  }

  // Treat a value as "changed" only past a small tolerance — avoids logging
  // noise from float round-tripping through numeric/string DB columns.
  function isChanged(oldVal: unknown, newVal: number): { changed: boolean; from: number | null } {
    if (oldVal == null) return { changed: true, from: null };
    const from = parseFloat(String(oldVal));
    if (!isFinite(from)) return { changed: true, from: null };
    return { changed: Math.abs(from - newVal) > Math.max(1e-6, Math.abs(from) * 0.0005), from };
  }
  const fmt = (n: number | null) => n == null ? "—" : Number(n.toFixed(4)).toString();

  // Index: ticker → sfField → source → value, plus pull time (not the statement period).
  const index = new Map<string, Map<string, Map<string, number>>>();
  const pulledIndex = new Map<string, Map<string, Map<string, number>>>();
  for (const row of sfRows) {
    if (!trackedTickers.has(row.ticker)) continue;
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
    const ms = row.fetchedAt ? new Date(row.fetchedAt).getTime() : NaN;
    if (Number.isFinite(ms)) {
      if (!pulledIndex.has(row.ticker)) pulledIndex.set(row.ticker, new Map());
      const byPull = pulledIndex.get(row.ticker)!;
      if (!byPull.has(row.field)) byPull.set(row.field, new Map());
      byPull.get(row.field)!.set(row.source, ms);
    }
  }

  // Override index: `${ticker}:${field}` → ManualOverridesRow
  const overrideIndex = new Map<string, ManualOverridesRow>();
  for (const row of overrideRows) {
    overrideIndex.set(`${row.ticker}:${row.field}`, row);
  }

  const allTickers = [...trackedTickers].sort();

  // Latest close per ticker — for PE / P/B fill-ins when vendors omit ratios.
  const priceByTicker = new Map<string, number>();
  if (allTickers.length > 0) {
    const priceRows = await db.execute(sql`
      SELECT DISTINCT ON (ticker) ticker, close
      FROM prices_historical
      WHERE ticker IN (${sql.join(
        allTickers.map((t) => sql`${t}`),
        sql`, `,
      )})
      ORDER BY ticker, date DESC
    `);
    for (const row of (priceRows as any).rows ?? (priceRows as any)) {
      const c = Number(row.close);
      if (row.ticker && isFinite(c) && c > 0) priceByTicker.set(String(row.ticker), c);
    }
  }

  // Consensus forward EPS (silver) — yahoo → fmp → finnhub → av for Fwd P/E + PEG growth.
  const forwardEpsByTicker = new Map<string, number>();
  const fwdEpsPrefer = ["yahoo", "fmp", "finnhub", "alpha_vantage"];
  for (const ticker of allTickers) {
    const bySrc = index.get(ticker)?.get("forwardEps");
    if (!bySrc) continue;
    // Newest positive pull, not Yahoo-first. A July Yahoo EPS must not beat a November Finnhub EPS.
    let best: { v: number; t: number } | null = null;
    for (const src of fwdEpsPrefer) {
      const v = bySrc.get(src);
      if (v == null || !isFinite(v) || v <= 0) continue;
      const t = pulledIndex.get(ticker)?.get("forwardEps")?.get(src) ?? 0;
      if (!best || t >= best.t) best = { v, t };
    }
    if (best) forwardEpsByTicker.set(ticker, best.v);
  }

  const financialCurrencyByTicker = new Map<string, string>();
  const yahooMrqByTicker = new Map<string, string>();
  if (allTickers.length > 0) {
    const CHUNK = 400;
    for (let i = 0; i < allTickers.length; i += CHUNK) {
      const slice = allTickers.slice(i, i + CHUNK);
      const curRows = await db.execute(sql`
        SELECT DISTINCT ON (upper(key)) upper(key) AS ticker,
          payload->'financialData'->>'financialCurrency' AS fc
        FROM vendor_raw
        WHERE source = 'yahoo'
          AND payload->'financialData'->>'financialCurrency' IS NOT NULL
          AND upper(key) IN (${sql.join(slice.map((t) => sql`${t}`), sql`, `)})
        ORDER BY upper(key), fetched_on DESC
      `);
      for (const row of (curRows as any).rows ?? (curRows as any)) {
        const t = String(row.ticker ?? "");
        const fc = row.fc != null ? String(row.fc) : "";
        if (t && fc) financialCurrencyByTicker.set(t, fc);
      }
      const mrqRows = await db.execute(sql`
        SELECT DISTINCT ON (upper(key)) upper(key) AS ticker,
          COALESCE(
            payload->'defaultKeyStatistics'->>'mostRecentQuarter',
            payload->'financialData'->>'mostRecentQuarter'
          ) AS mrq
        FROM vendor_raw
        WHERE source = 'yahoo'
          AND endpoint LIKE 'quoteSummary:%financialData%'
          AND upper(key) IN (${sql.join(slice.map((t) => sql`${t}`), sql`, `)})
          AND (
            (payload->'defaultKeyStatistics' ? 'mostRecentQuarter')
            OR (payload->'financialData' ? 'mostRecentQuarter')
          )
        ORDER BY upper(key), fetched_on DESC
      `);
      for (const row of (mrqRows as any).rows ?? (mrqRows as any)) {
        const t = String(row.ticker ?? "").toUpperCase();
        const mrq = parseYahooMostRecentQuarter(row.mrq != null ? String(row.mrq) : null);
        if (t && mrq) yahooMrqByTicker.set(t, mrq);
      }
    }
  }

  let totalTickersMerged = 0;
  let totalFieldsWritten = 0;
  const sourceUsage: Record<string, number> = {};
  const fieldNullCount: Record<string, number> = {};
  for (const { tfCol } of VALID_FIELD_DEFS) fieldNullCount[tfCol as string] = 0;

  const now = new Date();
  const factsetDisagreeLog: Array<{
    ticker: string;
    field: string;
    ruler: number;
    picked: number;
    bandRel: number;
    bandAbs: number;
  }> = [];

  const fxUsdPerUnit = await loadFxUsdPerUnit(new Set(financialCurrencyByTicker.values()));
  for (const ticker of allTickers) {
    const byField = index.get(ticker) ?? new Map();
    const update: Record<string, number> = {};
    const provenanceBatch: Array<{ field: string; result: Exclude<ResolveResult, null> }> = [];
    const tickerNullFields: string[] = [];
    const changedFields: Array<{ field: string; from: number | null; to: number }> = [];
    const holdFields: string[] = [];
    const existing = existingMap.get(ticker);

    for (const fieldDef of VALID_FIELD_DEFS) {
      // Empty priority = gold-only derived field (e.g. forwardPeg) — filled in applyDerived.
      if (fieldDef.priority.length === 0) continue;
      const override = overrideIndex.get(`${ticker}:${fieldDef.tfCol}`);
      const existingRaw = existing?.[fieldDef.tfCol as string];
      const existingVal = existingRaw != null && existingRaw !== "" ? Number(existingRaw) : null;
      const secPullMs = pulledIndex.get(ticker)?.get("earningsPerShare")?.get("sec");
      const secPeriodEnd =
        secPullMs != null && Number.isFinite(secPullMs)
          ? new Date(secPullMs).toISOString().slice(0, 10)
          : null;
      const result = resolveFromIndex(
        fieldDef,
        byField,
        override,
        existingVal != null && Number.isFinite(existingVal) ? existingVal : null,
        pulledIndex.get(ticker),
        priorWinMap.get(`${ticker}:${fieldDef.tfCol as string}`),
        {
          yahooMrq: yahooMrqByTicker.get(ticker) ?? null,
          secPeriodEnd,
        },
      );

      if (result?.hold) {
        if (existingVal != null && Number.isFinite(existingVal)) {
          update[fieldDef.tfCol as string] = existingVal;
        }
        holdFields.push(fieldDef.tfCol as string);
        continue;
      }

      if (result) {
        update[fieldDef.tfCol as string] = result.value;
        sourceUsage[result.source] = (sourceUsage[result.source] ?? 0) + 1;
        provenanceBatch.push({ field: fieldDef.tfCol as string, result });
        if (result.factsetDisagree) {
          factsetDisagreeLog.push({
            ticker,
            field: fieldDef.tfCol as string,
            ...result.factsetDisagree,
          });
        }

        const { changed, from } = isChanged(existing?.[fieldDef.tfCol as string], result.value);
        if (changed) changedFields.push({ field: fieldDef.tfCol as string, from, to: result.value });
      } else {
        fieldNullCount[fieldDef.tfCol as string]++;
        tickerNullFields.push(fieldDef.tfCol as string);
      }
    }

    // ── Owned derives (fill nulls + overwrite PEG/FwdPEG always) ─────────────
    const price = priceByTicker.get(ticker) ?? null;
    const fillIfMissing = (field: string, value: number | null) => {
      if (value == null) return;
      if (update[field] != null) return;
      update[field] = value;
      sourceUsage["derived"] = (sourceUsage["derived"] ?? 0) + 1;
      const prev = provenanceBatch.find((p) => p.field === field);
      const result = { source: "derived", value, isOverride: false, divergent: false };
      if (prev) prev.result = result;
      else provenanceBatch.push({ field, result });
      if (fieldNullCount[field] > 0) fieldNullCount[field]--;
      const from = existing?.[field] != null ? Number(existing[field]) : null;
      const { changed } = isChanged(from, value);
      if (changed) changedFields.push({ field, from, to: value });
    };

    fillIfMissing("netMargin", computeNetMargin(update.netIncome, update.totalRevenue));
    fillIfMissing("operatingMargin", computeOperatingMargin(update.ebit, update.totalRevenue));
    fillIfMissing(
      "returnOnEquity",
      computeReturnOnEquity(update.netIncome, update.totalStockholdersEquity),
    );
    fillIfMissing("debtToEquity", computeDebtToEquity(update.totalDebt, update.totalStockholdersEquity));
    // Price ratios always use the latest close and the gold level already picked.
    // A vendor P/E from July is not comparable with one from November.
    const financialCurrency = financialCurrencyByTicker.get(ticker);
    const skipEvDerive = skipDerivedEvRatios({
      sector: sectorByTicker.get(ticker),
      peerGroupId: peerGroupByTicker.get(ticker),
    });
    const vendorRatioAlternates = (tfCol: string): number[] => {
      const def = VALID_FIELD_DEFS.find((d) => (d.tfCol as string) === tfCol);
      if (!def) return [];
      const out: number[] = [];
      const seen = new Set<string>();
      for (const [src, sfField] of def.priority) {
        if (seen.has(src)) continue;
        seen.add(src);
        const v = byField.get(sfField)?.get(src);
        if (v != null && isFinite(v)) out.push(v);
      }
      return out;
    };
    const forceDerived = (field: string, value: number | null) => {
      if (skipEvDerive && (field === "evEbitda" || field === "evRevenue")) return;
      if ((field === "evEbitda" || field === "evRevenue") && value != null && value < 0) return;
      const vendorGold = update[field] ?? null;
      const alternates = vendorRatioAlternates(field).filter(
        (v) => vendorGold == null || Math.abs(v - vendorGold) > 1e-9,
      );
      let allowForce = shouldForceDerivedPriceRatio({
        financialCurrency,
        derived: value,
        vendorGold,
        vendorAlternates: alternates,
      });
      if (
        !allowForce &&
        field === "evEbitda" &&
        value != null &&
        isEvEbitdaGoldCandidate(value) &&
        vendorGold != null &&
        isFinite(vendorGold) &&
        !isEvEbitdaGoldCandidate(vendorGold)
      ) {
        allowForce = true;
      }
      if (!allowForce) {
        return;
      }
      if (overrideIndex.get(`${ticker}:${field}`)) return;
      const prior = provenanceBatch.find((p) => p.field === field);
      if (prior?.result.isOverride) return;
      if (value == null || !isFinite(value)) return;
      update[field] = value;
      sourceUsage["derived"] = (sourceUsage["derived"] ?? 0) + 1;
      const prev = provenanceBatch.find((p) => p.field === field);
      const result = { source: "derived", value, isOverride: false, divergent: false };
      if (prev) prev.result = result;
      else provenanceBatch.push({ field, result });
      const idx = changedFields.findIndex((c) => c.field === field);
      const from = existing?.[field] != null ? Number(existing[field]) : null;
      const { changed } = isChanged(from, value);
      if (changed) {
        if (idx >= 0) changedFields[idx] = { field, from, to: value };
        else changedFields.push({ field, from, to: value });
      } else if (idx >= 0) {
        changedFields.splice(idx, 1);
      }
    };
    for (const peCandidate of [
      computePeFromPriceEps(price, byField.get("earningsPerShare")?.get("factset") ?? null),
      computePeFromPriceEps(price, byField.get("trailingEps")?.get("yahoo") ?? null),
      computePeFromPriceEps(price, update.earningsPerShare),
    ]) {
      if (peCandidate == null) continue;
      forceDerived("peRatio", peCandidate);
      if (provenanceBatch.find((p) => p.field === "peRatio")?.result.source === "derived") break;
    }
    forceDerived(
      "priceToBook",
      computePriceToBook(price, update.totalStockholdersEquity, update.sharesOutstanding),
    );
    forceDerived(
      "priceToSales",
      computePriceToSales(price, update.totalRevenue, update.sharesOutstanding),
    );
    forceDerived(
      "priceToTbv",
      computePriceToTbv(price, update.tangibleBookValuePerShare),
    );
    const forwardEps = forwardEpsByTicker.get(ticker) ?? null;
    forceDerived("forwardPe", computeForwardPeFromPriceEps(price, forwardEps));
    forceDerived(
      "evEbitda",
      computeEvRatio(price, update.sharesOutstanding, update.totalDebt, update.cashAndEquivalents, update.ebitda),
    );
    forceDerived(
      "evRevenue",
      computeEvRatio(price, update.sharesOutstanding, update.totalDebt, update.cashAndEquivalents, update.totalRevenue),
    );
    {
      let evGold: number | null =
        update.evEbitda ??
        (existing?.evEbitda != null && existing.evEbitda !== ""
          ? Number(existing.evEbitda)
          : null);
      if (evGold != null && Number.isFinite(evGold) && !isEvEbitdaGoldCandidate(evGold)) {
        const derivedEv = skipEvDerive
          ? null
          : computeEvRatio(
              price,
              update.sharesOutstanding,
              update.totalDebt,
              update.cashAndEquivalents,
              update.ebitda,
            );
        if (derivedEv != null && isEvEbitdaGoldCandidate(derivedEv)) {
          update.evEbitda = derivedEv;
          sourceUsage["derived"] = (sourceUsage["derived"] ?? 0) + 1;
          const prev = provenanceBatch.find((p) => p.field === "evEbitda");
          const result = { source: "derived", value: derivedEv, isOverride: false, divergent: false };
          if (prev) prev.result = result;
          else provenanceBatch.push({ field: "evEbitda", result });
        } else {
          (update as Record<string, unknown>).evEbitda = null;
          const prev = provenanceBatch.find((p) => p.field === "evEbitda");
          const nr = { source: "none", value: evGold, isOverride: false, divergent: true };
          if (prev) prev.result = nr;
          else provenanceBatch.push({ field: "evEbitda", result: nr });
        }
      }
    }
    if (skipEvDerive) {
      for (const f of ["evEbitda", "evRevenue"] as const) {
        const pb = provenanceBatch.find((p) => p.field === f);
        if (pb?.result.source === "derived") {
          (update as Record<string, unknown>)[f] = null;
          pb.result = { source: "none", value: pb.result.value, isOverride: false, divergent: true };
        }
      }
    }
    // Gross profit only when the same source has both legs. Do not mix a Yahoo margin with an EDGAR revenue.
    if (update.grossProfit == null) {
      for (const src of ["yahoo", "finnhub", "fmp", "edgar"] as const) {
        const margin = byField.get("grossMargin")?.get(src);
        const rev = byField.get("totalRevenue")?.get(src) ?? byField.get("annualTotalRevenue")?.get(src);
        if (margin != null && rev != null && rev !== 0 && margin > -1 && margin < 2) {
          fillIfMissing("grossProfit", rev * margin);
          break;
        }
      }
    }
    fillIfMissing(
      "roic",
      computeApproxRoic({
        ebit: update.ebit,
        taxRate: update.effectiveTaxRate,
        totalDebt: update.totalDebt,
        equity: update.totalStockholdersEquity,
        cash: update.cashAndEquivalents,
      }),
    );

    // PEG / Fwd PEG: owned formula. Growth = trailing YoY if usable, else near-term
    // forward growth from forwardEps (closes coverage gap vs P/B which needs no growth).
    const pegGrowth = resolvePegGrowth({
      epsGrowth: update.epsGrowth,
      trailingEps: update.earningsPerShare,
      forwardEps,
    });
    const canonicalPeg = computeTrailingPeg(update.peRatio, pegGrowth);
    const canonicalFwdPeg = computeForwardPeg(update.forwardPe, pegGrowth);
    /** Provenance rows to DELETE when owned derive clears the gold cell. */
    const clearProvenanceFields: string[] = [];

    const applyDerived = (
      field: "pegRatio" | "forwardPeg" | "ffoProxy",
      value: number | null,
    ) => {
      const ci = changedFields.findIndex((c) => c.field === field);
      if (value != null) {
        const prev = provenanceBatch.find((p) => p.field === field);
        const from =
          existing?.[field] != null
            ? Number(existing[field])
            : (prev?.result.value ?? null);
        update[field] = value;
        sourceUsage["derived"] = (sourceUsage["derived"] ?? 0) + 1;
        const result = { source: "derived", value, isOverride: false, divergent: false };
        if (prev) prev.result = result;
        else {
          provenanceBatch.push({ field, result });
          if (fieldNullCount[field] > 0) fieldNullCount[field]--;
        }
        const { changed } = isChanged(from, value);
        if (changed) {
          if (ci >= 0) changedFields[ci] = { field, from, to: value };
          else changedFields.push({ field, from, to: value });
        } else if (ci >= 0) {
          // Drop vendor→junk log lines when final gold equals prior derived gold.
          changedFields.splice(ci, 1);
        }
      } else {
        delete update[field];
        (update as Record<string, number | null>)[field] = null;
        const pi = provenanceBatch.findIndex((p) => p.field === field);
        if (pi >= 0) provenanceBatch.splice(pi, 1);
        if (ci >= 0) changedFields.splice(ci, 1);
        clearProvenanceFields.push(field);
        if (existing?.[field] != null) {
          changedFields.push({
            field,
            from: Number(existing[field]),
            to: null as unknown as number,
          });
        }
        fieldNullCount[field] = (fieldNullCount[field] ?? 0) + 1;
      }
    };

    applyDerived("pegRatio", canonicalPeg);
    applyDerived("forwardPeg", canonicalFwdPeg);

    // FFO proxy (REIT / real-estate): NI + D&A. Gold-only derived — never vendor-voted.
    const niForFfo =
      update.netIncome != null
        ? Number(update.netIncome)
        : existing?.netIncome != null
          ? Number(existing.netIncome)
          : null;
    const daForFfo =
      update.depreciationAmortization != null
        ? Number(update.depreciationAmortization)
        : existing?.depreciationAmortization != null
          ? Number(existing.depreciationAmortization)
          : null;
    const ffoProxy =
      niForFfo != null && daForFfo != null && Number.isFinite(niForFfo + daForFfo)
        ? niForFfo + daForFfo
        : null;
    applyDerived("ffoProxy", ffoProxy);

    // 11-11: sec_local = filer's own currency; without a known non-USD reporting currency it can't be converted → drop + log
    if ((!financialCurrency || financialCurrency.toUpperCase() === "USD") && update.totalAssets != null
        && provenanceBatch.find((p) => p.field === "totalAssets")?.result.source === "sec_local") {
      delete update.totalAssets;
      const i = provenanceBatch.findIndex((p) => p.field === "totalAssets");
      if (i >= 0) provenanceBatch.splice(i, 1);
      logDataIssue("merge-trusted.ts", "non_usd_cleared", ticker, "totalAssets", `sec_local value but financialCurrency=${financialCurrency ?? "null"}`);
    }
    const { clearedNonUsd, nonUsdOutcomes } = applyStatementGoldPolicies({
      update,
      provenanceBatch,
      existing: existing as Record<string, unknown> | undefined,
      financialCurrency,
      // 11-11: convert local-currency absolutes at today's FX (factset USD fallback) instead of blanking them
      fx: { usdPerUnit: financialCurrency ? (fxUsdPerUnit.get(financialCurrency.toUpperCase()) ?? null) : null, bronze: byField },
    });
    // 11-11: EDGAR 20-F totalAssets is local currency (TSM 6.24T TWD) and is written outside this merge; with cash/debt now in
    // USD, netCash/assets would mix units → clear it for non-USD filers + log, until the EDGAR writer converts at write time.
    if (financialCurrency && financialCurrency.toUpperCase() !== "USD" && existing?.totalAssets != null
        && (update as Record<string, unknown>).totalAssets == null) {   // a USD-unit source (sec) this run wins
      (update as Record<string, number | null>).totalAssets = null;
      logDataIssue("merge-trusted.ts", "non_usd_cleared", ticker, "totalAssets",
        `existing ${existing.totalAssets} likely ${financialCurrency} (EDGAR 20-F) — convert in the EDGAR writer`);
    }
    for (const o of nonUsdOutcomes) {
      if (o.action === "cleared" || o.detail.includes("DIVERGENT")) {
        logDataIssue("merge-trusted.ts", o.action === "cleared" ? "non_usd_cleared" : "fx_divergent", ticker, o.field, o.detail);
      }
    }
    // A329: dropping the field from `update` left the old local-currency gold in the DB (TM TBVPS 2956 JPY) — write null.
    for (const field of clearedNonUsd) {
      (update as Record<string, number | null>)[field] = null;
      clearProvenanceFields.push(field);
      if (existing?.[field] != null) {
        changedFields.push({ field, from: Number(existing[field]), to: null as unknown as number });
      }
      fieldNullCount[field] = (fieldNullCount[field] ?? 0) + 1;
    }

    const negEquityClears = applyNegativeEquityGoldPolicy(
      update as Record<string, unknown>,
      provenanceBatch,
      existing as Record<string, unknown> | undefined,
    );
    for (const field of negEquityClears) {
      clearProvenanceFields.push(field);
      if (existing?.[field] != null) {
        changedFields.push({
          field,
          from: Number(existing[field]),
          to: null as unknown as number,
        });
      }
      fieldNullCount[field] = (fieldNullCount[field] ?? 0) + 1;
    }

    const negTbvClears = applyNegativeTbvGoldPolicy(
      update as Record<string, unknown>,
      provenanceBatch,
      existing as Record<string, unknown> | undefined,
    );
    for (const field of negTbvClears) {
      clearProvenanceFields.push(field);
      if (existing?.[field] != null) {
        changedFields.push({
          field,
          from: Number(existing[field]),
          to: null as unknown as number,
        });
      }
      fieldNullCount[field] = (fieldNullCount[field] ?? 0) + 1;
    }

    if (Object.keys(update).length === 0 && clearProvenanceFields.length === 0) continue;
    // 10-27: no vendor value at all and no gold data yet → don't create/stamp an empty "fetched" row (289 universe adds were
    // stamped at 11:34 with every field null, so enrich-missing-fundamentals skipped them for good).
    const hasGold = existing != null && (["totalRevenue", "peRatio", "sharesOutstanding", "netIncome"] as const)
      .some((k) => (existing as Record<string, unknown>)[k] != null);
    if (!hasGold && Object.values(update).every((v) => v == null)) continue;

    const divergentFields = [
      ...provenanceBatch.filter(({ result }) => result.divergent).map(({ field }) => field),
      ...holdFields,
    ];
    const discrepancyFlags = divergentFields.length > 0 ? divergentFields.join(",") : null;

    const overrideFieldsList = provenanceBatch
      .filter(({ result }) => result.isOverride)
      .map(({ field }) => field);
    const overrideFlags = overrideFieldsList.length > 0 ? overrideFieldsList.join(",") : null;

    await db
      .insert(tickerFundamentals)
      .values({ ticker, ...update, fundamentalsLastFetched: now, discrepancyFlags, overrideFlags } as any)
      .onConflictDoUpdate({ target: tickerFundamentals.ticker, set: { ...update, fundamentalsLastFetched: now, discrepancyFlags, overrideFlags } as any });

    if (provenanceBatch.length > 0) {
      await db
        .insert(fieldProvenance)
        .values(provenanceBatch.map(({ field, result }) => ({
          ticker, field,
          winningSource: result!.source,
          winningValue:  String(result!.value),
          isOverride:    result!.isOverride,
          divergent:     result!.divergent,
          fetchedAt:     now,
        })))
        .onConflictDoUpdate({
          target: [fieldProvenance.ticker, fieldProvenance.field],
          set: {
            winningSource: sql`excluded.winning_source`,
            winningValue:  sql`excluded.winning_value`,
            isOverride:    sql`excluded.is_override`,
            divergent:     sql`excluded.divergent`,
            fetchedAt:     sql`excluded.fetched_at`,
            updatedAt:     now,
          },
        });
    }

    if (holdFields.length > 0) {
      await db.execute(sql`
        UPDATE field_provenance
        SET divergent = true, updated_at = ${now}
        WHERE ticker = ${ticker}
          AND field IN (${sql.join(holdFields.map((f) => sql`${f}`), sql`, `)})
      `);
    }

    // Owned-null fields must not leave stale vendor provenance (audit honesty).
    if (clearProvenanceFields.length > 0) {
      await db.execute(sql`
        DELETE FROM field_provenance
        WHERE ticker = ${ticker}
          AND field IN (${sql.join(
            clearProvenanceFields.map((f) => sql`${f}`),
            sql`, `,
          )})
      `);
    }

    if (changedFields.length > 0) {
      const shown = changedFields.slice(0, 6).map(c => `${c.field} ${fmt(c.from)}→${fmt(c.to)}`).join(", ");
      const more  = changedFields.length > 6 ? ` (+${changedFields.length - 6} more)` : "";
      console.log(`[${ticker}] updated: ${shown}${more}`);
    }
    totalTickersMerged++;
    totalFieldsWritten += Object.keys(update).length;
  }

  // Vendor PEG fights are definition mismatches, not data errors — clear any leftover flags.
  await db.execute(sql`
    UPDATE field_provenance
    SET divergent = false, updated_at = ${now}
    WHERE field IN ('pegRatio', 'forwardPeg') AND divergent = true
  `);

  // Safety net: gold-null owned PEG must not keep a vendor winning_source.
  await db.execute(sql`
    DELETE FROM field_provenance fp
    USING ticker_fundamentals tf
    WHERE fp.ticker = tf.ticker
      AND (
        (fp.field = 'pegRatio' AND tf.peg_ratio IS NULL)
        OR (fp.field = 'forwardPeg' AND tf.forward_peg IS NULL)
      )
  `);

  const nullThreshold = Math.ceil(allTickers.length * 0.2);
  const highNullFields = Object.entries(fieldNullCount)
    .filter(([, n]) => n > nullThreshold)
    .sort(([, a], [, b]) => b - a)
    .map(([f, n]) => `${f}(${n}/${allTickers.length})`);

  const srcBreakdown = Object.entries(sourceUsage)
    .sort(([, a], [, b]) => b - a)
    .map(([s, n]) => `${s}=${n}`)
    .join("  ");

  console.log(`\nSummary:`);
  console.log(`  Total tickers merged:  ${totalTickersMerged}`);
  console.log(`  Total fields written:  ${totalFieldsWritten}`);
  console.log(`  Source usage breakdown: ${srcBreakdown}`);
  console.log(`  Fields null >20% of tickers: ${highNullFields.length > 0 ? highNullFields.join(", ") : "none"}`);

  if (factsetDisagreeLog.length > 0) {
    const byField: Record<string, number> = {};
    for (const row of factsetDisagreeLog) {
      byField[row.field] = (byField[row.field] ?? 0) + 1;
    }
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../out/a318-segment12");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "factset-disagrees.json"),
      JSON.stringify({ count: factsetDisagreeLog.length, byField, rows: factsetDisagreeLog }, null, 2) + "\n",
    );
    console.log(`  FactSet ruler disagrees (free cluster won): ${factsetDisagreeLog.length}`);
  }
}

// CLI entrypoint only — when imported (e.g. by nightly-enrichment in the long-lived
// api-server process) the caller awaits runMergeTrusted() directly; it must not
// call process.exit or it would kill the whole server.
const isMain = ["merge-trusted.ts", "merge-trusted.js", "merge-trusted.mjs"].some(s => process.argv[1]?.endsWith(s));
if (isMain) {
  runMergeTrusted()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Fatal:", err); process.exit(1); });
}


/** 11-11: USD per unit of each reporting currency (Yahoo <CCY>USD=X, 8 s deadline each), stored in fx_rates; on a failed
 *  fetch the last stored rate (≤ 10 days old) is used. Missing rate → the gold policy falls back to factset / clears + logs. */
async function loadFxUsdPerUnit(ccys: Set<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fx_rates (ccy text NOT NULL, d date NOT NULL, usd_per_unit double precision NOT NULL,
    source text NOT NULL DEFAULT 'yahoo', fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ccy, d))`);
  for (const raw of ccys) {
    const ccy = raw.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy) || ccy === "USD") continue;
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ccy}USD=X?range=5d&interval=1d`, {
        headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      const j: any = r.ok ? await r.json() : null;
      const px = Number(j?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (Number.isFinite(px) && px > 0) {
        out.set(ccy, px);
        await db.execute(sql`INSERT INTO fx_rates (ccy, d, usd_per_unit) VALUES (${ccy}, CURRENT_DATE, ${px})
          ON CONFLICT (ccy, d) DO UPDATE SET usd_per_unit = EXCLUDED.usd_per_unit, fetched_at = now()`);
        continue;
      }
    } catch { /* fall through to stored */ }
    const prev: any = await db.execute(sql`SELECT usd_per_unit FROM fx_rates WHERE ccy = ${ccy} AND d >= CURRENT_DATE - 10
      ORDER BY d DESC LIMIT 1`);
    const v = Number(((prev as any).rows ?? prev)?.[0]?.usd_per_unit);
    if (Number.isFinite(v) && v > 0) out.set(ccy, v);
    else logDataIssue("merge-trusted.ts", "fx_missing", null, ccy, "no Yahoo FX rate and none stored in 10 d");
  }
  return out;
}

/** Same JSONL as scripts/watchlist_sync/data_issues.py → agent_start 11a digest (never throws). */
function logDataIssue(producer: string, kind: string, ticker: string | null, field: string | null, detail: string): void {
  try {
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../scripts/watchlist_sync/out/issues");
    fs.mkdirSync(dir, { recursive: true });
    const row = { at: new Date().toISOString().slice(0, 19), producer, kind, ticker, field, value: null, detail: detail.slice(0, 400) };
    fs.appendFileSync(path.join(dir, `${new Date().toLocaleDateString("en-CA")}.jsonl`), JSON.stringify(row) + "\n");
  } catch { /* logging must not become the failure */ }
}
