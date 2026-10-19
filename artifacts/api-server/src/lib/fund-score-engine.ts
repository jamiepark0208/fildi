/**
 * Unified fundamental score engine (fund-score-v2).
 * Peer-group z/ordinal + short-history blend + style-bucket weights.
 * Pure math where possible; DB wiring lives in fundamentals-db.ts.
 */
import {
  netDebtToEbitda,
  grossProfitability,
  accrualsRatio,
  avgEpsSurprise,
  piotroskiFScore,
  ownHistoryNorm,
  blendPeerHist,
  num,
} from "./fund-derived-metrics.js";
import { shrinkToNeutral, TOTAL_MIN_COVERAGE } from "./fundamentals-scoring-math.js";
import { normalizeCohort } from "./fund-score-normalize.js";
import {
  clampGrowth,
  expectedEarningsYield,
  trailingEarningsYield,
  sanitizedFcfYield,
  netCashToAssets,
  blendWeightsFor,
  blendThree,
  applyPostScoreAdjustments,
  isMegacap,
  PEG_UNRELIABLE_FLOOR,
  DEFAULT_BLEND,
} from "./fund-score-guards.js";
import { applySectorLayerToScores, SECTOR_LAYER_WEIGHT } from "./fund-sector-layer.js";
import type { FamilyName, FundRowInput, MetricDef, MetricKey, StyleBucket } from "./fund-score-types.js";
import { approxWacc, intraTilt, isExcluded } from "./fund-score-tilt.js";
import {
  METRICS,
  STYLE_FAMILY_WEIGHTS,
  MEGACAP_BLEND_FAMILY_WEIGHTS,
  MIN_PEERS_CONFIDENT,
} from "./fund-score-metrics.js";
import { assignStyleBucket } from "./fund-score-style.js";

export { SECTOR_LAYER_WEIGHT };
export type { FamilyName, FundRowInput, MetricKey, StyleBucket } from "./fund-score-types.js";
export { STYLE_FAMILY_WEIGHTS, MEGACAP_BLEND_FAMILY_WEIGHTS } from "./fund-score-metrics.js";
export {
  assignStyleBucket,
  isChineseLike,
  isCyclicalLike,
  isDistressed,
  isEconomicallyPreRevenue,
  isFinancialLike,
  isReitLike,
  isUnprofitableOperator,
} from "./fund-score-style.js";

/** Default peer/sector/universe weights (soft peers / megacaps / expEy override per ticker). */
export const PEER_NORM_WEIGHT = DEFAULT_BLEND.peer;
export const SECTOR_NORM_WEIGHT = DEFAULT_BLEND.sector;
export const UNIVERSE_NORM_WEIGHT = DEFAULT_BLEND.universe;

function sectorIdOf(peerGroupId: string | null): string {
  if (!peerGroupId) return "__none__";
  const i = peerGroupId.indexOf(".");
  return i > 0 ? peerGroupId.slice(0, i) : peerGroupId;
}



export function rawMetricValue(
  key: MetricKey,
  r: FundRowInput,
  extras?: {
    avgEpsSurprise?: number | null;
    fScore?: number | null;
    ibesRevBreadth?: number | null;
    ibesSue?: number | null;
    ibesFwdGrowth?: number | null;
  },
): number | null {
  const mcap = r.marketCap;
  switch (key) {
    case "earningsYield":
      return trailingEarningsYield(r);
    case "fcfYield":
      return sanitizedFcfYield(r);
    case "ps":
      return r.priceToSales;
    case "peg":
      if (r.epsGrowth == null || r.epsGrowth <= 0 || (r.netIncome != null && r.netIncome < 0)) return null;
      if (r.pegRatio == null) return null;
      // Unrealistically low PEG from one-year EPS spikes is not "deep value"
      if (r.pegRatio > 0 && r.pegRatio < PEG_UNRELIABLE_FLOOR) return PEG_UNRELIABLE_FLOOR;
      return r.pegRatio;
    case "fwdpe":
      return r.forwardPe;
    case "evEbitda":
      return r.evEbitda;
    case "evRev":
      return r.evRevenue;
    case "pb":
      return r.priceToBook;
    case "ptbv": {
      const tbvps = r.tangibleBookValuePerShare;
      const sh = r.sharesOutstanding;
      const mcap = r.marketCap;
      if (tbvps == null || tbvps <= 0 || sh == null || sh <= 0 || mcap == null || mcap <= 0) return null;
      return mcap / (tbvps * sh);
    }
    case "pFfo": {
      const ffo = r.ffoProxy;
      const mcap = r.marketCap;
      if (ffo == null || ffo <= 0 || mcap == null || mcap <= 0) return null;
      return mcap / ffo;
    }
    case "expEy":
      return expectedEarningsYield(r);
    case "divy":
      return r.dividendYield;
    case "revgrow":
      return clampGrowth(r.revenueGrowthYoY);
    case "revaccel": {
      if (r.revenueGrowthYoY == null || r.revenueGrowthYoyPrior == null) return null;
      const cur = clampGrowth(r.revenueGrowthYoY);
      const prior = clampGrowth(r.revenueGrowthYoyPrior);
      if (cur == null || prior == null) return null;
      return cur - prior;
    }
    case "epsgrow":
      return clampGrowth(r.epsGrowth);
    case "upside":
      if (r.analystTargetPrice == null || r.currentPrice == null || r.currentPrice <= 0) return null;
      return r.analystTargetPrice / r.currentPrice - 1;
    case "avgEpsSurprise":
      return extras?.avgEpsSurprise ?? null;
    case "ibesRevBreadth":
      return extras?.ibesRevBreadth ?? null;
    case "ibesSue":
      return extras?.ibesSue ?? null;
    case "ibesFwdGrowth":
      return extras?.ibesFwdGrowth ?? null;
    case "grossmgn":
      return r.grossMargin;
    case "operatingmgn":
      return r.operatingMargin;
    case "netmgn":
      return r.netMargin ?? (r.netIncome != null && r.totalRevenue && r.totalRevenue !== 0
        ? r.netIncome / r.totalRevenue
        : null);
    case "roe":
      return r.returnOnEquity;
    case "fcfmgn":
      return r.freeCashFlow != null && r.totalRevenue && r.totalRevenue !== 0
        ? r.freeCashFlow / r.totalRevenue
        : null;
    case "roicwacc": {
      const w = r.wacc ?? approxWacc(r.beta);
      return r.roic != null && w != null ? r.roic - w : null;
    }
    case "gpa":
      return grossProfitability(r.grossProfit, r.totalAssets);
    case "accruals":
      return accrualsRatio(r.netIncome, r.annualOperatingCashFlow, r.totalAssets);
    case "fScore":
      return extras?.fScore ?? null;
    case "cashrun": {
      const cash = r.cashAndEquivalents;
      const ocf = r.quarterlyOperatingCashFlow;
      if (cash == null || ocf == null) return null;
      if (ocf > 0) return Math.min(20, cash / (ocf * 4)); // years of runway capped
      if (ocf < 0) return cash / Math.abs(ocf * 4);
      return null;
    }
    case "intcov":
      if (r.ebit == null || r.interestExpense == null || r.interestExpense <= 0) return null;
      return Math.min(50, r.ebit / r.interestExpense);
    case "dilution":
      if (r.sharesOutstanding == null || r.sharesOutstandingPrior == null || r.sharesOutstandingPrior <= 0) return null;
      return r.sharesOutstanding / r.sharesOutstandingPrior - 1;
    case "cr":
      return r.currentRatio;
    case "de":
      return r.debtToEquity;
    case "netDebtEbitda":
      return netDebtToEbitda(r.totalDebt, r.cashAndEquivalents, r.ebitda);
    case "beta":
      return r.beta != null && r.beta > 0 ? Math.min(3.5, r.beta) : null;
    case "netCashAssets":
      return netCashToAssets(r.cashAndEquivalents, r.totalDebt, r.totalAssets);
    default:
      return null;
  }
}


export type MetricScoreDetail = {
  value: number | null;
  peerNorm: number | null;
  histNorm: number | null;
  blended: number | null;
  weightedScore: number;
};

export type ScoredTicker = {
  ticker: string;
  totalScore: number | null;
  /** Company score before sector-opportunity blend (null if unscored). */
  companyScore: number | null;
  /** Calibrated peer-group sector opportunity (same units as total). */
  sectorScore: number | null;
  valueScore: number | null;
  qualityScore: number | null;
  growthScore: number | null;
  safetyScore: number | null;
  styleBucket: StyleBucket;
  confidence: "high" | "low";
  peerGroupId: string | null;
  peerGroupSize: number;
  coverage: { value: number; growth: number; quality: number; safety: number; total: number };
  ranked: boolean;
  metricScores: Record<string, MetricScoreDetail>;
};

export type HistoryByTicker = Record<string, Partial<Record<MetricKey, number[]>>>;
export type SurpriseByTicker = Record<string, number | null>;

/** WRDS IBES growth extras — missing tickers stay null (no penalty). */
export type IbesSignalsByTicker = Record<
  string,
  { revBreadth: number | null; sue: number | null; fwdGrowth?: number | null }
>;

/** Optional overrides from public.scorecard_params champion (fund-1.0.0 seed = code defaults). */
export type ScoreUniverseParams = {
  metricBaseIntra?: Partial<Record<MetricKey, number>>;
  styleFamilyWeights?: Partial<Record<StyleBucket, Partial<Record<FamilyName, number>>>>;
  megacapBlendFamilyWeights?: Partial<Record<FamilyName, number>>;
  totalMinCoverage?: number;
  familyMinCoverage?: number;
  /**
   * Metrics where "no value" means "not covered" (skipped, no coverage shrink). Absent = METRICS `optional` flags.
   * Present = the complete list (replaces the defaults, so a retired version reproduces exactly — e.g. fund-1.1.0
   * had only ibesFwdGrowth). Callers warn via missingDefaultOptionals() when a champion drops a code default.
   */
  optionalMetrics?: MetricKey[];
};

/** METRICS keys flagged optional in code — the list a champion inherits when it sets no optionalMetrics. */
export function defaultOptionalMetrics(): MetricKey[] {
  return METRICS.filter((m) => m.optional).map((m) => m.key);
}

/** Code-default optional metrics a params list leaves out (they become required → coverage shrink). */
export function missingDefaultOptionals(optionalMetrics: readonly string[] | undefined): MetricKey[] {
  if (!optionalMetrics) return [];
  return defaultOptionalMetrics().filter((k) => !optionalMetrics.includes(k));
}

export function scoreUniverse(
  rows: FundRowInput[],
  history: HistoryByTicker = {},
  surprises: SurpriseByTicker = {},
  ibesSignals: IbesSignalsByTicker = {},
  params?: ScoreUniverseParams,
): ScoredTicker[] {
  if (rows.length === 0) return [];

  const metrics = METRICS.map((m) => ({
    ...m,
    baseIntra: params?.metricBaseIntra?.[m.key] ?? m.baseIntra,
    optional: params?.optionalMetrics ? params.optionalMetrics.includes(m.key) : m.optional,
  }));
  const styleWeights: Record<StyleBucket, Record<FamilyName, number>> = { ...STYLE_FAMILY_WEIGHTS };
  if (params?.styleFamilyWeights) {
    for (const [style, fam] of Object.entries(params.styleFamilyWeights) as Array<
      [StyleBucket, Partial<Record<FamilyName, number>>]
    >) {
      if (!fam) continue;
      styleWeights[style] = { ...styleWeights[style], ...fam };
    }
  }
  const megacapWeights: Record<FamilyName, number> = {
    ...MEGACAP_BLEND_FAMILY_WEIGHTS,
    ...(params?.megacapBlendFamilyWeights ?? {}),
  };
  const totalMinCov = params?.totalMinCoverage ?? TOTAL_MIN_COVERAGE;
  const familyMinCov = params?.familyMinCoverage;

  // Precompute F-scores
  const fScores = new Map<string, number | null>();
  for (const r of rows) {
    const acc = accrualsRatio(r.netIncome, r.annualOperatingCashFlow, r.totalAssets);
    const at =
      r.totalRevenue != null && r.totalAssets && r.totalAssets > 0 ? r.totalRevenue / r.totalAssets : null;
    const fs = piotroskiFScore({
      netIncome: r.netIncome,
      annualOcf: r.annualOperatingCashFlow,
      accruals: acc,
      roa: r.returnOnAssets,
      roaPrior: null, // prior-year ROA needs history — partial F-Score OK
      grossMargin: r.grossMargin,
      grossMarginPrior: null,
      currentRatio: r.currentRatio,
      currentRatioPrior: null,
      debtToEquity: r.debtToEquity,
      debtToEquityPrior: null,
      sharesOutstanding: r.sharesOutstanding,
      sharesOutstandingPrior: r.sharesOutstandingPrior,
      assetTurnover: at,
      assetTurnoverPrior: null,
    });
    fScores.set(r.ticker, fs.score);
  }

  // Raw values matrix
  const raw: Record<MetricKey, (number | null)[]> = {} as any;
  for (const m of metrics) {
    raw[m.key] = rows.map((r) => {
      const ibes = ibesSignals[r.ticker];
      let v = rawMetricValue(m.key, r, {
        avgEpsSurprise: surprises[r.ticker] ?? null,
        fScore: fScores.get(r.ticker) ?? null,
        ibesRevBreadth: ibes?.revBreadth ?? null,
        ibesSue: ibes?.sue ?? null,
        ibesFwdGrowth: ibes?.fwdGrowth ?? null,
      });
      // Suspect guards
      if (m.key === "netmgn" && v != null && Math.abs(v) > 1) v = null;
      if ((m.key === "revgrow" || m.key === "epsgrow") && v != null && Math.abs(v) > 10) v = null;
      if (
        m.key === "revgrow" &&
        v != null &&
        v > 5 &&
        r.totalRevenue != null &&
        r.totalRevenue < 1e8
      ) {
        // tiny-revenue growth cap → treat as neutral later via replacing with null? plan: force 0.5
        // mark with sentinel by keeping value but we'll override norm
      }
      return v;
    });
  }

  // Group indices by peer group
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const g = r.peerGroupId ?? `__orphan__:${r.ticker}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(i);
  });

  // Peer norms per metric
  const peerNorm: Record<MetricKey, (number | null)[]> = {} as any;
  for (const m of metrics) {
    peerNorm[m.key] = rows.map(() => null);
    for (const [, idxs] of groups) {
      const vals = idxs.map((i) => raw[m.key][i]);
      const norms = normalizeCohort(vals, m.higherIsBetter);
      idxs.forEach((ri, k) => {
        peerNorm[m.key][ri] = norms[k];
      });
    }
  }

  // Sector norms (peer_group_id prefix, e.g. technology.*) — absolute-quality anchor
  const sectorGroups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const s = sectorIdOf(r.peerGroupId);
    if (!sectorGroups.has(s)) sectorGroups.set(s, []);
    sectorGroups.get(s)!.push(i);
  });
  const sectorNorm: Record<MetricKey, (number | null)[]> = {} as any;
  for (const m of metrics) {
    sectorNorm[m.key] = rows.map(() => null);
    for (const [, idxs] of sectorGroups) {
      if (idxs.length < 3) continue; // too thin — leave null, peer-only
      const vals = idxs.map((i) => raw[m.key][i]);
      const norms = normalizeCohort(vals, m.higherIsBetter);
      idxs.forEach((ri, k) => {
        sectorNorm[m.key][ri] = norms[k];
      });
    }
  }

  // Universe norms (absolute quality / soft-peer dampening)
  const universeNorm: Record<MetricKey, (number | null)[]> = {} as any;
  for (const m of metrics) {
    universeNorm[m.key] = normalizeCohort(raw[m.key], m.higherIsBetter);
  }

  // Peer sizes for per-ticker blend weights
  const peerSizeOf = rows.map((r) => groups.get(r.peerGroupId ?? `__orphan__:${r.ticker}`)?.length ?? 1);

  // Cross-section: peer + sector + universe (weights vary by soft peer / megacap / expEy)
  const crossNorm: Record<MetricKey, (number | null)[]> = {} as any;
  for (const m of metrics) {
    crossNorm[m.key] = rows.map((r, i) =>
      blendThree(
        peerNorm[m.key][i],
        sectorNorm[m.key][i],
        universeNorm[m.key][i],
        blendWeightsFor(r, peerSizeOf[i]!, m.key),
      ),
    );
  }

  // Tiny-revenue override → neutral 0.5
  rows.forEach((r, i) => {
    const v = raw.revgrow[i];
    if (v != null && v > 5 && r.totalRevenue != null && r.totalRevenue < 1e8) {
      crossNorm.revgrow[i] = 0.5;
      peerNorm.revgrow[i] = 0.5;
    }
  });

  // Provisional value/growth means for style assignment
  const styleOf = rows.map((r, i) => {
    const vKeys: MetricKey[] = ["earningsYield", "fcfYield", "evEbitda", "pb", "ptbv", "pFfo", "expEy"];
    const gKeys: MetricKey[] = ["revgrow", "epsgrow", "upside"];
    const vVals = vKeys.map((k) => crossNorm[k][i]).filter((x): x is number => x != null);
    const gVals = gKeys.map((k) => crossNorm[k][i]).filter((x): x is number => x != null);
    const vMean = vVals.length ? vVals.reduce((s, x) => s + x, 0) / vVals.length : null;
    const gMean = gVals.length ? gVals.reduce((s, x) => s + x, 0) / gVals.length : null;
    return assignStyleBucket(r, vMean, gMean);
  });

  const results: ScoredTicker[] = rows.map((r, i) => {
    const style = styleOf[i]!;
    const famW =
      style === "blend" && isMegacap(r)
        ? megacapWeights
        : styleWeights[style];
    const peerSize = groups.get(r.peerGroupId ?? `__orphan__:${r.ticker}`)?.length ?? 1;
    const confidence: "high" | "low" = peerSize >= MIN_PEERS_CONFIDENT ? "high" : "low";

    const metricScores: Record<string, MetricScoreDetail> = {};
    const famAcc: Record<FamilyName, { wSum: number; sSum: number; present: number; total: number }> = {
      value: { wSum: 0, sSum: 0, present: 0, total: 0 },
      growth: { wSum: 0, sSum: 0, present: 0, total: 0 },
      quality: { wSum: 0, sSum: 0, present: 0, total: 0 },
      safety: { wSum: 0, sSum: 0, present: 0, total: 0 },
    };

    for (const m of metrics) {
      if (m.optional && raw[m.key][i] == null) {
        metricScores[m.key] = { value: null, peerNorm: null, histNorm: null, blended: null, weightedScore: 0 };
        continue;
      }
      // A154: excluded metrics aren't part of this ticker's family → must not dilute coverage (dropped whole families).
      if (isExcluded(m, style, r.scoringMode, r)) {
        metricScores[m.key] = {
          value: raw[m.key][i],
          peerNorm: null,
          histNorm: null,
          blended: null,
          weightedScore: 0,
        };
        continue;
      }
      famAcc[m.family].total += m.baseIntra;
      const histArr = history[r.ticker]?.[m.key];
      const histN = histArr ? ownHistoryNorm(raw[m.key][i], histArr, m.higherIsBetter) : null;
      const pN = crossNorm[m.key][i];
      let blended = blendPeerHist(pN, histN);
      if (blended == null) {
        metricScores[m.key] = {
          value: raw[m.key][i],
          peerNorm: pN,
          histNorm: histN,
          blended: null,
          weightedScore: 0,
        };
        continue;
      }
      const iw = intraTilt(m.key, style, m.baseIntra, r);
      famAcc[m.family].present += m.baseIntra;
      famAcc[m.family].wSum += iw;
      famAcc[m.family].sSum += blended * iw;
      metricScores[m.key] = {
        value: raw[m.key][i],
        peerNorm: pN,
        histNorm: histN,
        blended,
        weightedScore: parseFloat((blended * iw * (famW[m.family] / 100)).toFixed(4)),
      };
    }

    const familyScores: Record<FamilyName, number | null> = {
      value: null,
      growth: null,
      quality: null,
      safety: null,
    };
    const coverage = { value: 0, growth: 0, quality: 0, safety: 0, total: 0 };
    let covPresent = 0;
    let covTotal = 0;
    (Object.keys(famAcc) as FamilyName[]).forEach((f) => {
      const a = famAcc[f];
      coverage[f] = a.total > 0 ? a.present / a.total : 0;
      covPresent += a.present;
      covTotal += a.total;
      if (a.wSum > 0) {
        const raw01 = a.sSum / a.wSum;
        const raw100 = raw01 * 100;
        familyScores[f] = shrinkToNeutral(raw100, coverage[f], familyMinCov);
      } else {
        familyScores[f] = null;
      }
    });
    coverage.total = covTotal > 0 ? covPresent / covTotal : 0;

    // Total from available families
    let tw = 0;
    let ts = 0;
    (Object.keys(familyScores) as FamilyName[]).forEach((f) => {
      const s = familyScores[f];
      if (s == null) return;
      tw += famW[f];
      ts += s * famW[f];
    });
    let totalScore: number | null =
      tw > 0 && coverage.total >= totalMinCov ? ts / tw : null;
    if (totalScore != null) {
      totalScore = parseFloat(totalScore.toFixed(2));
    }
    if (totalScore != null && confidence === "low" && totalScore > 90 && coverage.total < 0.5) {
      totalScore = shrinkToNeutral(totalScore, coverage.total, familyMinCov);
    }

    // v3 post-gates: safety prior, speculative cap, China haircut, megacap quality floor
    const post = applyPostScoreAdjustments({
      totalScore,
      qualityScore: familyScores.quality,
      safetyScore: familyScores.safety,
      safetyCoverage: coverage.safety,
      style,
      row: {
        marketCap: r.marketCap,
        forwardPe: r.forwardPe,
        netIncome: r.netIncome,
        epsGrowth: r.epsGrowth,
        totalRevenue: r.totalRevenue,
        priceToSales: r.priceToSales,
        peerGroupId: r.peerGroupId,
        scoringMode: r.scoringMode,
        cashAndEquivalents: r.cashAndEquivalents,
        totalDebt: r.totalDebt,
        totalAssets: r.totalAssets,
      },
    });
    if (post.safetyScore != null && familyScores.safety == null) {
      familyScores.safety = post.safetyScore;
    }
    totalScore = post.totalScore;
    const ranked = post.ranked && totalScore != null;

    return {
      ticker: r.ticker,
      totalScore,
      companyScore: totalScore,
      sectorScore: null,
      valueScore: familyScores.value != null ? parseFloat(familyScores.value.toFixed(2)) : null,
      qualityScore: familyScores.quality != null ? parseFloat(familyScores.quality.toFixed(2)) : null,
      growthScore: familyScores.growth != null ? parseFloat(familyScores.growth.toFixed(2)) : null,
      safetyScore: familyScores.safety != null ? parseFloat(familyScores.safety.toFixed(2)) : null,
      styleBucket: style,
      confidence,
      peerGroupId: r.peerGroupId,
      peerGroupSize: peerSize,
      coverage,
      ranked,
      metricScores,
    };
  });

  // Sector opportunity layer: final = (1−λ)×company + λ×peer-group opportunity
  const layer = applySectorLayerToScores({
    rows: rows.map((r) => ({
      peerGroupId: r.peerGroupId,
      marketCap: r.marketCap,
      revenueGrowthYoY: r.revenueGrowthYoY,
      returnOnEquity: r.returnOnEquity,
      peRatio: r.peRatio,
    })),
    companyScores: results.map((r) => r.companyScore),
    peerGroupIds: results.map((r) => r.peerGroupId),
    lambda: SECTOR_LAYER_WEIGHT,
  });
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    r.sectorScore =
      layer.sectorScores[i] != null ? parseFloat(layer.sectorScores[i]!.toFixed(2)) : null;
    if (r.companyScore != null && r.ranked) {
      r.totalScore = layer.blendedScores[i]!;
    }
  }

  return results;
}

/** Attach 1-based ranks; unranked → 0 */
export function withRanks(scored: ScoredTicker[]): (ScoredTicker & { rank: number })[] {
  const ranked = scored
    .filter((r) => r.ranked && r.totalScore != null)
    .sort((a, b) => b.totalScore! - a.totalScore!);
  const map = new Map(ranked.map((r, i) => [r.ticker, i + 1]));
  return scored.map((r) => ({ ...r, rank: map.get(r.ticker) ?? 0 }));
}

export { METRICS } from "./fund-score-metrics.js";
export { num, avgEpsSurprise };
