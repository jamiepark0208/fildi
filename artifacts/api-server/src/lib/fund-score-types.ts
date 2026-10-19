/** Shared fund-score types (A83 split from fund-score-engine). */

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
  currentPrice: number | null;
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

export type MetricDef = {
  key: MetricKey;
  family: FamilyName;
  baseIntra: number;
  higherIsBetter: boolean;
  /** Metrics excluded for these styles */
  excludeStyles?: StyleBucket[];
  /** Externally-covered metric (e.g. IBES): a null value is skipped entirely instead of shrinking coverage. */
  optional?: boolean;
};
