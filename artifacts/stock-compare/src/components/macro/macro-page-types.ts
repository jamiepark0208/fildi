// Shared type definitions for the Macro dashboard page and its sub-components.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FredSeries {
  value: number | null;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  yoy: number | null;
  date: string | null;
  unit: string;
}

export interface MarketQuote {
  value: number | null;
  change: number | null;
  changePct: number | null;
}

export interface YieldCurvePoint {
  maturity: string;
  months: number;
  current: number | null;
  weekAgo: number | null;
  monthAgo: number | null;
  threeMonthAgo: number | null;
}

export interface VixCurvePoint {
  tenor: string;
  days: number;
  value: number | null;
  weekAgo: number | null;
  monthAgo: number | null;
  threeMonthAgo: number | null;
}

export interface FedFundsCurvePoint {
  label: string;
  meetingDate: string;
  impliedRate: number | null;
  weekAgo: number | null;
  monthAgo: number | null;
  threeMonthAgo: number | null;
  isTbillProxy?: boolean;
}

export interface ChartPoint {
  date: string;
  value: number;
}

export interface MacroData {
  fetchedAt: string;
  vix: MarketQuote & { level: "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" };
  yield10y: MarketQuote;
  yield2y: MarketQuote;
  yieldSpread: number | null;
  yieldCurve: YieldCurvePoint[];
  usDebt: number | null;
  skew: MarketQuote;
  vxn: MarketQuote;
  series: {
    cpi: FredSeries;
    coreCpi: FredSeries;
    corePce: FredSeries;
    unemployment: FredSeries;
    nonfarmPayrolls: FredSeries;
    jolts: FredSeries;
    gdp: FredSeries;
    ppi: FredSeries;
    retailSales: FredSeries;
    consumerSentiment: FredSeries;
    fedFundsRate: FredSeries;
    ismManufacturing: FredSeries;
  };
}

export interface MacroCharts {
  fetchedAt: string;
  vixHistory: ChartPoint[];
  fedFundsHistory: ChartPoint[];
  tenYearHistory: ChartPoint[];
  vixCurve: VixCurvePoint[];
  fedFundsCurve: FedFundsCurvePoint[];
  fearGreedHistory: ChartPoint[];
  hySpreadHistory: ChartPoint[];
  igSpreadHistory: ChartPoint[];
  putCallHistory: ChartPoint[];       // VVIX (vol of VIX)
  putCallRatioHistory: ChartPoint[];  // CBOE equity put/call ratio
  gscpiHistory: ChartPoint[];
  moneyMarketHistory: ChartPoint[];
  nfciHistory: ChartPoint[];
  copperGoldHistory: ChartPoint[];
  dxyHistory: ChartPoint[];
}

export interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
  recentChange?: string;
  photoUrl?: string;
  priority?: number;
}

export interface MacroEvent {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

export interface BankResearch {
  name: string;
  shortName: string;
  stance: "bullish" | "neutral" | "bearish";
  rateView: string;
  summary: string;
  lastUpdated: string;
}

export interface SepData {
  projections: { year: number; fedRate: number | null; gdp: number | null; unemployment: number | null; corePce: number | null }[];
  asOf: string;
}

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface IndicatorHistory {
  key: string;
  label: string;
  unit: string;
  isYoY: boolean;
  data: ChartPoint[];
}

export interface SepActuals {
  gdp: ChartPoint[];
  corePce: ChartPoint[];
  unemployment: ChartPoint[];
  fedFunds: ChartPoint[];
}

export type CurvePeriod = "current" | "1wk" | "1mo" | "3mo";
export type SepMetric = "fedRate" | "gdp" | "unemployment" | "corePce";
export type MacroTab = "regime" | "volatility" | "policy" | "heatmap" | "catalyst";

const MACRO_TABS: { id: MacroTab; label: string }[] = [
  { id: "regime",     label: "Macro & Regime Health" },
  { id: "volatility", label: "Volatility & Sentiment" },
  { id: "policy",     label: "Policy & Forward Guidance" },
  { id: "heatmap",    label: "Heatmap" },
  { id: "catalyst",   label: "Catalyst Calendar" },
];

const COT_MACRO_IDS = ["sp500", "nasdaq100", "tbonds"];

export interface COTRecord {
  date: string; instrument: string; displayName: string; dataset: "tff" | "legacy";
  openInterest: number;
  levMoneyLong: number; levMoneyShort: number; levMoneyNet: number;
  levMoneyLongChg: number; levMoneyShortChg: number;
  assetMgrLong: number; assetMgrShort: number; assetMgrNet: number;
  assetMgrLongChg: number; assetMgrShortChg: number;
  dealerLong: number; dealerShort: number; dealerNet: number;
}
export interface COTSummary {
  instrument: string; displayName: string; dataset: "tff" | "legacy";
  latest: COTRecord; history: COTRecord[]; zScore: number; stale?: boolean;
}