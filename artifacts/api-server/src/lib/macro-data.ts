import { yahooFinance } from "./yahoo-client.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

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

export interface ChartPoint {
  date: string;
  value: number;
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

export interface SectorMoverPoint {
  ticker: string;
  ret1d: number | null;      // raw 1-day price return, percent
  ret1w: number | null;      // raw 1-week price return, percent
  ret1m: number | null;      // raw 1-month price return, percent
  rs1m: number | null;       // 1m return vs SPY, percentage points
}

export interface SectorRotationPoint {
  ticker: string;
  label: string;
  ret1d: number | null;      // raw sector (ETF) 1-day price return, percent — heatmap tile color
  ret1w: number | null;      // raw sector 1-week price return, percent — heatmap tile color
  ret1m: number | null;      // raw sector 1-month price return, percent — heatmap tile color
  rs1d: number | null;       // 1-day return vs SPY, percentage points — catches same-day news moves
  rs1w: number | null;       // 1-week return vs SPY, percentage points
  rs1m: number | null;       // 1m return vs SPY, percentage points
  rs3m: number | null;       // 3m return vs SPY, percentage points
  momentum: number | null;   // rs1m - rs3m: is relative strength accelerating
  quadrant: "leading" | "weakening" | "lagging" | "improving" | null;
  topMovers: SectorMoverPoint[]; // notable large-cap names in this sector, same rs1m calc
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

export interface LiquiditySignal {
  label: string;                                    // e.g. "Net Liquidity"
  level: "supportive" | "neutral" | "draining" | "stress" | "unknown";
  readout: string;                                   // e.g. "+$180B over 3mo"
  implication: string;                               // plain-language, what it means for risk assets
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
  label: string;                                    // e.g. "VIX Term Structure"
  level: "calm" | "normal" | "elevated" | "stress" | "unknown";
  readout: string;                                   // e.g. "Backwardation: -2.1pts (30D > 3M)"
  implication: string;                               // plain-language, what it means for vol positioning
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
  igSpreadHistory: ChartPoint[];      // ICE BofA IG OAS (BAMLC0A0CM)
  putCallHistory: ChartPoint[];       // VVIX (vol of VIX)
  putCallRatioHistory: ChartPoint[];  // CBOE equity put/call ratio
  gscpiHistory: ChartPoint[];         // NY Fed Global Supply Chain Pressure Index
  moneyMarketHistory: ChartPoint[];   // Money market fund total assets (FRED MMMFNS)
  nfciHistory: ChartPoint[];          // Chicago Fed National Financial Conditions Index
  copperGoldHistory: ChartPoint[];    // Copper/Gold ratio (HG=F / GC=F)
  dxyHistory: ChartPoint[];           // US Dollar Index (DX-Y.NYB)
  fedAssetsHistory: ChartPoint[];     // Fed total assets (FRED WALCL, weekly $M)
  tgaHistory: ChartPoint[];           // Treasury General Account (FRED WTREGEN, weekly $B)
  rrpHistory: ChartPoint[];           // Overnight reverse repo (FRED RRPONTSYD, daily $B)
  reservesHistory: ChartPoint[];      // Bank reserve balances (FRED WRESBAL, weekly $B)
  netLiquidityHistory: ChartPoint[];  // Derived: WALCL - TGA - RRP, weekly-aligned, $B
  sofrIorbSpreadHistory: ChartPoint[]; // Derived: SOFR - IORB, daily, bps — reserve scarcity / repo stress
  liquidityImplications: LiquidityImplications; // Synthesized regime read across the liquidity series above
  moveHistory: ChartPoint[];          // ICE BofA MOVE Index — bond market (rates) implied volatility
  volatilityImplications: VolatilityImplications; // Synthesized vol regime read across VIX/term structure/VVIX/put-call/credit/MOVE
}

// Moved to macro-shared-types.ts to break the macro-data ⇄ macro-static cycle;
// re-exported here so existing imports keep working.
export type { FedMember, MacroEvent, BankResearch, FedProjection } from "./macro-shared-types.js";

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
    cpi:                FredSeries;
    coreCpi:            FredSeries;
    corePce:            FredSeries;
    unemployment:       FredSeries;
    nonfarmPayrolls:    FredSeries;
    jolts:              FredSeries;
    gdp:                FredSeries;
    ppi:                FredSeries;
    retailSales:        FredSeries;
    consumerSentiment:  FredSeries;
    fedFundsRate:       FredSeries;
    sofr:               FredSeries;
    ismManufacturing:   FredSeries;
  };
}

// ── Static Data (moved to macro-static.ts) ───────────────────────────────────
export {
  FED_MEMBERS,
  SEP_PROJECTIONS,
  SEP_DATE,
  BANK_RESEARCH_DEFAULT,
  ECONOMIC_EVENTS,
  INDICATOR_SERIES,
} from "./macro-static.js";

// ── Submodules (extracted from this file — see .claude/skills/data-agent.md) ──
import { allSettledLimited, safeQuote } from "./macro/macro-utils.js";
import { nullSeries, fetchFredLatest } from "./macro/macro-fred.js";
import { fetchYieldCurve } from "./macro/macro-yields.js";

export { allSettledLimited, safeQuote } from "./macro/macro-utils.js";
export { nullSeries, fetchFredLatest, fetchFredHistory, fetchIndicatorHistory } from "./macro/macro-fred.js";
export { fetchYieldCurve } from "./macro/macro-yields.js";
export { fetchVixCurve } from "./macro/macro-vix.js";
export { fetchSectorRotation } from "./macro/macro-sectors.js";
export { fetchFedFundsCurve } from "./macro/macro-fed-funds.js";
export { computeLiquidityImplications } from "./macro/macro-liquidity.js";
export { computeVolatilityImplications } from "./macro/macro-volatility.js";
export { fetchMacroCharts } from "./macro/macro-charts.js";
export {
  loadMacroCache,
  saveMacroCache,
  isCacheStale,
  MACRO_DATA_TTL_MS,
  MACRO_CHARTS_TTL_MS,
  loadChartsCache,
  saveChartsCache,
  isChartsCacheStale,
} from "./macro/macro-cache.js";

// ── Market quote helpers ──────────────────────────────────────────────────────

function vixLevel(
  vix: number | null
): "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" {
  if (vix === null) return "mid";
  if (vix < 13) return "very-low";
  if (vix < 16) return "low";
  if (vix < 20) return "low-mid";
  if (vix < 25) return "mid";
  if (vix < 30) return "mid-high";
  return "high";
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchMacroData(): Promise<MacroData> {
  const [
    vixResult,
    tnxResult,
    skewResult,
    vxnResult,
    cpiResult,
    coreCpiResult,
    corePceResult,
    unemploymentResult,
    nonfarmResult,
    joltsResult,
    gdpResult,
    ppiResult,
    retailResult,
    sentimentResult,
    fedFundsResult,
    usDebtResult,
    yieldCurveResult,
    ismResult,
    sofrResult,
  ] = await allSettledLimited([
    () => yahooFinance.quote("^VIX",  {}, { validateResult: false }),
    () => yahooFinance.quote("^TNX",  {}, { validateResult: false }),
    () => yahooFinance.quote("^SKEW", {}, { validateResult: false }),
    () => yahooFinance.quote("^VXN",  {}, { validateResult: false }),
    () => fetchFredLatest("CPIAUCSL",        "%",        12),
    () => fetchFredLatest("CPILFESL",        "%",        12),
    () => fetchFredLatest("PCEPILFE",        "%",        12),
    () => fetchFredLatest("UNRATE",          "%",        0),
    () => fetchFredLatest("PAYEMS",          "thousands",0),
    () => fetchFredLatest("JTSJOL",          "thousands",0),
    () => fetchFredLatest("A191RL1Q225SBEA", "%",        0),
    () => fetchFredLatest("PPIACO",          "%",        12),
    () => fetchFredLatest("RSXFS",           "$ billions",12),
    () => fetchFredLatest("UMCSENT",         "index",    12),
    () => fetchFredLatest("DFF",             "%",        0),
    () => fetchFredLatest("GFDEBTN",         "$ millions",0),
    () => fetchYieldCurve(),
    () => fetchFredLatest("NAPM",            "index",    0),
    () => fetchFredLatest("SOFR",            "%",        0),
  ], 6);

  const vixQuote  = vixResult.status  === "fulfilled" ? safeQuote(vixResult.value)  : { value: null, change: null, changePct: null };
  const tnxQuote  = tnxResult.status  === "fulfilled" ? safeQuote(tnxResult.value)  : { value: null, change: null, changePct: null };
  const skewQuote = skewResult.status === "fulfilled" ? safeQuote(skewResult.value) : { value: null, change: null, changePct: null };
  const vxnQuote  = vxnResult.status  === "fulfilled" ? safeQuote(vxnResult.value)  : { value: null, change: null, changePct: null };

  const yieldCurveData: YieldCurvePoint[] =
    yieldCurveResult.status === "fulfilled" ? yieldCurveResult.value : [];

  const yield2yPoint = yieldCurveData.find((p) => p.maturity === "2Y");
  const yield2y: MarketQuote = {
    value: yield2yPoint?.current ?? null,
    change: null,
    changePct: null,
  };

  const yield10yValue = tnxQuote.value;
  const yield2yValue  = yield2y.value;
  const yieldSpread =
    yield10yValue !== null && yield2yValue !== null
      ? (yield10yValue - yield2yValue) * 100
      : null;

  const getSeries = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;

  const usDebtSeries = usDebtResult.status === "fulfilled" ? usDebtResult.value : nullSeries("$ millions");

  return {
    fetchedAt: new Date().toISOString(),
    vix: { ...vixQuote, level: vixLevel(vixQuote.value) },
    yield10y:   tnxQuote,
    yield2y,
    yieldSpread,
    yieldCurve: yieldCurveData,
    usDebt:     usDebtSeries.value,
    skew:       skewQuote,
    vxn:        vxnQuote,
    series: {
      cpi:               getSeries(cpiResult,          nullSeries("%")),
      coreCpi:           getSeries(coreCpiResult,      nullSeries("%")),
      corePce:           getSeries(corePceResult,      nullSeries("%")),
      unemployment:      getSeries(unemploymentResult, nullSeries("%")),
      nonfarmPayrolls:   getSeries(nonfarmResult,      nullSeries("thousands")),
      jolts:             getSeries(joltsResult,        nullSeries("thousands")),
      gdp:               getSeries(gdpResult,          nullSeries("%")),
      ppi:               getSeries(ppiResult,          nullSeries("%")),
      retailSales:       getSeries(retailResult,       nullSeries("$ billions")),
      consumerSentiment:  getSeries(sentimentResult,    nullSeries("index")),
      fedFundsRate:       getSeries(fedFundsResult,     nullSeries("%")),
      sofr:               getSeries(sofrResult,         nullSeries("%")),
      ismManufacturing:   getSeries(ismResult,          nullSeries("index")),
    },
  };
}
