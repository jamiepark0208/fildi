/** A83 — raw fund metric getters (split from fund-score-engine). */
import {
  netDebtToEbitda,
  grossProfitability,
  accrualsRatio,
  avgEpsSurprise,
  piotroskiFScore,
} from "./fund-derived-metrics.js";
import {
  clampGrowth,
  expectedEarningsYield,
  trailingEarningsYield,
  sanitizedFcfYield,
  netCashToAssets,
  PEG_UNRELIABLE_FLOOR,
} from "./fund-score-guards.js";
import type { FundRowInput, MetricKey } from "./fund-score-types.js";
import { approxWacc } from "./fund-score-tilt.js";
import { hasNegativeEquity } from "./negative-equity-policy.js";

export function rawMetricValue(
  key: MetricKey,
  r: FundRowInput,
  extras?: {
    avgEpsSurprise?: number | null;
    fScore?: number | null;
    ibesRevBreadth?: number | null;
    ibesSue?: number | null;
    ibesFwdGrowth?: number | null;
    negativeEquityLeverage?: "legacy" | "sanitized";
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
      if (
        hasNegativeEquity(r.totalStockholdersEquity)
        && extras?.negativeEquityLeverage !== "legacy"
      ) {
        return null;
      }
      return r.priceToBook != null && r.priceToBook > 0 ? r.priceToBook : null;
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
      if (
        hasNegativeEquity(r.totalStockholdersEquity)
        && extras?.negativeEquityLeverage !== "legacy"
      ) {
        return null;
      }
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
      if (
        hasNegativeEquity(r.totalStockholdersEquity)
        && extras?.negativeEquityLeverage !== "legacy"
      ) {
        return null;
      }
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


