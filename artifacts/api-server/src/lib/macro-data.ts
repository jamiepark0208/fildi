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
  yoy: number | null;       // year-over-year % change (null if not computed)
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
  maturity: string;   // "1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"
  months: number;
  current: number | null;
  monthAgo: number | null;
}

export interface MacroCharts {
  fetchedAt: string;
  vixHistory: ChartPoint[];
  fedFundsHistory: ChartPoint[];
  tenYearHistory: ChartPoint[];
}

export interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
  recentChange?: string;
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
  usDebt: number | null;      // raw FRED value in millions; display as /1_000_000 T
  skew: MarketQuote;
  vxn: MarketQuote;
  series: {
    cpi:               FredSeries;
    coreCpi:           FredSeries;
    corePce:           FredSeries;
    unemployment:      FredSeries;
    nonfarmPayrolls:   FredSeries;
    jolts:             FredSeries;
    gdp:               FredSeries;
    ppi:               FredSeries;
    retailSales:       FredSeries;
    consumerSentiment: FredSeries;
    fedFundsRate:      FredSeries;
  };
}

// ── Static Data ───────────────────────────────────────────────────────────────

export const FED_MEMBERS: FedMember[] = [
  // Voting members
  {
    name: "Jerome Powell",
    title: "Chair",
    voting: true,
    stance: "neutral",
    notes: "Data-dependent; cautious on premature cuts; inflation trajectory key",
  },
  {
    name: "Philip Jefferson",
    title: "Vice Chair",
    voting: true,
    stance: "neutral",
    notes: "Methodical; monitors core services inflation closely",
  },
  {
    name: "Michelle Bowman",
    title: "Vice Chair for Supervision",
    voting: true,
    stance: "hawkish",
    notes: "Skeptical of cuts; wants sustained disinflation progress",
    recentChange: "Confirmed as Vice Chair for Supervision (2026)",
  },
  {
    name: "Kevin Warsh",
    title: "Governor",
    voting: true,
    stance: "hawkish",
    notes: "Strong rules-based framework advocate; skeptical of QE expansion; prefers tighter balance sheet",
    recentChange: "Newly confirmed Governor (2026) — historically hawkish, close to Trump admin",
  },
  {
    name: "Lisa Cook",
    title: "Governor",
    voting: true,
    stance: "dovish",
    notes: "Labor market softening warrants measured easing",
  },
  {
    name: "Christopher Waller",
    title: "Governor",
    voting: true,
    stance: "neutral",
    notes: "Open to cuts if core PCE cooperates; market-friendly",
  },
  {
    name: "Adriana Kugler",
    title: "Governor",
    voting: true,
    stance: "dovish",
    notes: "Dual mandate balanced; labor softening supports cuts",
  },
  {
    name: "John Williams",
    title: "NY Fed President",
    voting: true,
    stance: "neutral",
    notes: "Views policy as restrictive but not excessively so",
  },
  {
    name: "Austan Goolsbee",
    title: "Chicago",
    voting: true,
    stance: "dovish",
    notes: "Disinflation on track; advocates for lower rates",
  },
  {
    name: "Susan Collins",
    title: "Boston",
    voting: true,
    stance: "neutral",
    notes: "Patient; wants durable evidence before easing",
  },
  {
    name: "Thomas Barkin",
    title: "Richmond",
    voting: true,
    stance: "neutral",
    notes: "Wants inflation durably at 2%; risk of premature cuts",
  },
  // Non-voting (influential)
  {
    name: "Alberto Musalem",
    title: "St. Louis Fed",
    voting: false,
    stance: "hawkish",
    notes: "Inflation not fully conquered; wary of easing",
  },
  {
    name: "Neel Kashkari",
    title: "Minneapolis Fed",
    voting: false,
    stance: "hawkish",
    notes: "Questions how restrictive rates really are",
  },
  {
    name: "Lorie Logan",
    title: "Dallas Fed",
    voting: false,
    stance: "hawkish",
    notes: "Financial conditions loosened too much already",
  },
  {
    name: "Raphael Bostic",
    title: "Atlanta Fed",
    voting: false,
    stance: "neutral",
    notes: "Sees 1-2 cuts in 2026; progress uneven",
  },
  {
    name: "Mary Daly",
    title: "San Francisco Fed",
    voting: false,
    stance: "neutral",
    notes: "Policy is working; patience required",
  },
  {
    name: "Jeff Schmid",
    title: "Kansas City Fed",
    voting: false,
    stance: "hawkish",
    notes: "Strong labor market reduces urgency to cut",
  },
  {
    name: "Beth Hammack",
    title: "Cleveland Fed",
    voting: false,
    stance: "neutral",
    notes: "Data-driven; needs sustained confidence inflation is falling",
  },
];

// SEP = Summary of Economic Projections (FOMC dot plot medians)
// Source: FOMC SEP March 2026 — static, update after each FOMC SEP release
export const SEP_PROJECTIONS: FedProjection[] = [
  { year: 2026, fedRate: 3.875, gdp: 1.7, unemployment: 4.5, corePce: 2.8 },
  { year: 2027, fedRate: 3.375, gdp: 1.8, unemployment: 4.4, corePce: 2.3 },
  { year: 2028, fedRate: 3.125, gdp: 1.9, unemployment: 4.3, corePce: 2.1 },
];
export const SEP_DATE = "Mar 2026";

// Bank research stances — static, update manually or via Generate endpoint
export const BANK_RESEARCH_DEFAULT: BankResearch[] = [
  {
    name: "Goldman Sachs",
    shortName: "GS",
    stance: "bullish",
    rateView: "2 cuts H2 2026",
    summary:
      "US exceptionalism intact; SPX 6,200 target. AI capex cycle sustains earnings growth. Overweight cyclicals, financials, and tech.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "JP Morgan",
    shortName: "JPM",
    stance: "neutral",
    rateView: "1–2 cuts 2026",
    summary:
      "Cautious on fiscal trajectory and tariff risk. Quality bias in equities; 35% recession probability. Dimon: long-term fiscal headwinds underappreciated.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "Bank of America",
    shortName: "BofA",
    stance: "neutral",
    rateView: "2 cuts 2026",
    summary:
      "Bull market intact but breadth narrowing. Watch unemployment rate as cut trigger. Overweight energy, healthcare, and dividend growers.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "Citi",
    shortName: "Citi",
    stance: "bullish",
    rateView: "3 cuts 2026",
    summary:
      "Most dovish on rates among majors. Global rotation theme: EM and international > US on valuation. Inflation cooling faster than Fed models.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "Morgan Stanley",
    shortName: "MS",
    stance: "neutral",
    rateView: "1 cut 2026",
    summary:
      "AI infra capex sustains tech outperformance near-term. Concerned about margin compression in S&P ex-tech. SPX 5,900 target; selective positioning.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "Barclays",
    shortName: "BARC",
    stance: "neutral",
    rateView: "2 cuts 2026",
    summary:
      "Short duration rates bias; yield curve steepener trade. Credit spreads at tight end — limited IG upside. Prefer floating-rate exposure.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "RBC Capital",
    shortName: "RBC",
    stance: "bullish",
    rateView: "2 cuts 2026",
    summary:
      "Constructive on North American equities. Energy transition capex as secular tailwind. Banks and industrials look undervalued relative to tech.",
    lastUpdated: "2026-06-01",
  },
  {
    name: "Nomura",
    shortName: "NOM",
    stance: "neutral",
    rateView: "1 cut 2026",
    summary:
      "USD/JPY normalization key risk for US Treasuries; BOJ tightening drains UST demand. Cautious on long duration. Watch JGB volatility spillover.",
    lastUpdated: "2026-06-01",
  },
];

export const ECONOMIC_EVENTS: MacroEvent[] = [
  { date: "2026-06-03", event: "ISM Manufacturing PMI", importance: "medium" },
  { date: "2026-06-04", event: "JOLTS Job Openings", importance: "high" },
  { date: "2026-06-05", event: "ADP Employment Report", importance: "high" },
  { date: "2026-06-06", event: "Nonfarm Payrolls / Unemployment Rate", importance: "high" },
  { date: "2026-06-10", event: "CPI Inflation (May)", importance: "high" },
  { date: "2026-06-11", event: "FOMC Meeting Day 1", importance: "high" },
  { date: "2026-06-12", event: "FOMC Rate Decision + Powell Press Conference", importance: "high" },
  { date: "2026-06-13", event: "PPI (May)", importance: "medium" },
  { date: "2026-06-17", event: "Retail Sales (May)", importance: "high" },
  { date: "2026-06-20", event: "U of Mich Consumer Sentiment (prelim)", importance: "medium" },
  { date: "2026-06-27", event: "PCE Price Index (May) + Personal Income/Spending", importance: "high" },
  { date: "2026-07-08", event: "JOLTS (May)", importance: "high" },
  { date: "2026-07-10", event: "CPI (June)", importance: "high" },
  { date: "2026-07-11", event: "U of Mich Consumer Sentiment (prelim)", importance: "medium" },
  { date: "2026-07-29", event: "FOMC Rate Decision", importance: "high" },
  { date: "2026-07-30", event: "PCE (June)", importance: "high" },
];

// ── Core FRED Fetch Helpers ───────────────────────────────────────────────────

function nullSeries(unit = ""): FredSeries {
  return { value: null, prev: null, change: null, changePct: null, yoy: null, date: null, unit };
}

async function fetchFredSeriesData(
  seriesId: string,
  observationStart?: string   // "YYYY-MM-DD" — limits response size dramatically for daily series
): Promise<{ date: string; val: number }[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ id: seriesId });
    if (observationStart) params.set("cosd", observationStart);
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${params.toString()}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (macro-data fetcher)" },
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

/**
 * Fetch latest value + MoM change + optional YoY.
 * periodsForYoY: 12 for monthly price-index series, 4 for quarterly, 0 to skip.
 * Monthly FRED series are small (~900 rows), so no date filtering needed.
 */
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

/** Return recent N days of a FRED series for chart sparklines. */
export async function fetchFredHistory(
  seriesId: string,
  days = 365
): Promise<ChartPoint[]> {
  // DFF is daily but small; fetch without date filter, then slice to requested range
  const valid = await fetchFredSeriesData(seriesId);
  if (valid.length === 0) return [];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return valid
    .filter((p) => new Date(p.date) >= cutoff)
    .map((p) => ({ date: p.date, value: p.val }));
}

// ── Yield Curve via Yahoo Finance ─────────────────────────────────────────────
// Uses tickers available on Yahoo: ^IRX (3M), ^FVX (5Y), ^TNX (10Y), ^TYX (30Y)
// month-ago values via yahooFinance.historical

const YAHOO_YIELD_TICKERS = [
  { ticker: "^IRX", label: "3M",  months: 3 },
  { ticker: "^FVX", label: "5Y",  months: 60 },
  { ticker: "^TNX", label: "10Y", months: 120 },
  { ticker: "^TYX", label: "30Y", months: 360 },
];

export async function fetchYieldCurve(): Promise<YieldCurvePoint[]> {
  const now = new Date();
  const monthAgoTarget = new Date(now);
  monthAgoTarget.setDate(monthAgoTarget.getDate() - 30);

  // Fetch current quotes and historical in parallel
  const results = await Promise.allSettled(
    YAHOO_YIELD_TICKERS.map(async (t) => {
      const [quote, history] = await Promise.allSettled([
        yahooFinance.quote(t.ticker, {}, { validateResult: false }),
        yahooFinance.historical(
          t.ticker,
          {
            period1: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            period2: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            interval: "1d",
          },
          { validateResult: false }
        ),
      ]);

      const current =
        quote.status === "fulfilled"
          ? (safeQuote(quote.value).value)
          : null;

      let monthAgo: number | null = null;
      if (history.status === "fulfilled" && Array.isArray(history.value) && history.value.length > 0) {
        const hist = history.value as { date: Date; close: number }[];
        // Pick the entry closest to 30 days ago
        let best = hist[0];
        let minDiff = Infinity;
        for (const h of hist) {
          const diff = Math.abs(h.date.getTime() - monthAgoTarget.getTime());
          if (diff < minDiff) { minDiff = diff; best = h; }
        }
        monthAgo = best.close;
      }

      return { maturity: t.label, months: t.months, current, monthAgo };
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { maturity: YAHOO_YIELD_TICKERS[i].label, months: YAHOO_YIELD_TICKERS[i].months, current: null, monthAgo: null }
  );
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
  ] = await Promise.allSettled([
    yahooFinance.quote("^VIX",  {}, { validateResult: false }),
    yahooFinance.quote("^TNX",  {}, { validateResult: false }),
    yahooFinance.quote("^SKEW", {}, { validateResult: false }),
    yahooFinance.quote("^VXN",  {}, { validateResult: false }),
    fetchFredLatest("CPIAUCSL",        "%",        12),   // monthly price index → YoY
    fetchFredLatest("CPILFESL",        "%",        12),
    fetchFredLatest("PCEPILFE",        "%",        12),
    fetchFredLatest("UNRATE",          "%",        0),    // already a rate
    fetchFredLatest("PAYEMS",          "thousands",0),
    fetchFredLatest("JTSJOL",          "thousands",0),
    fetchFredLatest("A191RL1Q225SBEA", "%",        0),    // already a growth rate
    fetchFredLatest("PPIACO",          "%",        12),   // monthly price index → YoY
    fetchFredLatest("RSXFS",           "$ billions",12),  // monthly dollar value → YoY
    fetchFredLatest("UMCSENT",         "index",    12),
    fetchFredLatest("DFF",             "%",        0),
    fetchFredLatest("GFDEBTN",         "$ millions",0),   // Federal Debt total
    fetchYieldCurve(),
  ]);

  const vixQuote  = vixResult.status  === "fulfilled" ? safeQuote(vixResult.value)  : { value: null, change: null, changePct: null };
  const tnxQuote  = tnxResult.status  === "fulfilled" ? safeQuote(tnxResult.value)  : { value: null, change: null, changePct: null };
  const skewQuote = skewResult.status === "fulfilled" ? safeQuote(skewResult.value) : { value: null, change: null, changePct: null };
  const vxnQuote  = vxnResult.status  === "fulfilled" ? safeQuote(vxnResult.value)  : { value: null, change: null, changePct: null };

  const yield2y: MarketQuote = { value: null, change: null, changePct: null };

  const yield10yValue = tnxQuote.value;
  const yield2yValue  = dgs2Series.value;
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
    yieldCurve: yieldCurveResult.status === "fulfilled" ? yieldCurveResult.value : [],
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
      consumerSentiment: getSeries(sentimentResult,    nullSeries("index")),
      fedFundsRate:      getSeries(fedFundsResult,     nullSeries("%")),
    },
  };
}

// ── Charts data (separate cache, longer history) ──────────────────────────────

export async function fetchMacroCharts(): Promise<MacroCharts> {
  const period1 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [vixHistResult, fedFundsHistResult, tenYearHistResult] =
    await Promise.allSettled([
      yahooFinance.historical(
        "^VIX",
        { period1, interval: "1d" },
        { validateResult: false }
      ),
      fetchFredHistory("DFF",   730),
      fetchFredHistory("DGS10", 730),
    ]);

  const vixHistory: ChartPoint[] =
    vixHistResult.status === "fulfilled"
      ? (vixHistResult.value as { date: Date; close: number }[]).map((p) => ({
          date:  p.date.toISOString().slice(0, 10),
          value: p.close,
        }))
      : [];

  return {
    fetchedAt:        new Date().toISOString(),
    vixHistory,
    fedFundsHistory:  fedFundsHistResult.status  === "fulfilled" ? fedFundsHistResult.value  : [],
    tenYearHistory:   tenYearHistResult.status   === "fulfilled" ? tenYearHistResult.value   : [],
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
    // Invalidate old cache format that lacks new fields
    if (!data.yieldCurve || data.usDebt === undefined) return null;
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

export function loadChartsCache(): MacroCharts | null {
  try {
    if (!existsSync(CHARTS_CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CHARTS_CACHE_FILE, "utf-8")) as MacroCharts;
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
