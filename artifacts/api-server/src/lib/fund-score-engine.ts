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
import { shrinkToNeutral, TOTAL_MIN_COVERAGE, winsorizeValues } from "./fundamentals-scoring-math.js";
import {
  clampGrowth,
  expectedEarningsYield,
  trailingEarningsYield,
  sanitizedFcfYield,
  netCashToAssets,
  blendWeightsFor,
  blendThree,
  applyPostScoreAdjustments,
  isExtendedCyclical,
  isMegacap,
  PEG_UNRELIABLE_FLOOR,
  DEFAULT_BLEND,
} from "./fund-score-guards.js";
import { applySectorLayerToScores, SECTOR_LAYER_WEIGHT } from "./fund-sector-layer.js";

export { SECTOR_LAYER_WEIGHT };

/** Default peer/sector/universe weights (soft peers / megacaps / expEy override per ticker). */
export const PEER_NORM_WEIGHT = DEFAULT_BLEND.peer;
export const SECTOR_NORM_WEIGHT = DEFAULT_BLEND.sector;
export const UNIVERSE_NORM_WEIGHT = DEFAULT_BLEND.universe;

function sectorIdOf(peerGroupId: string | null): string {
  if (!peerGroupId) return "__none__";
  const i = peerGroupId.indexOf(".");
  return i > 0 ? peerGroupId.slice(0, i) : peerGroupId;
}

export type FamilyName = "value" | "growth" | "quality" | "safety";
export type StyleBucket =
  | "value"
  | "growth"
  | "blend"
  | "garp"
  | "quality_defensive"
  | "pre_revenue"
  | "financial";

export type FundRowInput = {
  ticker: string;
  peRatio: number | null;
  pegRatio: number | null;
  forwardPe: number | null;
  evEbitda: number | null;
  evRevenue: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  dividendYield: number | null;
  netIncome: number | null;
  freeCashFlow: number | null;
  totalRevenue: number | null;
  ebitda: number | null;
  ebit: number | null;
  interestExpense: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  roic: number | null;
  wacc: number | null;
  revenueGrowthYoY: number | null;
  revenueGrowthYoyPrior: number | null;
  epsGrowth: number | null;
  analystTargetPrice: number | null;
  currentPrice: number | null; // optional — for yields / upside
  marketCap: number | null;
  currentRatio: number | null;
  debtToEquity: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  quarterlyOperatingCashFlow: number | null;
  sharesOutstanding: number | null;
  sharesOutstandingPrior: number | null;
  beta: number | null;
  grossProfit: number | null;
  totalAssets: number | null;
  annualOperatingCashFlow: number | null;
  tangibleBookValuePerShare: number | null;
  ffoProxy: number | null;
  peerGroupId: string | null;
  scoringMode: string | null;
};

export type MetricKey =
  | "earningsYield"
  | "fcfYield"
  | "ps"
  | "peg"
  | "fwdpe"
  | "evEbitda"
  | "evRev"
  | "pb"
  | "ptbv"
  | "pFfo"
  | "expEy"
  | "divy"
  | "revgrow"
  | "revaccel"
  | "epsgrow"
  | "upside"
  | "avgEpsSurprise"
  | "ibesRevBreadth"
  | "ibesSue"
  | "ibesFwdGrowth"
  | "grossmgn"
  | "operatingmgn"
  | "netmgn"
  | "roe"
  | "fcfmgn"
  | "roicwacc"
  | "gpa"
  | "accruals"
  | "fScore"
  | "cashrun"
  | "intcov"
  | "dilution"
  | "cr"
  | "de"
  | "netDebtEbitda"
  | "beta"
  | "netCashAssets";

type MetricDef = {
  key: MetricKey;
  family: FamilyName;
  baseIntra: number;
  higherIsBetter: boolean;
  /** Metrics excluded for these styles */
  excludeStyles?: StyleBucket[];
  /** Externally-covered metric (e.g. IBES): a null value is skipped entirely instead of shrinking coverage. */
  optional?: boolean;
};

const METRICS: MetricDef[] = [
  { key: "earningsYield", family: "value", baseIntra: 3, higherIsBetter: true, excludeStyles: ["pre_revenue"] },
  { key: "fcfYield", family: "value", baseIntra: 3, higherIsBetter: true },
  { key: "ps", family: "value", baseIntra: 1.5, higherIsBetter: false },
  { key: "peg", family: "value", baseIntra: 2, higherIsBetter: false, excludeStyles: ["pre_revenue"] },
  { key: "fwdpe", family: "value", baseIntra: 2, higherIsBetter: false, excludeStyles: ["pre_revenue"] },
  { key: "evEbitda", family: "value", baseIntra: 2, higherIsBetter: false },
  { key: "evRev", family: "value", baseIntra: 1, higherIsBetter: false },
  { key: "pb", family: "value", baseIntra: 1, higherIsBetter: false },
  { key: "ptbv", family: "value", baseIntra: 2, higherIsBetter: false },
  { key: "pFfo", family: "value", baseIntra: 2.5, higherIsBetter: false },
  { key: "expEy", family: "value", baseIntra: 3.5, higherIsBetter: true },
  { key: "divy", family: "value", baseIntra: 1, higherIsBetter: true },

  { key: "revgrow", family: "growth", baseIntra: 2.5, higherIsBetter: true },
  { key: "revaccel", family: "growth", baseIntra: 2, higherIsBetter: true },
  { key: "epsgrow", family: "growth", baseIntra: 2.5, higherIsBetter: true },
  { key: "upside", family: "growth", baseIntra: 1, higherIsBetter: true },
  { key: "avgEpsSurprise", family: "growth", baseIntra: 1, higherIsBetter: true },
  // WRDS IBES cache — street momentum / standardized surprise (null if unsynced)
  // optional: same coverage bug as ibesFwdGrowth — no IBES row must not shrink data coverage / wipe growth.
  { key: "ibesRevBreadth", family: "growth", baseIntra: 1.5, higherIsBetter: true, optional: true },
  // A25 F1: lab IC ~0 for SUE — keep field for UI/diagnostics, weight 0 so it doesn't move fund score.
  { key: "ibesSue", family: "growth", baseIntra: 0, higherIsBetter: true },
  // Consensus EPS growth FY1→FY2 (same IBES statpers, so split-invariant). Fair-value factor study:
  // IC +0.108 (t 3.4) vs 126-d peer-relative return, uncorrelated with breadth/drift/trend.
  // Weight 0 in fund-1.0.0; fund-1.1.0 (challenger → user-approved promotion) gives it weight.
  // optional: a ticker IBES doesn't cover is "not covered", not "missing data" — it must not shrink coverage
  // (without this, HOLX fell below the 0.4 total gate and CMPS lost its growth family in the before/after).
  { key: "ibesFwdGrowth", family: "growth", baseIntra: 0, higherIsBetter: true, optional: true },

  { key: "grossmgn", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "operatingmgn", family: "quality", baseIntra: 2.25, higherIsBetter: true },
  { key: "netmgn", family: "quality", baseIntra: 3.25, higherIsBetter: true },
  { key: "roe", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "fcfmgn", family: "quality", baseIntra: 2.25, higherIsBetter: true },
  { key: "roicwacc", family: "quality", baseIntra: 1.5, higherIsBetter: true },
  { key: "gpa", family: "quality", baseIntra: 2, higherIsBetter: true },
  { key: "accruals", family: "quality", baseIntra: 2, higherIsBetter: false },
  { key: "fScore", family: "quality", baseIntra: 2, higherIsBetter: true },

  { key: "cashrun", family: "safety", baseIntra: 3, higherIsBetter: true },
  { key: "intcov", family: "safety", baseIntra: 2.5, higherIsBetter: true },
  { key: "dilution", family: "safety", baseIntra: 2, higherIsBetter: false },
  { key: "cr", family: "safety", baseIntra: 1.5, higherIsBetter: true },
  { key: "de", family: "safety", baseIntra: 1, higherIsBetter: false, excludeStyles: ["financial"] },
  { key: "netDebtEbitda", family: "safety", baseIntra: 2, higherIsBetter: false, excludeStyles: ["financial"] },
  { key: "beta", family: "safety", baseIntra: 1.5, higherIsBetter: false },
  { key: "netCashAssets", family: "safety", baseIntra: 2, higherIsBetter: true },
];

export const STYLE_FAMILY_WEIGHTS: Record<StyleBucket, Record<FamilyName, number>> = {
  value: { value: 35, growth: 15, quality: 30, safety: 20 },
  // Growth: slightly less pure-growth, more quality — profitable compounders (PLTR) beat
  // revenue rockets that only win on revgrow/epsgrow overweight.
  growth: { value: 14, growth: 35, quality: 33, safety: 18 },
  garp: { value: 25, growth: 28, quality: 32, safety: 15 },
  blend: { value: 25, growth: 25, quality: 30, safety: 20 },
  quality_defensive: { value: 15, growth: 15, quality: 40, safety: 30 },
  pre_revenue: { value: 5, growth: 40, quality: 25, safety: 30 },
  financial: { value: 25, growth: 15, quality: 30, safety: 30 },
};

/** Megacaps in blend: peer multiples bury franchises — lean quality/safety over value. */
export const MEGACAP_BLEND_FAMILY_WEIGHTS: Record<FamilyName, number> = {
  value: 15, growth: 20, quality: 40, safety: 25,
};

const FINANCIAL_GROUP_RE = /(bank|insur|reit|financial|broker|asset_manag)/i;
const DEFENSIVE_GROUP_RE = /(staples|utilities|healthcare|pharma|telecom)/i;
const FINANCIAL_MODE = new Set(["financial", "insurance", "reit", "financial_mixed"]);

const MIN_Z_N = 8;
const MIN_PEERS_CONFIDENT = 5;

function approxWacc(beta: number | null): number | null {
  if (beta == null || !Number.isFinite(beta)) return null;
  return 0.045 + beta * 0.055;
}

/** True pre-revenue / pre-profit speculative: tiny or null revenue, or loss-making with small scale. */
export function isEconomicallyPreRevenue(r: FundRowInput): boolean {
  const rev = r.totalRevenue;
  const ni = r.netIncome;
  if (rev == null || rev <= 0) return true;
  if (rev < 50_000_000 && (ni == null || ni < 0)) return true;
  return false;
}

/** Loss-making operating company (has real revenue but negative earnings). */
export function isUnprofitableOperator(r: FundRowInput): boolean {
  return !isEconomicallyPreRevenue(r) && r.netIncome != null && r.netIncome < 0;
}

export function isFinancialLike(r: FundRowInput): boolean {
  if (r.scoringMode && FINANCIAL_MODE.has(r.scoringMode)) return true;
  return !!(r.peerGroupId && FINANCIAL_GROUP_RE.test(r.peerGroupId));
}

export function isCyclicalLike(r: FundRowInput): boolean {
  return isExtendedCyclical(r);
}

export function isChineseLike(r: FundRowInput): boolean {
  return r.scoringMode === "chinese" || !!(r.peerGroupId && /chinese/i.test(r.peerGroupId));
}

export function isReitLike(r: FundRowInput): boolean {
  return r.scoringMode === "reit" || !!(r.peerGroupId && /reit/i.test(r.peerGroupId));
}

/** Neg equity (neg PB), or critically thin liquidity. */
export function isDistressed(r: FundRowInput): boolean {
  if (r.priceToBook != null && r.priceToBook < 0) return true;
  if (r.currentRatio != null && r.currentRatio > 0 && r.currentRatio < 0.5) return true;
  return false;
}

function intraTilt(key: MetricKey, style: StyleBucket, base: number, r: FundRowInput): number {
  let w = base;
  if (key === "peg") {
    if (style === "growth" || style === "garp") w *= 1.4;
    if (style === "value") w *= 0.5;
  }
  // Value ↔ growth symmetry: value names overweight cheapness metrics; growth overweights growth prints
  if (key === "earningsYield" || key === "fcfYield" || key === "evEbitda" || key === "expEy" || key === "pb" || key === "ps") {
    if (style === "value") w *= 1.35;
    if (style === "growth") w *= 0.7;
    if (style === "quality_defensive" && (key === "fcfYield" || key === "expEy")) w *= 1.15;
  }
  if (key === "revgrow" || key === "epsgrow") {
    if (style === "growth" || style === "pre_revenue") w *= 1.15;
    if (style === "value") w *= 0.7;
    if (style === "quality_defensive") w *= 0.85;
  }
  if (key === "roicwacc" || key === "grossmgn" || key === "gpa" || key === "operatingmgn" || key === "netmgn" || key === "fcfmgn") {
    if (style === "quality_defensive") w *= 1.35;
    if (style === "garp" || style === "growth") w *= 1.2;
    if (style === "value") w *= 1.1; // value still cares about quality, mildly
  }
  if (key === "netDebtEbitda" || key === "intcov" || key === "fScore" || key === "cr" || key === "de" || key === "beta" || key === "netCashAssets") {
    if (style === "value" || style === "quality_defensive") w *= 1.25;
  }
  if (key === "cashrun" && style === "financial") w *= 0.25;

  // Dilution matters most for growth / pre-revenue (SBC-funded)
  if (key === "dilution" && (style === "growth" || style === "pre_revenue")) w *= 1.5;

  // Financials: book + ROE + P/TBV carry the quality/value signal; leverage ratios are structural
  if (style === "financial" || isFinancialLike(r)) {
    if (key === "roe" || key === "pb" || key === "divy" || key === "ptbv") w *= 1.35;
    if (key === "ptbv") w *= 1.25; // stack on top of financial tilt
    if (key === "pb" && r.tangibleBookValuePerShare != null) w *= 0.55; // prefer P/TBV when available
    if (key === "cr") w *= 0.5;
  }

  // REITs: distribution + FFO/FCF proxy over NI margins
  if (isReitLike(r)) {
    if (key === "divy" || key === "fcfYield" || key === "fcfmgn" || key === "pFfo") w *= 1.4;
    if (key === "netmgn" || key === "earningsYield") w *= 0.5;
  }

  // Cyclicals (incl. semis/memory): peak EY/margins look "quality" — prefer EV/EBITDA + FCF + expected EY
  if (isCyclicalLike(r)) {
    if (key === "earningsYield") w *= 0.55;
    if (key === "roe" || key === "netmgn" || key === "grossmgn") w *= 0.65;
    if (key === "evEbitda" || key === "fcfYield" || key === "expEy") w *= 1.35;
  }

  // Chinese / VIE: don't over-trust accounting ROE; lean safety + expected EY over PEG
  if (isChineseLike(r)) {
    if (key === "roe" || key === "roicwacc") w *= 0.75;
    if (key === "peg") w *= 0.5;
    if (key === "cashrun" || key === "fcfYield" || key === "dilution" || key === "beta" || key === "netCashAssets") w *= 1.25;
    if (key === "expEy") w *= 1.2;
  }

  // Distressed: value traps — haircut cheapness, amplify liquidity/dilution
  if (isDistressed(r)) {
    if (key === "earningsYield" || key === "pb" || key === "ps") w *= 0.4;
    if (key === "cashrun" || key === "cr" || key === "dilution") w *= 1.5;
  }

  if (key === "upside") w = Math.min(w, 1);
  return w;
}

function isExcluded(m: MetricDef, style: StyleBucket, scoringMode: string | null, r?: FundRowInput): boolean {
  if (m.excludeStyles?.includes(style)) return true;
  if (!r) return false;

  if (
    scoringMode === "pre_revenue_ok" &&
    isEconomicallyPreRevenue(r) &&
    (m.key === "peg" || m.key === "earningsYield" || m.key === "fwdpe")
  ) {
    return true;
  }
  if (isUnprofitableOperator(r) && (m.key === "peg" || m.key === "earningsYield" || m.key === "epsgrow")) {
    return true;
  }

  // Banks / insurers / REITs: structural leverage — D/E and ND/EBITDA are not comparable to corporates
  if (isFinancialLike(r) && (m.key === "de" || m.key === "netDebtEbitda")) return true;
  // Banks: current ratio is not a meaningful liquidity signal
  if ((scoringMode === "financial" || (r.peerGroupId && /bank/i.test(r.peerGroupId))) && m.key === "cr") {
    return true;
  }
  // REITs: NI margin / ROIC-WACC poorly mapped to FFO economics
  if (isReitLike(r) && (m.key === "roicwacc" || m.key === "netmgn")) return true;
  // Distressed: PB as "value" is noise when equity is negative
  if (isDistressed(r) && m.key === "pb" && r.priceToBook != null && r.priceToBook < 0) return true;
  // P/TBV only meaningful for banks/insurers/brokers (goodwill-heavy financials)
  if (m.key === "ptbv" && !isFinancialLike(r)) return true;
  // P/FFO only for REITs (FFO proxy = NI + D&A)
  if (m.key === "pFfo" && !isReitLike(r)) return true;

  return false;
}

export function assignStyleBucket(
  r: FundRowInput,
  peerValueNorm: number | null,
  peerGrowthNorm: number | null,
): StyleBucket {
  if (isEconomicallyPreRevenue(r)) return "pre_revenue";
  // scoringMode / peer path for financials (banks, insurance, REITs, brokers)
  if (isFinancialLike(r)) return "financial";
  if (r.peerGroupId && DEFENSIVE_GROUP_RE.test(r.peerGroupId) && (peerValueNorm == null || peerValueNorm < 0.7)) {
    if (peerGrowthNorm == null || peerGrowthNorm < 0.55) return "quality_defensive";
  }
  const v = peerValueNorm ?? 0.5;
  const g = peerGrowthNorm ?? 0.5;
  if (isUnprofitableOperator(r)) {
    if (g >= 0.55) return "growth";
    return "blend";
  }
  if (v >= 0.55 && g >= 0.55) return "garp";
  if (v >= 0.6 && g < 0.45) return "value";
  if (g >= 0.6 && v < 0.45) return "growth";
  if (v < 0.4 && g < 0.4 && (r.beta == null || r.beta < 0.9)) return "quality_defensive";
  return "blend";
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

function normalizeCohort(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const idxs: number[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) idxs.push(i);
  });
  const out: (number | null)[] = values.map(() => null);
  if (idxs.length === 0) return out;

  const winsorized = idxs.length >= 10 ? winsorizeValues(values, 0.02, 0.98, 5) : values;

  if (idxs.length >= MIN_Z_N) {
    const nums = idxs.map((i) => winsorized[i] as number);
    const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
    const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
    const std = Math.sqrt(variance);
    for (const i of idxs) {
      const wv = winsorized[i] as number;
      let z = std === 0 ? 0 : (wv - mean) / std;
      z = Math.max(-3, Math.min(3, z));
      const score01 = (z + 3) / 6;
      out[i] = higherIsBetter ? score01 : 1 - score01;
    }
  } else {
    const sorted = [...idxs].sort((a, b) =>
      higherIsBetter
        ? (winsorized[b] as number) - (winsorized[a] as number)
        : (winsorized[a] as number) - (winsorized[b] as number),
    );
    sorted.forEach((i, rankIdx) => {
      out[i] = idxs.length > 1 ? (idxs.length - 1 - rankIdx) / (idxs.length - 1) : 1;
    });
  }
  return out;
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
};

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
      famAcc[m.family].total += m.baseIntra;
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

export { METRICS, num, avgEpsSurprise };
