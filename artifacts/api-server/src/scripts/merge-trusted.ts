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

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, sourceFundamentals, tickerFundamentals, tickerRegistry,
  fieldProvenance, manualOverrides, pricesHistorical,
  type ManualOverridesRow,
} from "@workspace/db";
import {
  computeTrailingPeg,
  computeForwardPeg,
  computeNetMargin,
  computeDebtToEquity,
  computePeFromPriceEps,
  computeForwardPeFromPriceEps,
  computePriceToBook,
  computeApproxRoic,
  computeOperatingMargin,
  computeReturnOnEquity,
  resolvePegGrowth,
} from "../lib/derived-metrics.js";

export { computeTrailingPeg as computeCanonicalPeg, computeForwardPeg } from "../lib/derived-metrics.js";

// ── Per-field source priority: [source, sf_field] pairs in priority order ────
// sf_field = the canonical field name as stored in source_fundamentals
// tf_col   = the ticker_fundamentals JS property to write

type SFPair = [source: string, sfField: string];
type FieldDef = { tfCol: string; priority: SFPair[] };

export const FIELD_DEFS: FieldDef[] = [
  // ── Valuation ratios ──────────────────────────────────────────────────────
  // factset is last-resort referee (null fill / divergence settle) — never ahead of free sources.
  { tfCol: "peRatio",            priority: [["yahoo","peRatio"],      ["finnhub","peRatio"],      ["fmp","peRatio"],      ["alpha_vantage","peRatio"], ["factset","peRatio"]] },
  { tfCol: "forwardPe",          priority: [["yahoo","forwardPe"],    ["fmp","forwardPe"],                               ["alpha_vantage","forwardPe"], ["factset","forwardPe"]] },
  // Vendor PEGs are NOT comparable (Yahoo≈5yr expected, FMP=own mix, Finnhub=forwardPEG).
  // Gold PEG is overwritten by computeTrailingPeg(pe, epsGrowth). Priority list only
  // seeds provenance display / rare fallback before that overwrite.
  { tfCol: "pegRatio",           priority: [["yahoo","pegRatio"],     ["fmp","pegRatio"],         ["alpha_vantage","pegRatio"], ["factset","pegRatio"]] },
  // Gold-only derived companion — never vendor-voted (see applyDerived in runMergeTrusted).
  { tfCol: "forwardPeg",         priority: [] },
  { tfCol: "evEbitda",           priority: [["yahoo","evEbitda"],     ["fmp","evEbitda"]] },
  { tfCol: "evRevenue",          priority: [["yahoo","evRevenue"],    ["fmp","evRevenue"]] },
  { tfCol: "priceToBook",        priority: [["yahoo","priceToBook"],  ["finnhub","priceToBook"], ["fmp","priceToBook"],  ["alpha_vantage","priceToBook"], ["factset","priceToBook"]] },
  { tfCol: "priceToSales",       priority: [["yahoo","priceToSales"], ["finnhub","psRatio"], ["fmp","priceToSales"]] },
  // Banks/insurers: P/TBV uses TBVPS from Finnhub (free) / FMP when available
  { tfCol: "tangibleBookValuePerShare", priority: [["finnhub","tangibleBookValuePerShare"], ["fmp","tangibleBookValuePerShare"]] },
  // REIT FFO proxy input — EDGAR D&A (free); ffoProxy derived in applyDerived
  { tfCol: "depreciationAmortization", priority: [["edgar","depreciationAmortization"]] },
  { tfCol: "ffoProxy",           priority: [] },

  // ── Margins & returns (TTM: yahoo → finnhub → fmp → av → factset) ─────────────
  { tfCol: "grossMargin",        priority: [["yahoo","grossMargin"],      ["finnhub","grossMargin"],      ["fmp","grossMargin"],      ["factset","grossMargin"]] },
  { tfCol: "operatingMargin",    priority: [["yahoo","operatingMargin"],  ["finnhub","operatingMargin"],  ["fmp","operatingMargin"],  ["alpha_vantage","operatingMargin"], ["factset","operatingMargin"]] },
  { tfCol: "netMargin",          priority: [["yahoo","netMargin"],        ["finnhub","netMargin"],        ["fmp","netMargin"],        ["alpha_vantage","netMargin"], ["factset","netMargin"]] },
  { tfCol: "returnOnEquity",     priority: [["yahoo","returnOnEquity"],   ["finnhub","returnOnEquity"],   ["fmp","returnOnEquity"],   ["alpha_vantage","returnOnEquity"], ["factset","returnOnEquity"]] },
  { tfCol: "returnOnAssets",     priority: [["yahoo","returnOnAssets"],   ["finnhub","returnOnAssets"],   ["fmp","returnOnAssets"], ["factset","returnOnAssets"]] },
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
  // Concept = "cash & short-term investments" (the UI's "Cash & ST Inv" label, and what
  // cashRunway needs — a company can liquidate ST investments to fund operations). Only
  // Yahoo's totalCash reports that; FMP/EDGAR report cash-ONLY (cashAndCashEquivalents),
  // which understates it, so they're excluded here rather than mixed in. Costs 6 tickers
  // their cash value (319/335 have Yahoo totalCash) — better than a wrong, mixed concept.
  // FactSet "Cash & ST Inv" matches Yahoo's concept — allowed as last-resort only.
  { tfCol: "cashAndEquivalents",      priority: [["yahoo","totalCash"], ["factset","totalCash"]] },
  // Concept = total debt (short + long term). Yahoo→FMP both report this; Polygon and
  // EDGAR are dropped — they produce unreliable values for this field (Polygon includes
  // bank deposits, e.g. GS=$1.68T; EDGAR often captures only long-term debt, e.g. MSFT=$43B).
  // The residual Yahoo-vs-FMP gap is genuine operating-lease inclusion — see DIVERGENCE_TOL.
  { tfCol: "totalDebt",               priority: [["yahoo","totalDebt"],            ["fmp","totalDebt"]] },
  { tfCol: "totalStockholdersEquity", priority: [["fmp","totalStockholdersEquity"], ["edgar","totalEquity"], ["factset","totalStockholdersEquity"]] },
  { tfCol: "sharesOutstanding",       priority: [["yahoo","sharesOutstanding"],    ["fmp","sharesOutstanding"],          ["edgar","sharesOutstanding"]] },
  { tfCol: "sharesOutstandingPrior",  priority: [["yahoo","sharesOutstandingPrior"], ["fmp","sharesOutstandingPrior"]] },
  { tfCol: "currentRatio",            priority: [["yahoo","currentRatio"],         ["finnhub","currentRatio"],           ["fmp","currentRatio"], ["factset","currentRatio"]] },

  // ── Income statement (absolute $) ─────────────────────────────────────────
  { tfCol: "totalRevenue",       priority: [["yahoo","annualTotalRevenue"], ["yahoo","totalRevenue"],    ["fmp","totalRevenue"],   ["alpha_vantage","totalRevenue"],  ["edgar","totalRevenue"], ["factset","totalRevenue"]] },
  { tfCol: "netIncome",          priority: [["yahoo","annualNetIncome"],    ["fmp","netIncome"],         ["edgar","netIncome"], ["factset","netIncome"]] },
  { tfCol: "ebitda",             priority: [["yahoo","ebitda"],             ["fmp","ebitda"],            ["alpha_vantage","ebitda"], ["edgar","ebitda"], ["factset","ebitda"]] },
  { tfCol: "ebit",               priority: [["yahoo","annualEbit"],         ["fmp","ebit"],              ["edgar","ebit"], ["factset","ebit"]] },
  { tfCol: "grossProfit",        priority: [["yahoo","annualGrossProfit"],  ["fmp","grossProfit"], ["edgar","grossProfit"]] },
  // totalAssets: Yahoo wide table has no totalAssets col; EDGAR gold map has none yet — FMP only until those land.
  { tfCol: "totalAssets",        priority: [["fmp","totalAssets"]] },
  { tfCol: "annualOperatingCashFlow", priority: [["yahoo","annualOperatingCashFlow"], ["fmp","annualOperatingCashFlow"]] },
  { tfCol: "interestExpense",    priority: [["yahoo","interestExpense"],    ["fmp","interestExpense"],   ["edgar","interestExpense"]] },
  { tfCol: "effectiveTaxRate",   priority: [["yahoo","effectiveTaxRate"], ["fmp","effectiveTaxRate"]] },
  { tfCol: "wacc",               priority: [["yahoo","wacc"],             ["fmp","wacc"]] },

  // ── Cash flow ─────────────────────────────────────────────────────────────
  { tfCol: "freeCashFlow",               priority: [["yahoo","freeCashFlow"],              ["yahoo","annualFreeCashFlow"], ["fmp","freeCashFlow"],   ["edgar","freeCashFlow"], ["factset","freeCashFlow"]] },
  // FMP "quarter" cash-flow endpoint returns YTD from 10-Q, not isolated quarter — Yahoo only.
  // FactSet NOCF allowed as last resort when Yahoo quarterly OCF is null.
  { tfCol: "quarterlyOperatingCashFlow", priority: [["yahoo","quarterlyOperatingCashFlow"], ["factset","quarterlyOperatingCashFlow"]] },

  // ── Market / other ────────────────────────────────────────────────────────
  { tfCol: "beta",               priority: [["yahoo","beta"],              ["finnhub","beta"],    ["fmp","beta"],              ["alpha_vantage","beta"]] },
  { tfCol: "dividendYield",      priority: [["yahoo","dividendYield"],     ["finnhub","dividendYield"], ["fmp","dividendYield"], ["alpha_vantage","dividendYield"]] },
  { tfCol: "analystTargetPrice", priority: [["yahoo","analystTargetPrice"],["fmp","analystTargetPrice"],                      ["alpha_vantage","analystTargetPrice"]] },
  { tfCol: "earningsPerShare",   priority: [["yahoo","trailingEps"],       ["finnhub","earningsPerShare"], ["fmp","earningsPerShare"], ["factset","earningsPerShare"]] },
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
// "Needs Review" should surface values that could be WRONG, not normal cross-vendor
// noise. Vendors legitimately differ by 10-25% on price ratios (different price
// snapshot), growth rates (different base period) and $ amounts (quarter timing) —
// that disagreement doesn't tell us either value is bad. What IS material: a sign
// flip (profit vs loss, growing vs shrinking), a scale/unit error (≥3x), or a gap
// beyond a field-class tolerance. Tolerances are deliberately generous for the
// noisiest classes so the queue stays small and actionable.
const DIVERGENCE_TOL: Record<string, number> = {
  // Growth rates — computed over different base periods everywhere; very noisy.
  epsGrowth: 0.50, revenueGrowthYoY: 0.50, revenueGrowthYoyPrior: 0.50, pegRatio: 0.40,
  // Price-based ratios — differ by price-snapshot + book/earnings period timing.
  peRatio: 0.25, forwardPe: 0.25, priceToBook: 0.25, priceToSales: 0.25,
  evEbitda: 0.25, evRevenue: 0.25, currentRatio: 0.25, beta: 0.35, dividendYield: 0.25,
  // Total debt — Yahoo vs FMP legitimately differ on operating-lease inclusion (ASC 842);
  // a lease-heavy company can show a 25-35% gap that isn't an error.
  totalDebt: 0.35,
};
const DEFAULT_DIVERGENCE_TOL = 0.20; // margins, returns, and absolute $ amounts

// Absolute floor for fraction-valued fields (margins, returns, yields, growth) — a
// gap this small is noise no matter how large it looks in relative terms (3% vs 4.5%
// ROA is a 50% relative gap but immaterial). For large $ fields the gap dwarfs the
// floor, so relative tolerance governs there. A gap must clear BOTH floors to flag.
const DIVERGENCE_ABS_FLOOR = 0.03;

function isMaterialDivergence(tf: string, a: number, b: number): boolean {
  const absA = Math.abs(a), absB = Math.abs(b);
  const maxAbs = Math.max(absA, absB), minAbs = Math.min(absA, absB);
  if (maxAbs < 0.02) return false;                          // both ~zero — nothing to compare
  if ((a > 0) !== (b > 0)) return true;                     // sign flip — always material
  if (minAbs > 0 && maxAbs / minAbs >= 3) return true;      // ≥3x — scale/unit error
  const absDiff = Math.abs(a - b);
  if (absDiff <= DIVERGENCE_ABS_FLOOR) return false;        // negligible in absolute terms
  const tol = DIVERGENCE_TOL[tf] ?? DEFAULT_DIVERGENCE_TOL;
  return absDiff / maxAbs > tol;
}

// ── Resolution result type ────────────────────────────────────────────────────

export type ResolveResult = {
  source: string;
  value: number;
  isOverride: boolean;
  divergent: boolean;
} | null;

// ── Internal: resolve from a pre-built index ──────────────────────────────────
// byField: sfField → source → value  (from source_fundamentals)
// override: manual_overrides row for this (ticker, field), if any

function resolveFromIndex(
  fieldDef: FieldDef,
  byField: Map<string, Map<string, number>>,
  override: ManualOverridesRow | undefined,
): ResolveResult {
  const { tfCol, priority } = fieldDef;
  const tf = tfCol as string;

  // Ordered (source → value) following priority; first sfField alias per source wins.
  const ordered: Array<{ src: string; val: number }> = [];
  const seenSrc = new Set<string>();
  for (const [src, sfField] of priority) {
    if (seenSrc.has(src)) continue;
    const val = byField.get(sfField)?.get(src);
    if (val !== undefined && isFinite(val)) { ordered.push({ src, val }); seenSrc.add(src); }
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

  // Override takes precedence over normal priority
  if (override) {
    // Literal value override (overrideSource = 'manual')
    if (override.overrideValue !== null) {
      const v = parseFloat(String(override.overrideValue));
      if (isFinite(v)) {
        return { source: override.overrideSource, value: v, isOverride: true, divergent };
      }
    }
    // Source-preference override: use best value from the specified source. Look up
    // directly by canonical field name rather than the priority-ordered map — an admin
    // can deliberately override to a source excluded from normal priority (e.g. one
    // excluded for a definitional mismatch that's since been fixed at the parser).
    // Falls back to the ordered map for sources whose sfField alias differs from tfCol.
    const srcVal = byField.get(tf)?.get(override.overrideSource) ?? orderedBySrc.get(override.overrideSource);
    if (srcVal !== undefined) {
      return { source: override.overrideSource, value: srcVal, isOverride: true, divergent };
    }
    // overrideSource has no data — fall through to normal priority
  }

  // FactSet referee: when free sources disagree, pick the free source closest to
  // FactSet (within REFEREE_MATCH_TOL). Provenance stays on that free source —
  // FactSet is the judge, not the default gold author. Only write winning_source=
  // factset when no free source is close enough (use FactSet's own value).
  const REFEREE_MATCH_TOL = 0.20; // 20% relative — settle to nearest free source
  const factsetVal = orderedBySrc.get("factset");
  if (divergent && factsetVal !== undefined) {
    let best: { src: string; val: number; dist: number } | null = null;
    for (const o of freeOrdered) {
      const dist = Math.abs(o.val - factsetVal) / Math.max(Math.abs(factsetVal), 1e-9);
      if (!best || dist < best.dist) best = { src: o.src, val: o.val, dist };
    }
    if (best && best.dist <= REFEREE_MATCH_TOL) {
      return { source: best.src, value: best.val, isOverride: false, divergent: false };
    }
    return { source: "factset", value: factsetVal, isOverride: false, divergent: false };
  }

  // Normal priority walk: first non-null source wins (FactSet last in FIELD_DEFS → null fill only)
  if (ordered.length > 0) {
    const winner = ordered[0];
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
  const regRows = await db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true));
  const trackedTickers = new Set(regRows.map(r => r.ticker));
  console.log(`Canonical universe: ${trackedTickers.size} tickers (fetch_fundamentals=true in ticker_registry)\n`);

  const [sfRows, overrideRows, existingRows] = await Promise.all([
    db.select().from(sourceFundamentals),
    db.select().from(manualOverrides),
    db.select().from(tickerFundamentals),
  ]);
  const existingMap = new Map(existingRows.map(r => [r.ticker, r as Record<string, unknown>]));

  // Treat a value as "changed" only past a small tolerance — avoids logging
  // noise from float round-tripping through numeric/string DB columns.
  function isChanged(oldVal: unknown, newVal: number): { changed: boolean; from: number | null } {
    if (oldVal == null) return { changed: true, from: null };
    const from = parseFloat(String(oldVal));
    if (!isFinite(from)) return { changed: true, from: null };
    return { changed: Math.abs(from - newVal) > Math.max(1e-6, Math.abs(from) * 0.0005), from };
  }
  const fmt = (n: number | null) => n == null ? "—" : Number(n.toFixed(4)).toString();

  // Index: ticker → sfField → source → value
  const index = new Map<string, Map<string, Map<string, number>>>();
  for (const row of sfRows) {
    if (!trackedTickers.has(row.ticker)) continue;
    const val = parseFloat(String(row.value));
    if (!isFinite(val)) continue;
    if (!index.has(row.ticker)) index.set(row.ticker, new Map());
    const byField = index.get(row.ticker)!;
    if (!byField.has(row.field)) byField.set(row.field, new Map());
    byField.get(row.field)!.set(row.source, val);
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
    for (const src of fwdEpsPrefer) {
      const v = bySrc.get(src);
      if (v != null && isFinite(v) && v > 0) {
        forwardEpsByTicker.set(ticker, v);
        break;
      }
    }
  }

  let totalTickersMerged = 0;
  let totalFieldsWritten = 0;
  const sourceUsage: Record<string, number> = {};
  const fieldNullCount: Record<string, number> = {};
  for (const { tfCol } of VALID_FIELD_DEFS) fieldNullCount[tfCol as string] = 0;

  const now = new Date();

  for (const ticker of allTickers) {
    const byField = index.get(ticker) ?? new Map();
    const update: Record<string, number> = {};
    const provenanceBatch: Array<{ field: string; result: Exclude<ResolveResult, null> }> = [];
    const tickerNullFields: string[] = [];
    const changedFields: Array<{ field: string; from: number | null; to: number }> = [];
    const existing = existingMap.get(ticker);

    for (const fieldDef of VALID_FIELD_DEFS) {
      // Empty priority = gold-only derived field (e.g. forwardPeg) — filled in applyDerived.
      if (fieldDef.priority.length === 0) continue;
      const override = overrideIndex.get(`${ticker}:${fieldDef.tfCol}`);
      const result = resolveFromIndex(fieldDef, byField, override);

      if (result) {
        update[fieldDef.tfCol as string] = result.value;
        sourceUsage[result.source] = (sourceUsage[result.source] ?? 0) + 1;
        provenanceBatch.push({ field: fieldDef.tfCol as string, result });

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
    fillIfMissing("peRatio", computePeFromPriceEps(price, update.earningsPerShare));
    fillIfMissing(
      "priceToBook",
      computePriceToBook(price, update.totalStockholdersEquity, update.sharesOutstanding),
    );
    // Forward P/E from consensus forward EPS when vendors omit the ratio.
    const forwardEps = forwardEpsByTicker.get(ticker) ?? null;
    fillIfMissing("forwardPe", computeForwardPeFromPriceEps(price, forwardEps));
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

    if (Object.keys(update).length === 0 && clearProvenanceFields.length === 0) continue;

    const divergentFields = provenanceBatch
      .filter(({ result }) => result.divergent)
      .map(({ field }) => field);
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
