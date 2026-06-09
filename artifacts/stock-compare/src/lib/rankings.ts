import { StockMetrics } from "@workspace/api-client-react";
import {
  safeDiv, normalize, MIN_SECTOR_N,
  cashRunway, dilutionRate, interestCoverage, approxWACC, roicWaccSpread,
  MAX_CASH_RUNWAY_QUARTERS,
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
  { key: "peg",           label: "PEG Ratio",         family: "value",   intraWeight: 2, higherIsBetter: false,
    // Clamp to null for negative earnings or non-positive growth — negative PEG is misleading
    getValue: s => (s.epsGrowth != null && s.epsGrowth <= 0) || (s.netIncome != null && s.netIncome < 0)
      ? null : s.pegRatio },

  // GROWTH
  { key: "revgrow",  label: "Revenue Growth", family: "growth", intraWeight: 3, higherIsBetter: true,  getValue: s => s.revenueGrowthYoY },
  { key: "epsgrow",  label: "EPS Growth",     family: "growth", intraWeight: 3, higherIsBetter: true,  getValue: s => s.epsGrowth },
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
      const wacc = approxWACC({
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
];

// ─── computeRankingsV2 ───────────────────────────────────────────────────────

const FAMILIES: FamilyName[] = ["value", "growth", "quality", "safety"];

// Thresholds for flagging suspect data (decimal units: 1.0 = 100%)
const SUSPECT = { marginAbs: 1.0, growthAbs: 10.0 } as const;

export function computeRankingsV2(
  stocks: StockMetrics[],
  preset: FamilyPreset = FAMILY_PRESETS.PUT_SELLER,
): StockScore[] {
  if (stocks.length === 0) return [];

  const familyMetrics = Object.fromEntries(
    FAMILIES.map(fam => [fam, SCORECARD_METRICS_V2.filter(m => m.family === fam)]),
  ) as Record<FamilyName, MetricDefV2[]>;

  // Normalize all stocks against the whole universe.
  // Sector-neutral mode requires a cached sectorStats table (pre-computed from a broader
  // peer universe on a slow cadence) — not yet wired; always use whole-universe for now.
  const stockGroupKeys = stocks.map(() => "__global__");

  // ── Raw values ──────────────────────────────────────────────────────────────
  const rawValues: Record<string, (number | null)[]> = {};
  SCORECARD_METRICS_V2.forEach(m => {
    rawValues[m.key] = stocks.map(s => {
      const v = m.getValue(s);
      return v == null || !isFinite(v) ? null : v;
    });
  });

  // ── Suspect detection (2f data-sanity) ──────────────────────────────────────
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
        const totalIntra = available.reduce((s, m) => s + m.intraWeight, 0);
        const score = available.reduce((acc, m) =>
          acc + (normScores[m.key][si] as number) * (m.intraWeight / totalIntra), 0);
        familyScoreGrid[si][fam] = { score, coverage, lowCoverage: coverage < 0.6 };
      }
    });
  });

  // ── Total scores (maxPossible = 100, constant across all stocks) ─────────────
  const maxPossible = 100;
  const totals = stocks.map((_, si) =>
    FAMILIES.reduce((sum, fam) => sum + familyScoreGrid[si][fam].score * preset[fam], 0),
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
    };
  });
}
