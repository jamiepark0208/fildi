import { StockMetrics } from "@workspace/api-client-react";
import {
  safeDiv, normalize, MIN_SECTOR_N,
  cashRunway, dilutionRate, interestCoverage, approxWACC, roicWaccSpread,
  MAX_CASH_RUNWAY_QUARTERS, percentileRank,
} from "./rankings-helpers.js";

export type MetricDef = {
  key: string;
  label: string;
  weight: number;
  higherIsBetter: boolean;
  getValue: (s: StockMetrics) => number | null | undefined;
};

export const SCORECARD_METRICS: MetricDef[] = [
  { key: "peg",      label: "PEG Ratio",              weight: 3.0, higherIsBetter: false, getValue: s => s.pegRatio },
  { key: "pfcf",     label: "Price / FCF",             weight: 3.0, higherIsBetter: false, getValue: s => (s.marketCap && s.freeCashFlow && s.freeCashFlow > 0) ? s.marketCap / s.freeCashFlow : null },
  { key: "upside",   label: "Analyst Upside",          weight: 2.5, higherIsBetter: true,  getValue: s => (s.analystTargetPrice && s.currentPrice) ? (s.analystTargetPrice / s.currentPrice) - 1 : null },
  { key: "pe",       label: "P/E Ratio",               weight: 2.0, higherIsBetter: false, getValue: s => (s.peRatio != null && s.peRatio > 0) ? s.peRatio : null },
  { key: "revgrow",  label: "Revenue Growth",          weight: 2.5, higherIsBetter: true,  getValue: s => s.revenueGrowthYoY },
  { key: "epsgrow",  label: "EPS Growth",              weight: 2.5, higherIsBetter: true,  getValue: s => s.epsGrowth },
  { key: "netmgn",   label: "Net Margin",              weight: 2.0, higherIsBetter: true,  getValue: s => s.netMargin },
  { key: "roe",      label: "Return on Equity",        weight: 2.0, higherIsBetter: true,  getValue: s => s.returnOnEquity },
  { key: "fcf",      label: "Free Cash Flow",          weight: 2.0, higherIsBetter: true,  getValue: s => s.freeCashFlow },
  { key: "grossmgn", label: "Gross Margin",            weight: 1.5, higherIsBetter: true,  getValue: s => s.grossMargin },
  { key: "de",       label: "Debt / Equity",           weight: 1.5, higherIsBetter: false, getValue: s => s.debtToEquity },
  { key: "cr",       label: "Current Ratio",           weight: 1.0, higherIsBetter: true,  getValue: s => s.currentRatio },
];

export type FamilyName = "value" | "growth" | "quality" | "safety";

export type StockScore = {
  ticker: string;
  companyName: string;
  totalScore: number;
  maxPossible: number;
  rank: number;
  metricScores: Record<string, { value: number | null; weightedScore: number; rank: number }>;
  reason: string;
  // V2 optional extras — undefined when produced by the old computeRankings
  familyScores?: Record<FamilyName, { score: number; coverage: number; lowCoverage: boolean }>;
  dataQuality?: "good" | "partial" | "insufficient";
  gateStatus?: "ok" | "flagged";
  suspectMetrics?: string[];
  // Debug/display fields: FMP discrepancy flags and WACC computation inputs
  dataSourceFlags?: string[];
  waccInputs?: { beta: number | null; approxWacc: number | null };
  // Peer group context — present when peerGroupMap was passed to computeRankingsV2
  peerGroupId?: string;
  peerGroupConfidence?: 'mapped' | 'auto' | 'unmapped';
};

export function computeRankings(stocks: StockMetrics[]): StockScore[] {
  if (stocks.length === 0) return [];

  const metricScores: Record<string, number[]> = {};

  // For each metric, rank all stocks and assign 0–1 scores
  for (const metric of SCORECARD_METRICS) {
    const values = stocks.map(s => metric.getValue(s));
    const nonNull = values
      .map((v, i) => ({ v: v!, i }))
      .filter(x => x.v !== null && x.v !== undefined && isFinite(x.v));

    nonNull.sort((a, b) => metric.higherIsBetter ? b.v - a.v : a.v - b.v);

    const scores = new Array(stocks.length).fill(0);
    nonNull.forEach((item, rankIdx) => {
      scores[item.i] = nonNull.length > 1 ? (nonNull.length - 1 - rankIdx) / (nonNull.length - 1) : 1;
    });
    metricScores[metric.key] = scores;
  }

  // Compute total weighted scores
  const totals = stocks.map((_, i) =>
    SCORECARD_METRICS.reduce((sum, m) => sum + (metricScores[m.key][i] ?? 0) * m.weight, 0)
  );
  const maxPossible = SCORECARD_METRICS.reduce((s, m) => s + m.weight, 0);

  // Sort by score descending to assign ranks
  const ranked = totals
    .map((score, i) => ({ i, score }))
    .sort((a, b) => b.score - a.score);

  return ranked.map((r, rankIdx) => {
    const s = stocks[r.i];
    const ms: StockScore["metricScores"] = {};
    const normForStock: Record<string, number> = {};
    for (const m of SCORECARD_METRICS) {
      const norm = metricScores[m.key][r.i] ?? 0;
      normForStock[m.key] = norm;
      ms[m.key] = {
        value: m.getValue(s) ?? null,
        weightedScore: norm * m.weight,
        rank: [...metricScores[m.key]].sort((a, b) => b - a).indexOf(metricScores[m.key][r.i]) + 1,
      };
    }

    const sortedByNorm = SCORECARD_METRICS
      .map(m => ({ label: m.label, norm: normForStock[m.key] }))
      .sort((a, b) => b.norm - a.norm);
    const top = sortedByNorm.slice(0, 2).filter(m => m.norm >= 0.6).map(m => m.label);
    const weak = sortedByNorm.slice(-2).filter(m => m.norm <= 0.25).map(m => m.label);

    let reason: string;
    const parts: string[] = [];
    if (top.length > 0) parts.push(`Leads: ${top.join(" & ")}`);
    if (weak.length > 0) parts.push(`Lags: ${weak.join(" & ")}`);
    reason = parts.join(" · ") || (rankIdx === 0 ? "Tops peers on aggregate fundamentals" : "Competitive across most metrics");

    return {
      ticker: s.ticker,
      companyName: s.companyName,
      totalScore: parseFloat(r.score.toFixed(2)),
      maxPossible,
      rank: rankIdx + 1,
      metricScores: ms,
      reason,
    };
  });
}

// ─── V2 Types ────────────────────────────────────────────────────────────────

export type FamilyPreset = Record<FamilyName, number>;

export const FAMILY_PRESETS: Record<string, FamilyPreset> = {
  // Weights sum to 100 — maxPossible is always 100
  PUT_SELLER: { value: 20, growth: 25, quality: 35, safety: 20 },
  GROWTH:     { value: 15, growth: 45, quality: 25, safety: 15 },
};

// Regime-aware presets — selected at score time based on market_regime DB value.
// Weights sum to 100 per row.
export const REGIME_PRESETS: Record<string, FamilyPreset> = {
  expansion:   { value: 15, growth: 35, quality: 30, safety: 20 },
  late_cycle:  { value: 20, growth: 20, quality: 35, safety: 25 },
  contraction: { value: 20, growth: 15, quality: 35, safety: 30 },
  recession:   { value: 15, growth: 10, quality: 30, safety: 45 },
  recovery:    { value: 15, growth: 35, quality: 30, safety: 20 },
  stagflation: { value: 25, growth: 10, quality: 35, safety: 30 },
};

export type MetricDefV2 = {
  key: string;
  label: string;
  family: FamilyName;
  intraWeight: number; // relative weight within the family (renormalized over available metrics)
  higherIsBetter: boolean;
  getValue: (s: StockMetrics) => number | null | undefined;
};

// Tickers where ROIC/WACC framework doesn't apply (regulated financial capital structure).
// HOOD: broker-dealer; SOFI: bank holding company with SoFi Bank N.A. charter — deposits
// appear as "debt", ROIC/WACC on a loan book vs. deposit funding is not meaningful.
const FINANCIAL_TICKERS = new Set(["HOOD", "SOFI"]);

// ─── V2 Metrics ──────────────────────────────────────────────────────────────

export const SCORECARD_METRICS_V2: MetricDefV2[] = [
  // VALUE — yield-based, handle negatives naturally; PEG clamped for meaningless cases
  { key: "earningsYield", label: "Earnings Yield",   family: "value",   intraWeight: 3, higherIsBetter: true,
    getValue: s => safeDiv(s.netIncome, s.marketCap) },
  { key: "fcfYield",      label: "FCF Yield",         family: "value",   intraWeight: 3, higherIsBetter: true,
    getValue: s => safeDiv(s.freeCashFlow, s.marketCap) },
  { key: "ps",            label: "Price / Sales",     family: "value",   intraWeight: 1.5, higherIsBetter: false,
    getValue: s => (s.totalRevenue != null && s.totalRevenue <= 0) ? null : safeDiv(s.marketCap, s.totalRevenue) },
  { key: "peg",           label: "PEG Ratio",         family: "value",   intraWeight: 2, higherIsBetter: false,
    // Clamp to null for negative earnings or non-positive growth — negative PEG is misleading
    getValue: s => (s.epsGrowth != null && s.epsGrowth <= 0) || (s.netIncome != null && s.netIncome < 0)
      ? null : s.pegRatio },
  { key: "fwdpe",   label: "Forward P/E",     family: "value",   intraWeight: 2, higherIsBetter: false,
    getValue: s => (s.netIncome != null && s.netIncome < 0) ? null : (s.forwardPe ?? null) },
  { key: "evEbitda", label: "EV/EBITDA",      family: "value",   intraWeight: 2, higherIsBetter: false,
    getValue: s => (s.ebitda != null && s.ebitda < 0) ? null : (s.evEbitda ?? null) },
  { key: "evRev",    label: "EV/Revenue",     family: "value",   intraWeight: 1, higherIsBetter: false,
    getValue: s => (s.totalRevenue != null && s.totalRevenue <= 0) ? null : (s.evRevenue ?? null) },
  { key: "pb",       label: "Price / Book",   family: "value",   intraWeight: 1, higherIsBetter: false,
    getValue: s => (s.totalStockholdersEquity != null && s.totalStockholdersEquity < 0) ? null : (s.priceToBook ?? null) },
  { key: "divy",     label: "Dividend Yield", family: "value",   intraWeight: 1, higherIsBetter: true,
    getValue: s => s.dividendYield ?? null },
  // FCF yield minus risk-free rate (SOFR). getValue returns raw FCF yield; computeRankingsV2
  // subtracts riskFreeRate after extraction and nulls the column when riskFreeRate is absent.
  { key: "fcfYieldSpread", label: "FCF Yield−SOFR", family: "value", intraWeight: 2, higherIsBetter: true,
    getValue: s => safeDiv(s.freeCashFlow, s.marketCap) },

  // GROWTH
  { key: "revgrow",  label: "Revenue Growth",     family: "growth", intraWeight: 3, higherIsBetter: true,  getValue: s => s.revenueGrowthYoY },
  { key: "revaccel", label: "Revenue Accel",       family: "growth", intraWeight: 2, higherIsBetter: true,
    getValue: s => (s.revenueGrowthYoY != null && s.revenueGrowthYoyPrior != null)
      ? s.revenueGrowthYoY - s.revenueGrowthYoyPrior : null },
  { key: "epsgrow",  label: "EPS Growth",          family: "growth", intraWeight: 3, higherIsBetter: true,  getValue: s => s.epsGrowth },
  { key: "upside",   label: "Analyst Upside", family: "growth", intraWeight: 1, higherIsBetter: true,
    getValue: s => (s.analystTargetPrice && s.currentPrice) ? (s.analystTargetPrice / s.currentPrice) - 1 : null },

  // QUALITY — every name is scored here; unprofitable names cannot dodge the penalty
  { key: "grossmgn",    label: "Gross Margin",     family: "quality", intraWeight: 2, higherIsBetter: true, getValue: s => s.grossMargin },
  { key: "operatingmgn",label: "Operating Margin", family: "quality", intraWeight: 2, higherIsBetter: true, getValue: s => s.operatingMargin },
  { key: "netmgn",      label: "Net Margin",       family: "quality", intraWeight: 3, higherIsBetter: true,
    // Recompute from raw inputs to fix Yahoo's 0.00% floor bug on deeply unprofitable names (e.g. POET)
    getValue: s => {
      const computed = safeDiv(s.netIncome, s.totalRevenue);
      if (computed !== null) return computed;
      return s.netMargin ?? null;
    } },
  { key: "roe",    label: "Return on Equity", family: "quality", intraWeight: 2, higherIsBetter: true, getValue: s => s.returnOnEquity },
  { key: "fcfmgn", label: "FCF Margin",       family: "quality", intraWeight: 2, higherIsBetter: true,
    getValue: s => safeDiv(s.freeCashFlow, s.totalRevenue) },
  // ROIC minus approxWACC: positive = value creation. Financial companies excluded (capital
  // structure works differently — ROIC/WACC framework doesn't translate to broker/bank models).
  { key: "roicwacc", label: "ROIC−WACC", family: "quality", intraWeight: 1.5, higherIsBetter: true,
    getValue: s => {
      if (FINANCIAL_TICKERS.has(s.ticker)) return null;
      if (s.roic == null) return null;
      // Prefer DB-stored FMP WACC; fall back to approximation if not yet populated
      const wacc = s.wacc ?? approxWACC({
        beta: s.beta,
        totalDebt: s.totalDebt,
        totalStockholdersEquity: s.totalStockholdersEquity,
        effectiveTaxRate: s.effectiveTaxRate,
        interestExpense: s.interestExpense,
      });
      return roicWaccSpread(s.roic, wacc);
    } },

  // SAFETY — weights: cashRunway 30%, interestCoverage 25%, dilutionRate 20%, CR 15%, D/E 10%
  // Intra-weights sum to 10 so percentages read directly (3/10 = 30%, etc.)
  { key: "cashrun", label: "Cash Runway",       family: "safety", intraWeight: 3,   higherIsBetter: true,
    getValue: s => {
      const raw = cashRunway(s.cashAndEquivalents, s.quarterlyOperatingCashFlow);
      // Infinity = cash-generative; normalize() filters via isFinite() which would score these as null
      // (same as missing data). Cap at MAX_CASH_RUNWAY_QUARTERS so they score as best-in-class.
      if (raw === Infinity) return MAX_CASH_RUNWAY_QUARTERS;
      return raw;
    } },
  { key: "intcov",  label: "Interest Coverage", family: "safety", intraWeight: 2.5, higherIsBetter: true,
    // ebit and interestExpense are both FMP-sourced (income-statement endpoint), so this is
    // equivalent to FMP's pre-computed interestCoverageRatio with our own null/cap handling.
    getValue: s => interestCoverage(s.ebit, s.interestExpense) },
  { key: "dilution",label: "Dilution Rate",     family: "safety", intraWeight: 2,   higherIsBetter: false,
    getValue: s => dilutionRate(s.sharesOutstanding, s.sharesOutstandingPrior) },
  { key: "cr",      label: "Current Ratio",     family: "safety", intraWeight: 1.5, higherIsBetter: true,  getValue: s => s.currentRatio },
  { key: "de",      label: "Debt / Equity",     family: "safety", intraWeight: 1,   higherIsBetter: false, getValue: s => s.debtToEquity },
  // Null when EBITDA <= 0 — negative EBITDA inverts direction (distressed looks low-leverage).
  // Negative net debt (cash > debt) scores best naturally — correct signal, keep in pool.
  { key: "netDebtEbitda", label: "Net Debt/EBITDA", family: "safety", intraWeight: 2, higherIsBetter: false,
    getValue: s => (s.ebitda != null && s.ebitda <= 0) ? null
      : safeDiv((s.totalDebt ?? 0) - (s.cashAndEquivalents ?? 0), s.ebitda) },
];

// ─── computeRankingsV2 ───────────────────────────────────────────────────────

const FAMILIES: FamilyName[] = ["value", "growth", "quality", "safety"];

// Thresholds for flagging suspect data (decimal units: 1.0 = 100%)
const SUSPECT = { marginAbs: 1.0, growthAbs: 10.0 } as const;

export function computeRankingsV2(
  stocks: StockMetrics[],
  preset: FamilyPreset = FAMILY_PRESETS.PUT_SELLER,
  intraWeightOverrides?: Record<string, number>,
  peerGroupMap: Record<string, { groupId: string; confidence: 'mapped' | 'auto' | 'unmapped'; metricExclusions?: string[] }> = {},
  regime?: string,
  riskFreeRate?: number | null,
): StockScore[] {
  if (stocks.length === 0) return [];

  // Regime overrides the explicit preset when a recognized regime string is provided
  const activePreset = (regime && REGIME_PRESETS[regime]) ? REGIME_PRESETS[regime] : preset;

  const intraW = (m: MetricDefV2) => intraWeightOverrides?.[m.key] ?? m.intraWeight;

  const familyMetrics = Object.fromEntries(
    FAMILIES.map(fam => [fam, SCORECARD_METRICS_V2.filter(m => m.family === fam)]),
  ) as Record<FamilyName, MetricDefV2[]>;

  const stockGroupKeys = stocks.map(s =>
    peerGroupMap[s.ticker.toUpperCase()]?.groupId ?? "__global__"
  );

  // ── Raw values ──────────────────────────────────────────────────────────────
  const rawValues: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    rawValues[m.key] = stocks.map(s => {
      const v = m.getValue(s);
      return v == null || !isFinite(v) ? null : v;
    });
  });

  // ── Structural nulls (direction-inversion cases + group metric exclusions) ────
  stocks.forEach((s, i) => {
    // Apply group-level metric exclusions from scoring_mode
    const excl = peerGroupMap[s.ticker.toUpperCase()]?.metricExclusions ?? [];
    excl.forEach(key => { if (key in rawValues) rawValues[key][i] = null; });

    // pe_ratio: negative P/E means unprofitable — inverts the "lower is cheaper" direction
    if (s.netIncome != null && s.netIncome < 0 && "pe_ratio" in rawValues) rawValues["pe_ratio"][i] = null;
    // earningsYield: negative scores low naturally — correct signal, keep in pool

    // peg: mathematically undefined when earnings or growth are negative
    if (((s.netIncome != null && s.netIncome < 0) ||
        (s.epsGrowth != null && s.epsGrowth <= 0)) && "peg" in rawValues)
      rawValues["peg"][i] = null;

    // fwdpe: same direction-inversion rule as trailing pe
    if (s.netIncome != null && s.netIncome < 0 && "fwdpe" in rawValues) rawValues["fwdpe"][i] = null;

    // fcfYieldSpread: subtract risk-free rate from raw FCF yield; null when rate unavailable
    if (riskFreeRate == null) {
      rawValues["fcfYieldSpread"][i] = null;
    } else if (rawValues["fcfYieldSpread"][i] !== null) {
      rawValues["fcfYieldSpread"][i] = (rawValues["fcfYieldSpread"][i] as number) - riskFreeRate;
    }

    // netDebtEbitda: null when EBITDA <= 0 (direction inverts with negative EBITDA)
    if (s.ebitda != null && s.ebitda <= 0) rawValues["netDebtEbitda"][i] = null;

    // evEbitda: negative EBITDA makes the ratio meaningless (distressed companies look cheap)
    if (s.ebitda != null && s.ebitda < 0) rawValues["evEbitda"][i] = null;

    // evRev: non-positive revenue makes EV/Revenue undefined
    if (s.totalRevenue != null && s.totalRevenue <= 0) rawValues["evRev"][i] = null;

    // pb: negative book value inverts direction (deeply indebted companies look cheap)
    if (s.totalStockholdersEquity != null && s.totalStockholdersEquity < 0) rawValues["pb"][i] = null;

    // roe: directionally broken when equity is negative but company is profitable
    if (s.totalStockholdersEquity != null && s.totalStockholdersEquity < 0 &&
        s.netIncome != null && s.netIncome > 0)
      rawValues["roe"][i] = null;
  });

  // ── Suspect detection (data-sanity) ─────────────────────────────────────────
  const suspectSets: Set<string>[] = stocks.map(() => new Set<string>());
  stocks.forEach((s, i) => {
    const nm = rawValues["netmgn"][i];
    if (nm !== null && Math.abs(nm) > SUSPECT.marginAbs) suspectSets[i].add("netmgn");
    const rg = rawValues["revgrow"][i];
    if (rg !== null && Math.abs(rg) > SUSPECT.growthAbs) suspectSets[i].add("revgrow");
    const eg = rawValues["epsgrow"][i];
    if (eg !== null && Math.abs(eg) > SUSPECT.growthAbs) suspectSets[i].add("epsgrow");
    // When |netIncome| > |totalRevenue|, both derived metrics are suspect
    if (s.netIncome != null && s.totalRevenue != null && s.totalRevenue !== 0 &&
        Math.abs(s.netIncome) > Math.abs(s.totalRevenue)) {
      suspectSets[i].add("earningsYield");
      suspectSets[i].add("netmgn");
    }
  });

  // ── Normalize each metric within its group ───────────────────────────────────
  const normScores: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    const raw = rawValues[m.key];
    const result: (number | null)[] = new Array(stocks.length).fill(null);

    // Collect index lists per group
    const groups = new Map<string, number[]>();
    stockGroupKeys.forEach((gk, i) => {
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(i);
    });

    groups.forEach((idxs) => {
      const groupVals = idxs.map(i => raw[i]);
      const groupNorm = normalize(groupVals, { higherIsBetter: m.higherIsBetter });
      idxs.forEach((stockIdx, j) => { result[stockIdx] = groupNorm[j]; });
    });

    normScores[m.key] = result;
  });

  // ── Base-effect growth guard (Fix 2) ─────────────────────────────────────────
  // Pre-revenue companies can show >500% growth from a tiny base — not genuine scale.
  // If totalRevenue < $100M AND revgrow > 500%, score revgrow at neutral 0.5 (neither
  // rewarded nor penalized). Other suspect flags are display-only; only this guard
  // overrides the score. Does NOT touch epsGrowth or any other metric.
  const TINY_REV = 100_000_000;
  const BASE_GROWTH_CAP = 5.0; // 500% in decimal
  stocks.forEach((s, i) => {
    const rg = rawValues["revgrow"][i];
    if (s.totalRevenue != null && s.totalRevenue < TINY_REV &&
        rg != null && rg > BASE_GROWTH_CAP) {
      normScores["revgrow"][i] = 0.5;
      suspectSets[i].add("revgrow"); // ensure flagged for display
    }
  });

  // ── Per-metric rank from raw values (unaffected by scoring overrides above) ──
  // Rank badges in the breakdown table reflect actual metric values, not adjusted scores.
  const metricRanks: Record<string, number[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    const raw = rawValues[m.key];
    const sorted = raw
      .map((v, i) => ({ v, i }))
      .filter(x => x.v !== null)
      .sort((a, b) => m.higherIsBetter
        ? (b.v as number) - (a.v as number)
        : (a.v as number) - (b.v as number));
    const ranks = new Array(stocks.length).fill(0);
    sorted.forEach(({ i }, ri) => { ranks[i] = ri + 1; });
    metricRanks[m.key] = ranks;
  });

  // ── Family scores per stock ──────────────────────────────────────────────────
  type FamilyEntry = { score: number; coverage: number; lowCoverage: boolean };
  const familyScoreGrid: Record<FamilyName, FamilyEntry>[] = stocks.map(() => ({
    value:   { score: 0.5, coverage: 0, lowCoverage: true },
    growth:  { score: 0.5, coverage: 0, lowCoverage: true },
    quality: { score: 0.5, coverage: 0, lowCoverage: true },
    safety:  { score: 0.5, coverage: 0, lowCoverage: true },
  }));

  stocks.forEach((_, si) => {
    FAMILIES.forEach(fam => {
      const metrics = familyMetrics[fam];
      const available = metrics.filter(m => normScores[m.key][si] !== null);
      const coverage = available.length / metrics.length;

      if (available.length === 0) {
        // No data in this family → neutral 0.5 (stock neither rewarded nor penalised)
        familyScoreGrid[si][fam] = { score: 0.5, coverage: 0, lowCoverage: true };
      } else {
        // Renormalize intraWeights over available metrics only (structural nulls excluded)
        const totalIntra = available.reduce((s, m) => s + intraW(m), 0);
        const score = available.reduce((acc, m) =>
          acc + (normScores[m.key][si] as number) * (intraW(m) / totalIntra), 0);
        familyScoreGrid[si][fam] = { score, coverage, lowCoverage: coverage < 0.6 };
      }
    });
  });

  // ── Total scores (maxPossible = 100, constant across all stocks) ─────────────
  const maxPossible = 100;
  const totals = stocks.map((_, si) =>
    FAMILIES.reduce((sum, fam) => sum + familyScoreGrid[si][fam].score * activePreset[fam], 0),
  );

  const ranked = totals.map((score, i) => ({ i, score })).sort((a, b) => b.score - a.score);

  // ── Build output StockScore[] ────────────────────────────────────────────────
  return ranked.map(({ i: si }, rankIdx) => {
    const s = stocks[si];
    const fsg = familyScoreGrid[si];

    const ms: StockScore["metricScores"] = {};
    SCORECARD_METRICS_V2.forEach(m => {
      const norm = normScores[m.key][si];
      const availableInFamily = familyMetrics[m.family].filter(fm => normScores[fm.key][si] !== null);
      const totalIntra = availableInFamily.reduce((acc, fm) => acc + intraW(fm), 0);
      const weightedScore = (norm !== null && totalIntra > 0)
        ? (norm * intraW(m) / totalIntra) * activePreset[m.family]
        : 0;
      ms[m.key] = {
        value: rawValues[m.key][si],
        weightedScore: parseFloat(weightedScore.toFixed(3)),
        rank: metricRanks[m.key][si] || 0,
      };
    });

    const overallCoverage = FAMILIES.reduce((s, fam) => s + fsg[fam].coverage, 0) / FAMILIES.length;
    const dataQuality: StockScore["dataQuality"] =
      overallCoverage >= 0.75 ? "good" : overallCoverage >= 0.4 ? "partial" : "insufficient";

    const gateStatus: StockScore["gateStatus"] = "ok";

    const famsByScore = FAMILIES
      .map(fam => ({ fam, score: fsg[fam].score }))
      .sort((a, b) => b.score - a.score);
    const leading = famsByScore
      .filter(f => f.score >= 0.65).slice(0, 2)
      .map(f => f.fam.charAt(0).toUpperCase() + f.fam.slice(1));
    const lagging = famsByScore
      .filter(f => f.score <= 0.35)
      .map(f => f.fam.charAt(0).toUpperCase() + f.fam.slice(1));
    const parts: string[] = [];
    if (leading.length) parts.push(`Leads: ${leading.join(" & ")}`);
    if (lagging.length) parts.push(`Lags: ${lagging.join(" & ")}`);
    const reason = parts.join(" · ") ||
      (rankIdx === 0 ? "Tops peers across all four factors" : "Competitive across factors");

    return {
      ticker: s.ticker,
      companyName: s.companyName,
      totalScore: parseFloat(totals[si].toFixed(2)),
      maxPossible,
      rank: rankIdx + 1,
      metricScores: ms,
      reason,
      familyScores: fsg,
      dataQuality,
      gateStatus,
      suspectMetrics: [...suspectSets[si]],
      // Pass through FMP triangulation discrepancy flags for display/debugging
      dataSourceFlags: s.discrepancyFlags?.filter(Boolean) ?? [],
      // WACC inputs for tickers where roicWaccSpread was computable (not guarded, roic non-null)
      waccInputs: (!FINANCIAL_TICKERS.has(s.ticker) && s.roic != null)
        ? {
            beta: s.beta ?? null,
            approxWacc: approxWACC({
              beta: s.beta,
              totalDebt: s.totalDebt,
              totalStockholdersEquity: s.totalStockholdersEquity,
              effectiveTaxRate: s.effectiveTaxRate,
              interestExpense: s.interestExpense,
            }),
          }
        : undefined,
      peerGroupId: peerGroupMap[s.ticker.toUpperCase()]?.groupId,
      peerGroupConfidence: peerGroupMap[s.ticker.toUpperCase()]?.confidence,
    };
  });
}

// ─── computeRankingsV3 ───────────────────────────────────────────────────────
// Like V2, but each metric's 0-1 score is derived from the ticker's own
// multi-year history when >= 3 data points exist.  Falls back to V2's
// cross-peer normalization when history is absent or too short.
//
// history shape: { [ticker]: { [metricKey]: number[] } }
// The caller populates this from ticker_fundamentals_history via
// StockDataManager.getMetricHistory().  Rankings.ts stays DB-free.
//
// HISTORY_MIN_N = 3: minimum years of history to use own-history scoring.
const HISTORY_MIN_N = 3;

// Maps MetricDefV2 keys to the equivalent ticker_fundamentals_history column.
// Keys absent from this map always fall back to peer normalization.
const METRIC_TO_HISTORY_KEY: Partial<Record<string, string>> = {
  netmgn:      "net_margin",
  grossmgn:    "gross_margin",
  operatingmgn:"operating_margin",
  revgrow:     "rev_growth",   // populated when caller provides it
  epsgrow:     "eps",          // use EPS series as proxy for EPS growth history
  earningsYield: "eps",        // same underlying series
  fcfYield:    "eps",          // no direct FCF history column yet
  fcfmgn:      "net_margin",   // fallback until FCF history exists
  roe:         "roic",         // closest available column
  roicwacc:    "roic",
  peg:         "pe_ratio",
  cr:          undefined,      // no history column
  de:          undefined,
  cashrun:     undefined,
  intcov:      undefined,
  dilution:    undefined,
  upside:      undefined,
};

export type TickerHistory = Record<string, number[]>; // metricKey → values
export type AllTickerHistory = Record<string, TickerHistory>; // ticker → TickerHistory

function ownHistoryScore(
  value: number | null,
  history: number[] | undefined,
  higherIsBetter: boolean,
): number | null {
  if (value == null || !isFinite(value)) return null;
  if (!history || history.length < HISTORY_MIN_N) return null;
  // percentileRank with minN=1 — we've already enforced HISTORY_MIN_N above
  const pct = percentileRank(value, history, 1);
  if (pct === null) return null;
  return higherIsBetter ? pct : 1 - pct;
}

export function computeRankingsV3(
  stocks: StockMetrics[],
  history: AllTickerHistory = {},
  preset: FamilyPreset = FAMILY_PRESETS.PUT_SELLER,
): StockScore[] {
  if (stocks.length === 0) return [];

  const familyMetrics = Object.fromEntries(
    FAMILIES.map(fam => [fam, SCORECARD_METRICS_V2.filter(m => m.family === fam)]),
  ) as Record<FamilyName, MetricDefV2[]>;

  const stockGroupKeys = stocks.map(() => "__global__");

  // ── Raw values ──────────────────────────────────────────────────────────────
  const rawValues: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    rawValues[m.key] = stocks.map(s => {
      const v = m.getValue(s);
      return v == null || !isFinite(v) ? null : v;
    });
  });

  // ── Suspect detection (same as V2) ──────────────────────────────────────────
  const suspectSets: Set<string>[] = stocks.map(() => new Set<string>());
  stocks.forEach((s, i) => {
    const nm = rawValues["netmgn"][i];
    if (nm !== null && Math.abs(nm) > 1.0) suspectSets[i].add("netmgn");
    const rg = rawValues["revgrow"][i];
    if (rg !== null && Math.abs(rg) > 10.0) suspectSets[i].add("revgrow");
    const eg = rawValues["epsgrow"][i];
    if (eg !== null && Math.abs(eg) > 10.0) suspectSets[i].add("epsgrow");
    if (s.netIncome != null && s.totalRevenue != null && s.totalRevenue !== 0 &&
        Math.abs(s.netIncome) > Math.abs(s.totalRevenue)) {
      suspectSets[i].add("earningsYield");
      suspectSets[i].add("netmgn");
    }
  });

  // ── Peer normalization (fallback for metrics without sufficient history) ─────
  const peerNormScores: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    const raw = rawValues[m.key];
    const result: (number | null)[] = new Array(stocks.length).fill(null);
    const groups = new Map<string, number[]>();
    stockGroupKeys.forEach((gk, i) => {
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(i);
    });
    groups.forEach(idxs => {
      const groupVals = idxs.map(i => raw[i]);
      const groupNorm = normalize(groupVals, { higherIsBetter: m.higherIsBetter });
      idxs.forEach((stockIdx, j) => { result[stockIdx] = groupNorm[j]; });
    });
    peerNormScores[m.key] = result;
  });

  // ── V3 norm: own-history where possible, peer fallback otherwise ─────────────
  const normScores: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    normScores[m.key] = stocks.map((s, i) => {
      const histKey = METRIC_TO_HISTORY_KEY[m.key];
      if (histKey !== undefined) {
        const tickerHist = history[s.ticker];
        const metricHist = tickerHist?.[histKey];
        const own = ownHistoryScore(rawValues[m.key][i], metricHist, m.higherIsBetter);
        if (own !== null) return own;
      }
      return peerNormScores[m.key][i];
    });
  });

  // ── Base-effect growth guard (same as V2) ────────────────────────────────────
  const TINY_REV = 100_000_000;
  const BASE_GROWTH_CAP = 5.0;
  stocks.forEach((s, i) => {
    const rg = rawValues["revgrow"][i];
    if (s.totalRevenue != null && s.totalRevenue < TINY_REV &&
        rg != null && rg > BASE_GROWTH_CAP) {
      normScores["revgrow"][i] = 0.5;
      suspectSets[i].add("revgrow");
    }
  });

  // ── Per-metric ranks from raw values ─────────────────────────────────────────
  const metricRanks: Record<string, number[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    const raw = rawValues[m.key];
    const sorted = raw
      .map((v, i) => ({ v, i }))
      .filter(x => x.v !== null)
      .sort((a, b) => m.higherIsBetter
        ? (b.v as number) - (a.v as number)
        : (a.v as number) - (b.v as number));
    const ranks = new Array(stocks.length).fill(0);
    sorted.forEach(({ i }, ri) => { ranks[i] = ri + 1; });
    metricRanks[m.key] = ranks;
  });

  // ── Family scores ─────────────────────────────────────────────────────────────
  type FamilyEntry = { score: number; coverage: number; lowCoverage: boolean };
  const familyScoreGrid: Record<FamilyName, FamilyEntry>[] = stocks.map(() => ({
    value:   { score: 0.5, coverage: 0, lowCoverage: true },
    growth:  { score: 0.5, coverage: 0, lowCoverage: true },
    quality: { score: 0.5, coverage: 0, lowCoverage: true },
    safety:  { score: 0.5, coverage: 0, lowCoverage: true },
  }));

  stocks.forEach((_, si) => {
    FAMILIES.forEach(fam => {
      const metrics = familyMetrics[fam];
      const available = metrics.filter(m => normScores[m.key][si] !== null);
      const coverage = available.length / metrics.length;
      if (available.length === 0) {
        familyScoreGrid[si][fam] = { score: 0.5, coverage: 0, lowCoverage: true };
      } else {
        const totalIntra = available.reduce((s, m) => s + m.intraWeight, 0);
        const score = available.reduce((acc, m) =>
          acc + (normScores[m.key][si] as number) * (m.intraWeight / totalIntra), 0);
        familyScoreGrid[si][fam] = { score, coverage, lowCoverage: coverage < 0.6 };
      }
    });
  });

  // ── Total scores ──────────────────────────────────────────────────────────────
  const maxPossible = 100;
  const totals = stocks.map((_, si) =>
    FAMILIES.reduce((sum, fam) => sum + familyScoreGrid[si][fam].score * preset[fam], 0),
  );

  const ranked = totals.map((score, i) => ({ i, score })).sort((a, b) => b.score - a.score);

  return ranked.map(({ i: si }, rankIdx) => {
    const s = stocks[si];
    const fsg = familyScoreGrid[si];

    const ms: StockScore["metricScores"] = {};
    SCORECARD_METRICS_V2.forEach(m => {
      const norm = normScores[m.key][si];
      const availableInFamily = familyMetrics[m.family].filter(fm => normScores[fm.key][si] !== null);
      const totalIntra = availableInFamily.reduce((acc, fm) => acc + fm.intraWeight, 0);
      const weightedScore = (norm !== null && totalIntra > 0)
        ? (norm * m.intraWeight / totalIntra) * preset[m.family]
        : 0;
      ms[m.key] = {
        value: rawValues[m.key][si],
        weightedScore: parseFloat(weightedScore.toFixed(3)),
        rank: metricRanks[m.key][si] || 0,
      };
    });

    const overallCoverage = FAMILIES.reduce((s, fam) => s + fsg[fam].coverage, 0) / FAMILIES.length;
    const dataQuality: StockScore["dataQuality"] =
      overallCoverage >= 0.75 ? "good" : overallCoverage >= 0.4 ? "partial" : "insufficient";

    const famsByScore = FAMILIES
      .map(fam => ({ fam, score: fsg[fam].score }))
      .sort((a, b) => b.score - a.score);
    const leading = famsByScore
      .filter(f => f.score >= 0.65).slice(0, 2)
      .map(f => f.fam.charAt(0).toUpperCase() + f.fam.slice(1));
    const lagging = famsByScore
      .filter(f => f.score <= 0.35)
      .map(f => f.fam.charAt(0).toUpperCase() + f.fam.slice(1));
    const parts: string[] = [];
    if (leading.length) parts.push(`Leads: ${leading.join(" & ")}`);
    if (lagging.length) parts.push(`Lags: ${lagging.join(" & ")}`);
    const reason = parts.join(" · ") ||
      (rankIdx === 0 ? "Tops peers across all four factors" : "Competitive across factors");

    return {
      ticker: s.ticker,
      companyName: s.companyName,
      totalScore: parseFloat(totals[si].toFixed(2)),
      maxPossible,
      rank: rankIdx + 1,
      metricScores: ms,
      reason,
      familyScores: fsg,
      dataQuality,
      gateStatus: "ok" as const,
      suspectMetrics: [...suspectSets[si]],
      dataSourceFlags: s.discrepancyFlags?.filter(Boolean) ?? [],
      waccInputs: (!FINANCIAL_TICKERS.has(s.ticker) && s.roic != null)
        ? {
            beta: s.beta ?? null,
            approxWacc: approxWACC({
              beta: s.beta,
              totalDebt: s.totalDebt,
              totalStockholdersEquity: s.totalStockholdersEquity,
              effectiveTaxRate: s.effectiveTaxRate,
              interestExpense: s.interestExpense,
            }),
          }
        : undefined,
    };
  });
}
