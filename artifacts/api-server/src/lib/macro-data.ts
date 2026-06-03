import yahooFinance from "yahoo-finance2";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

export interface FredSeries {
  value: number | null;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  date: string | null;
  unit: string;
}

export interface MarketQuote {
  value: number | null;
  change: number | null;
  changePct: number | null;
}

export interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
}

export interface MacroEvent {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

export interface MacroData {
  fetchedAt: string;
  vix: MarketQuote & { level: "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" };
  yield10y: MarketQuote;
  yield2y: MarketQuote;
  yieldSpread: number | null;
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

export const FED_MEMBERS: FedMember[] = [
  // Voting members (2025)
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
    title: "Governor",
    voting: true,
    stance: "hawkish",
    notes: "Skeptical of cuts; wants sustained disinflation progress",
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
    notes: "Sees 1-2 cuts in 2025; progress uneven",
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

function nullSeries(unit = ""): FredSeries {
  return { value: null, prev: null, change: null, changePct: null, date: null, unit };
}

export async function fetchFredLatest(seriesId: string, unit = ""): Promise<FredSeries> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (macro-data fetcher)" },
    });
    clearTimeout(timer);

    if (!res.ok) return nullSeries(unit);

    const text = await res.text();
    const lines = text.trim().split("\n").slice(1); // skip header

    const valid: { date: string; val: number }[] = [];
    for (const line of lines) {
      const [date, rawVal] = line.split(",");
      if (!rawVal || rawVal.trim() === "." || rawVal.trim() === "") continue;
      const val = parseFloat(rawVal.trim());
      if (isNaN(val)) continue;
      valid.push({ date: date.trim(), val });
    }

    if (valid.length === 0) return nullSeries(unit);

    const current = valid[valid.length - 1];
    const prev = valid.length >= 2 ? valid[valid.length - 2] : null;

    const value = current.val;
    const prevVal = prev?.val ?? null;
    const change = prevVal !== null ? value - prevVal : null;
    const changePct = prevVal !== null && prevVal !== 0 ? ((value - prevVal) / Math.abs(prevVal)) * 100 : null;

    return {
      value,
      prev: prevVal,
      change,
      changePct,
      date: current.date,
      unit,
    };
  } catch {
    return nullSeries(unit);
  }
}

function vixLevel(vix: number | null): "very-low" | "low" | "low-mid" | "mid" | "mid-high" | "high" {
  if (vix === null) return "mid";
  if (vix < 13) return "very-low";
  if (vix < 16) return "low";
  if (vix < 20) return "low-mid";
  if (vix < 25) return "mid";
  if (vix < 30) return "mid-high";
  return "high";
}

function safeQuote(q: unknown): MarketQuote {
  if (!q || typeof q !== "object") return { value: null, change: null, changePct: null };
  const r = q as Record<string, unknown>;
  return {
    value: typeof r["regularMarketPrice"] === "number" ? r["regularMarketPrice"] : null,
    change: typeof r["regularMarketChange"] === "number" ? r["regularMarketChange"] : null,
    changePct: typeof r["regularMarketChangePercent"] === "number" ? r["regularMarketChangePercent"] : null,
  };
}

export async function fetchMacroData(): Promise<MacroData> {
  const [
    vixResult,
    tnxResult,
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
    dgs2Result,
  ] = await Promise.allSettled([
    yahooFinance.quote("^VIX", {}, { validateResult: false }),
    yahooFinance.quote("^TNX", {}, { validateResult: false }),
    fetchFredLatest("CPIAUCSL", "%"),
    fetchFredLatest("CPILFESL", "%"),
    fetchFredLatest("PCEPILFE", "%"),
    fetchFredLatest("UNRATE", "%"),
    fetchFredLatest("PAYEMS", "thousands"),
    fetchFredLatest("JTSJOL", "thousands"),
    fetchFredLatest("A191RL1Q225SBEA", "%"),
    fetchFredLatest("PPIACO", "%"),
    fetchFredLatest("RSXFS", "$ billions"),
    fetchFredLatest("UMCSENT", "index"),
    fetchFredLatest("DFF", "%"),
    fetchFredLatest("DGS2", "%"),
  ]);

  const vixQuote = vixResult.status === "fulfilled" ? safeQuote(vixResult.value) : { value: null, change: null, changePct: null };
  const tnxQuote = tnxResult.status === "fulfilled" ? safeQuote(tnxResult.value) : { value: null, change: null, changePct: null };

  const dgs2Series = dgs2Result.status === "fulfilled" ? dgs2Result.value : nullSeries("%");
  const yield2y: MarketQuote = {
    value: dgs2Series.value,
    change: dgs2Series.change,
    changePct: dgs2Series.changePct,
  };

  const yield10yValue = tnxQuote.value;
  const yield2yValue = dgs2Series.value;
  const yieldSpread =
    yield10yValue !== null && yield2yValue !== null
      ? (yield10yValue - yield2yValue) * 100
      : null;

  const getSeries = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;

  return {
    fetchedAt: new Date().toISOString(),
    vix: {
      ...vixQuote,
      level: vixLevel(vixQuote.value),
    },
    yield10y: tnxQuote,
    yield2y,
    yieldSpread,
    series: {
      cpi:               getSeries(cpiResult, nullSeries("%")),
      coreCpi:           getSeries(coreCpiResult, nullSeries("%")),
      corePce:           getSeries(corePceResult, nullSeries("%")),
      unemployment:      getSeries(unemploymentResult, nullSeries("%")),
      nonfarmPayrolls:   getSeries(nonfarmResult, nullSeries("thousands")),
      jolts:             getSeries(joltsResult, nullSeries("thousands")),
      gdp:               getSeries(gdpResult, nullSeries("%")),
      ppi:               getSeries(ppiResult, nullSeries("%")),
      retailSales:       getSeries(retailResult, nullSeries("$ billions")),
      consumerSentiment: getSeries(sentimentResult, nullSeries("index")),
      fedFundsRate:      getSeries(fedFundsResult, nullSeries("%")),
    },
  };
}

const CACHE_FILE = join(ROOT, "macro-data.json");

export function loadMacroCache(): MacroData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as MacroData;
  } catch {
    return null;
  }
}

export function saveMacroCache(data: MacroData): void {
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isCacheStale(data: MacroData, ttlHours = 4): boolean {
  const fetched = new Date(data.fetchedAt).getTime();
  const now = Date.now();
  return now - fetched > ttlHours * 60 * 60 * 1000;
}
