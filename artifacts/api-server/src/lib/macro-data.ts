import YahooFinanceClass from "yahoo-finance2";
const yahooFinance = new YahooFinanceClass();
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

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

export interface FedFundsCurvePoint {
  label: string;
  meetingDate: string;
  impliedRate: number | null;
  weekAgo: number | null;
  monthAgo: number | null;
  threeMonthAgo: number | null;
  isTbillProxy?: boolean;
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

export interface FedProjection {
  year: number;
  fedRate: number | null;
  gdp: number | null;
  unemployment: number | null;
  corePce: number | null;
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


// ── Core FRED Fetch Helpers ───────────────────────────────────────────────────

function nullSeries(unit = ""): FredSeries {
  return { value: null, prev: null, change: null, changePct: null, yoy: null, date: null, unit };
}

async function fetchFredSeriesData(
  seriesId: string,
  observationStart?: string
): Promise<{ date: string; val: number }[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ id: seriesId });
    if (observationStart) params.set("cosd", observationStart);
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${params.toString()}`;
    const res = await fetch(url, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.trim().split("\n").slice(1);
    const valid: { date: string; val: number }[] = [];
    for (const line of lines) {
      const [date, rawVal] = line.split(",");
      if (!rawVal || rawVal.trim() === "." || rawVal.trim() === "") continue;
      const val = parseFloat(rawVal.trim());
      if (isNaN(val)) continue;
      valid.push({ date: date.trim(), val });
    }
    return valid;
  } catch {
    return [];
  }
}

export async function fetchFredLatest(
  seriesId: string,
  unit = "",
  periodsForYoY = 0
): Promise<FredSeries> {
  const valid = await fetchFredSeriesData(seriesId);
  if (valid.length === 0) return nullSeries(unit);

  const current = valid[valid.length - 1];
  const prev = valid.length >= 2 ? valid[valid.length - 2] : null;
  const yearAgoIdx = valid.length - 1 - periodsForYoY;
  const yearAgo = periodsForYoY > 0 && yearAgoIdx >= 0 ? valid[yearAgoIdx] : null;

  const value = current.val;
  const prevVal = prev?.val ?? null;
  const change = prevVal !== null ? value - prevVal : null;
  const changePct =
    prevVal !== null && prevVal !== 0
      ? ((value - prevVal) / Math.abs(prevVal)) * 100
      : null;
  const yoy =
    yearAgo !== null && yearAgo.val !== 0
      ? ((value - yearAgo.val) / Math.abs(yearAgo.val)) * 100
      : null;

  return { value, prev: prevVal, change, changePct, yoy, date: current.date, unit };
}

export async function fetchFredHistory(
  seriesId: string,
  days = 365
): Promise<ChartPoint[]> {
  const valid = await fetchFredSeriesData(seriesId);
  if (valid.length === 0) return [];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return valid
    .filter((p) => new Date(p.date) >= cutoff)
    .map((p) => ({ date: p.date, value: p.val }));
}

/** Fetch FRED indicator history for chart, computing YoY if requested */
export async function fetchIndicatorHistory(
  seriesId: string,
  periodsForYoY = 0,
  days = 3650
): Promise<ChartPoint[]> {
  const extraDays = periodsForYoY > 0 ? 400 : 0;
  const valid = await fetchFredSeriesData(
    seriesId,
    new Date(Date.now() - (days + extraDays) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  if (valid.length === 0) return [];

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (periodsForYoY === 0) {
    return valid
      .filter((p) => new Date(p.date) >= cutoff)
      .map((p) => ({ date: p.date, value: p.val }));
  }

  // Compute YoY for price-index series
  return valid
    .filter((p, idx) => {
      const yearAgoIdx = idx - periodsForYoY;
      return new Date(p.date) >= cutoff && yearAgoIdx >= 0;
    })
    .map((p, _idx, arr) => {
      const origIdx = valid.indexOf(p);
      const yearAgoIdx = origIdx - periodsForYoY;
      const yearAgo = yearAgoIdx >= 0 ? valid[yearAgoIdx] : null;
      const yoy = yearAgo && yearAgo.val !== 0
        ? ((p.val - yearAgo.val) / Math.abs(yearAgo.val)) * 100
        : null;
      return { date: p.date, value: yoy ?? p.val };
    });
}

// ── Yield Curve via US Treasury CSV ──────────────────────────────────────────

const TREASURY_MATURITIES: { col: string; label: string; months: number }[] = [
  { col: "1 Mo",  label: "1M",  months: 1   },
  { col: "3 Mo",  label: "3M",  months: 3   },
  { col: "6 Mo",  label: "6M",  months: 6   },
  { col: "1 Yr",  label: "1Y",  months: 12  },
  { col: "2 Yr",  label: "2Y",  months: 24  },
  { col: "3 Yr",  label: "3Y",  months: 36  },
  { col: "5 Yr",  label: "5Y",  months: 60  },
  { col: "7 Yr",  label: "7Y",  months: 84  },
  { col: "10 Yr", label: "10Y", months: 120 },
  { col: "20 Yr", label: "20Y", months: 240 },
  { col: "30 Yr", label: "30Y", months: 360 },
];

async function fetchTreasuryCSV(yyyymm: string): Promise<{ headers: string[]; rows: string[][] }> {
  const year = yyyymm.slice(0, 4);
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yyyymm}&t=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return { headers: [], rows: [] };
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
    const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.replace(/"/g, "").trim()));
    return { headers, rows };
  } catch {
    clearTimeout(timer);
    return { headers: [], rows: [] };
  }
}

export async function fetchYieldCurve(): Promise<YieldCurvePoint[]> {
  const now = new Date();
  const curYYYYMM = now.toISOString().slice(0, 7).replace("-", "");

  const prevDate = new Date(now);
  prevDate.setDate(1);
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevYYYYMM = prevDate.toISOString().slice(0, 7).replace("-", "");

  const threeMonthDate = new Date(now);
  threeMonthDate.setDate(1);
  threeMonthDate.setMonth(threeMonthDate.getMonth() - 3);
  const threeMonthYYYYMM = threeMonthDate.toISOString().slice(0, 7).replace("-", "");

  const [cur, prev, threeMonth] = await Promise.allSettled([
    fetchTreasuryCSV(curYYYYMM),
    fetchTreasuryCSV(prevYYYYMM),
    fetchTreasuryCSV(threeMonthYYYYMM),
  ]);

  const curData      = cur.status      === "fulfilled" ? cur.value      : { headers: [], rows: [] };
  const prevData     = prev.status     === "fulfilled" ? prev.value     : { headers: [], rows: [] };
  const threeMonthData = threeMonth.status === "fulfilled" ? threeMonth.value : { headers: [], rows: [] };

  if (curData.rows.length === 0) return [];

  const latestRow    = curData.rows[curData.rows.length - 1];
  // ~1 week ago = ~5 trading days back in current month; if not enough rows, use earliest
  const weekAgoIdx   = Math.max(0, curData.rows.length - 6);
  const weekAgoRow   = curData.rows.length >= 2 ? curData.rows[weekAgoIdx] : null;
  const monthAgoRow  = prevData.rows.length > 0 ? prevData.rows[prevData.rows.length - 1] : null;
  const threeMonthAgoRow = threeMonthData.rows.length > 0 ? threeMonthData.rows[threeMonthData.rows.length - 1] : null;

  return TREASURY_MATURITIES.map((m) => {
    const idx = curData.headers.indexOf(m.col);
    const cur  = idx >= 0 ? parseFloat(latestRow[idx])           : NaN;
    const wk   = weekAgoRow && idx >= 0 ? parseFloat(weekAgoRow[idx])   : NaN;
    const mo   = monthAgoRow && idx >= 0 ? parseFloat(monthAgoRow[idx]) : NaN;
    const threeM = threeMonthAgoRow && idx >= 0 ? parseFloat(threeMonthAgoRow[idx]) : NaN;
    return {
      maturity:      m.label,
      months:        m.months,
      current:       isNaN(cur)    ? null : cur,
      weekAgo:       isNaN(wk)     ? null : wk,
      monthAgo:      isNaN(mo)     ? null : mo,
      threeMonthAgo: isNaN(threeM) ? null : threeM,
    };
  });
}

// ── VIX Term Structure ─────────────────────────────────────────────────────────

const VIX_TENORS = [
  { ticker: "^VXST", label: "9D",  days: 9   },
  { ticker: "^VIX",  label: "30D", days: 30  },
  { ticker: "^VIX3M", label: "93D", days: 93 },
  { ticker: "^VIX6M", label: "6M",  days: 183 },
  { ticker: "^VIX1Y", label: "1Y",  days: 365 },
];

export async function fetchVixCurve(): Promise<VixCurvePoint[]> {
  const now = new Date();
  const period1 = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    VIX_TENORS.map(async (t) => {
      const [quoteResult, chartResult] = await Promise.allSettled([
        yahooFinance.quote(t.ticker, {}, { validateResult: false }),
        yahooFinance.chart(t.ticker, { period1, interval: "1d" }, { validateResult: false }),
      ]);

      const currentValue =
        quoteResult.status === "fulfilled"
          ? (safeQuote(quoteResult.value).value)
          : null;

      const quotes =
        chartResult.status === "fulfilled"
          ? ((chartResult.value as Record<string, unknown>)?.["quotes"] as Array<{date: unknown; close: number | null}> ?? [])
          : [];

      const findClose = (daysAgo: number): number | null => {
        const target = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const targetStr = target.toISOString().slice(0, 10);
        let best: number | null = null;
        for (const q of quotes) {
          if (q.close == null) continue;
          const d = (q.date instanceof Date ? q.date : new Date(q.date as string))
            .toISOString()
            .slice(0, 10);
          if (d <= targetStr) best = q.close;
        }
        return best;
      };

      return {
        tenor: t.label,
        days: t.days,
        value: currentValue,
        weekAgo:       findClose(7),
        monthAgo:      findClose(30),
        threeMonthAgo: findClose(91),
      };
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { tenor: VIX_TENORS[i].label, days: VIX_TENORS[i].days, value: null, weekAgo: null, monthAgo: null, threeMonthAgo: null }
  );
}

// ── Fed Funds Curve (CME 30-Day Fed Funds Futures) ────────────────────────────

const MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];

// Upcoming FOMC meeting dates — update periodically
const FOMC_MEETINGS = [
  { date: "2026-06-18", label: "Jun '26", month: 5,  year: 2026 },
  { date: "2026-07-29", label: "Jul '26", month: 6,  year: 2026 },
  { date: "2026-09-17", label: "Sep '26", month: 8,  year: 2026 },
  { date: "2026-10-29", label: "Oct '26", month: 9,  year: 2026 },
  { date: "2026-12-10", label: "Dec '26", month: 11, year: 2026 },
  { date: "2027-01-28", label: "Jan '27", month: 0,  year: 2027 },
  { date: "2027-03-19", label: "Mar '27", month: 2,  year: 2027 },
  { date: "2027-05-06", label: "May '27", month: 4,  year: 2027 },
  { date: "2027-07-29", label: "Jul '27", month: 6,  year: 2027 },
];

function getZQTicker(month: number, year: number): string {
  const code = MONTH_CODES[month];
  const yy = year % 100;
  return `ZQ${code}${yy < 10 ? "0" + yy : yy}.CBT`;
}

export async function fetchFedFundsCurve(): Promise<FedFundsCurvePoint[]> {
  const now = new Date();
  const upcoming = FOMC_MEETINGS.filter((m) => new Date(m.date) >= now).slice(0, 7);
  if (upcoming.length === 0) return [];

  const period1 = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    upcoming.map(async (m) => {
      const ticker = getZQTicker(m.month, m.year);
      const [quoteResult, chartResult] = await Promise.allSettled([
        yahooFinance.quote(ticker, {}, { validateResult: false }),
        yahooFinance.chart(ticker, { period1, interval: "1d" }, { validateResult: false }),
      ]);

      const price =
        quoteResult.status === "fulfilled"
          ? (quoteResult.value as Record<string, unknown>)?.["regularMarketPrice"] as number | null
          : null;
      const impliedRate = price != null ? parseFloat((100 - price).toFixed(3)) : null;

      const quotes =
        chartResult.status === "fulfilled"
          ? ((chartResult.value as Record<string, unknown>)?.["quotes"] as Array<{date: unknown; close: number | null}> ?? [])
          : [];

      const findHistRate = (daysAgo: number): number | null => {
        const target = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const targetStr = target.toISOString().slice(0, 10);
        let best: number | null = null;
        for (const q of quotes) {
          if (q.close == null) continue;
          const d = (q.date instanceof Date ? q.date : new Date(q.date as string))
            .toISOString()
            .slice(0, 10);
          if (d <= targetStr) best = parseFloat((100 - q.close).toFixed(3));
        }
        return best;
      };

      return {
        label:         m.label,
        meetingDate:   m.date,
        impliedRate,
        weekAgo:       findHistRate(7),
        monthAgo:      findHistRate(30),
        threeMonthAgo: findHistRate(91),
        isTbillProxy:  false,
      };
    })
  );

  const points: FedFundsCurvePoint[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          label: upcoming[i].label,
          meetingDate: upcoming[i].date,
          impliedRate: null,
          weekAgo: null,
          monthAgo: null,
          threeMonthAgo: null,
          isTbillProxy: false,
        }
  );

  // If all futures are null (Yahoo Finance doesn't have ZQ), fall back to Treasury short-end
  const hasData = points.some((p) => p.impliedRate != null);
  if (!hasData) {
    // Use Treasury yield curve short-end as proxy
    try {
      const curve = await fetchYieldCurve();
      const tenorMap: Record<string, string> = {
        "1M": "Jun '26", "3M": "Jul '26", "6M": "Sep '26", "1Y": "Dec '26",
      };
      return curve
        .filter((c) => tenorMap[c.maturity])
        .map((c) => ({
          label:         tenorMap[c.maturity],
          meetingDate:   "",
          impliedRate:   c.current,
          weekAgo:       c.weekAgo,
          monthAgo:      c.monthAgo,
          threeMonthAgo: c.threeMonthAgo,
          isTbillProxy:  true,
        }));
    } catch {
      return points;
    }
  }

  return points;
}

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

function safeQuote(q: unknown): MarketQuote {
  if (!q || typeof q !== "object")
    return { value: null, change: null, changePct: null };
  const r = q as Record<string, unknown>;
  return {
    value:     typeof r["regularMarketPrice"]         === "number" ? r["regularMarketPrice"]         : null,
    change:    typeof r["regularMarketChange"]        === "number" ? r["regularMarketChange"]        : null,
    changePct: typeof r["regularMarketChangePercent"] === "number" ? r["regularMarketChangePercent"] : null,
  };
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
      ismManufacturing:   getSeries(ismResult,          nullSeries("index")),
    },
  };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────
// Replaces Promise.allSettled for external HTTP calls — runs at most `limit`
// tasks at once so we don't exhaust sockets on Replit's free tier.
async function allSettledLimited<T>(
  thunks: (() => Promise<T>)[],
  concurrency = 5
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await thunks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Charts data ───────────────────────────────────────────────────────────────

export async function fetchMacroCharts(): Promise<MacroCharts> {
  const period1 = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);

  const chartToPoints = (result: PromiseSettledResult<unknown>): ChartPoint[] => {
    if (result.status !== "fulfilled") return [];
    const quotes = (result.value as { quotes?: { date: unknown; close: number | null }[] })?.quotes ?? [];
    return quotes
      .filter((q) => q.close != null)
      .map((q) => ({
        date:  (q.date instanceof Date ? q.date : new Date(q.date as string)).toISOString().slice(0, 10),
        value: q.close as number,
      }));
  };

  const fetchFredCSV = async (seriesId: string): Promise<ChartPoint[]> => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    if (text.trimStart().startsWith("<")) return []; // guard against HTML error pages
    const lines = text.trim().split("\n");
    // skip header row (could be "DATE,..." or "observation_date,...")
    return lines.slice(1).flatMap(line => {
      const [date, val] = line.trim().split(",");
      const v = parseFloat(val);
      return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(v) ? [{ date, value: v }] : [];
    });
  };

  const fetchFearGreed = async (): Promise<ChartPoint[]> => {
    const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.cnn.com/",
        "Accept": "application/json",
      },
    });
    const json = await res.json() as { fear_and_greed_historical?: { data?: { x: number; y: number }[] } };
    const raw = json.fear_and_greed_historical?.data ?? [];
    return raw.map(p => ({
      date:  new Date(p.x).toISOString().slice(0, 10),
      value: parseFloat(p.y.toFixed(1)),
    }));
  };

  // CBOE equity put/call ratio via Yahoo Finance ^PCCE (more reliable than CBOE CDN)
  const fetchCboePutCall = async (): Promise<ChartPoint[]> => {
    const r = await Promise.allSettled([
      yahooFinance.chart("^PCCE", { period1, interval: "1d" }, { validateResult: false }),
    ]);
    return chartToPoints(r[0]);
  };

  // NY Fed GSCPI via FRED series (more reliable than NY Fed direct CDN)
  const fetchGSCPI = async (): Promise<ChartPoint[]> => {
    return fetchFredCSV("GSCPI");
  };

  const fetchCopperGold = async (): Promise<ChartPoint[]> => {
    const [cuResult, gcResult] = await Promise.allSettled([
      yahooFinance.chart("HG=F", { period1, interval: "1d" }, { validateResult: false }),
      yahooFinance.chart("GC=F", { period1, interval: "1d" }, { validateResult: false }),
    ]);
    if (cuResult.status !== "fulfilled" || gcResult.status !== "fulfilled") return [];
    const cuPoints = chartToPoints(cuResult);
    const gcMap = new Map(chartToPoints(gcResult).map(p => [p.date, p.value]));
    return cuPoints
      .filter(p => gcMap.has(p.date) && gcMap.get(p.date)! > 0)
      .map(p => ({ date: p.date, value: parseFloat((p.value / gcMap.get(p.date)!).toFixed(6)) }));
  };

  const [vixResult, irxResult, tnxResult, vixCurveResult, ffCurveResult,
         hyResult, igResult, vvixResult, fearGreedResult,
         putCallResult, gscpiResult, moneyMarketResult,
         nfciResult, copperGoldResult, dxyResult] = await allSettledLimited([
    () => yahooFinance.chart("^VIX",    { period1, interval: "1d" }, { validateResult: false }),
    () => yahooFinance.chart("^IRX",    { period1, interval: "1d" }, { validateResult: false }),
    () => yahooFinance.chart("^TNX",    { period1, interval: "1d" }, { validateResult: false }),
    () => fetchVixCurve(),
    () => fetchFedFundsCurve(),
    () => fetchFredCSV("BAMLH0A0HYM2"), // ICE BofA HY OAS spread
    () => fetchFredCSV("BAMLC0A0CM"),   // ICE BofA IG OAS spread
    () => yahooFinance.chart("^VVIX",   { period1, interval: "1d" }, { validateResult: false }),
    () => fetchFearGreed(),
    () => fetchCboePutCall(),
    () => fetchGSCPI(),
    () => fetchFredCSV("MMMFNS"),
    () => fetchFredCSV("NFCI"),
    () => fetchCopperGold(),
    () => yahooFinance.chart("DX-Y.NYB", { period1, interval: "1d" }, { validateResult: false }),
  ], 5);

  return {
    fetchedAt:             new Date().toISOString(),
    vixHistory:            chartToPoints(vixResult),
    fedFundsHistory:       chartToPoints(irxResult),
    tenYearHistory:        chartToPoints(tnxResult),
    vixCurve:              vixCurveResult.status === "fulfilled" ? vixCurveResult.value : [],
    fedFundsCurve:         ffCurveResult.status  === "fulfilled" ? ffCurveResult.value  : [],
    hySpreadHistory:       hyResult.status        === "fulfilled" ? hyResult.value       : [],
    igSpreadHistory:       igResult.status        === "fulfilled" ? igResult.value       : [],
    putCallHistory:        chartToPoints(vvixResult),
    fearGreedHistory:      fearGreedResult.status === "fulfilled" ? fearGreedResult.value : [],
    putCallRatioHistory:   putCallResult.status   === "fulfilled" ? putCallResult.value  : [],
    gscpiHistory:          gscpiResult.status     === "fulfilled" ? gscpiResult.value    : [],
    moneyMarketHistory:    moneyMarketResult.status === "fulfilled" ? moneyMarketResult.value : [],
    nfciHistory:           nfciResult.status       === "fulfilled" ? nfciResult.value    : [],
    copperGoldHistory:     copperGoldResult.status === "fulfilled" ? copperGoldResult.value : [],
    dxyHistory:            chartToPoints(dxyResult),
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_FILE        = join(ROOT, "macro-data.json");
const CHARTS_CACHE_FILE = join(ROOT, "macro-charts.json");

export function loadMacroCache(): MacroData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw  = readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as MacroData;
    if (!data.yieldCurve || data.usDebt === undefined) return null;
    // Invalidate if yield curve doesn't have new weekAgo field
    if (data.yieldCurve.length > 0 && !("weekAgo" in data.yieldCurve[0])) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveMacroCache(data: MacroData): void {
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isCacheStale(data: MacroData, ttlHours = 4): boolean {
  return Date.now() - new Date(data.fetchedAt).getTime() > ttlHours * 3_600_000;
}

export const MACRO_DATA_TTL_MS    = 4  * 3_600_000; // 4h
export const MACRO_CHARTS_TTL_MS  = 4  * 3_600_000; // 4h — daily/weekly series; refreshes intraday

export function loadChartsCache(): MacroCharts | null {
  try {
    if (!existsSync(CHARTS_CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CHARTS_CACHE_FILE, "utf-8")) as MacroCharts;
    if (!data.vixCurve || !data.fedFundsCurve) return null;
    if (!data.hySpreadHistory || !data.putCallHistory || !data.fearGreedHistory) return null;
    if (!("putCallRatioHistory" in data) || !("gscpiHistory" in data) || !("moneyMarketHistory" in data)) return null;
    if (!("igSpreadHistory" in data) || !("nfciHistory" in data) || !("copperGoldHistory" in data) || !("dxyHistory" in data)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveChartsCache(data: MacroCharts): void {
  writeFileSync(CHARTS_CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isChartsCacheStale(data: MacroCharts, ttlHours = 4): boolean {
  return Date.now() - new Date(data.fetchedAt).getTime() > ttlHours * 3_600_000;
}
