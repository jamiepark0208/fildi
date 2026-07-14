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

export interface LiquiditySignal {
  label: string;
  level: "supportive" | "neutral" | "draining" | "stress" | "unknown";
  readout: string;
  implication: string;
}

export interface LiquidityImplications {
  asOf: string;
  signals: LiquiditySignal[];
  overall: {
    level: "supportive" | "neutral" | "draining" | "stress" | "unknown";
    summary: string;
  };
}

export interface VolatilitySignal {
  label: string;
  level: "calm" | "normal" | "elevated" | "stress" | "unknown";
  readout: string;
  implication: string;
}

export interface VolatilityImplications {
  asOf: string;
  signals: VolatilitySignal[];
  overall: {
    level: "calm" | "normal" | "elevated" | "stress" | "unknown";
    summary: string;
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
  fedAssetsHistory: ChartPoint[];     // Fed total assets (FRED WALCL, weekly $M)
  tgaHistory: ChartPoint[];           // Treasury General Account (FRED WTREGEN, weekly $M)
  rrpHistory: ChartPoint[];           // Overnight reverse repo (FRED RRPONTSYD, daily $B)
  reservesHistory: ChartPoint[];      // Bank reserve balances (FRED WRESBAL, weekly $M)
  netLiquidityHistory: ChartPoint[];  // Derived: WALCL - TGA - RRP, weekly-aligned, $B
  sofrIorbSpreadHistory: ChartPoint[]; // Derived: SOFR - IORB, daily, bps — reserve scarcity / repo stress
  liquidityImplications: LiquidityImplications; // Synthesized regime read across the liquidity series above
  moveHistory: ChartPoint[];          // ICE BofA MOVE Index — bond market (rates) implied volatility
  volatilityImplications: VolatilityImplications; // Synthesized vol regime read across VIX/term structure/VVIX/put-call/credit/MOVE
}

export interface SectorMoverPoint {
  ticker: string;
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  rs1m: number | null;
}

export interface SectorRotationPoint {
  ticker: string;
  label: string;
  ret1d: number | null;
  ret1w: number | null;
  ret1m: number | null;
  rs1d: number | null;
  rs1w: number | null;
  rs1m: number | null;
  rs3m: number | null;
  momentum: number | null;
  quadrant: "leading" | "weakening" | "lagging" | "improving" | null;
  topMovers: SectorMoverPoint[];
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
export type MacroTab = "regime" | "liquidity" | "volatility" | "policy" | "heatmap" | "catalyst";

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