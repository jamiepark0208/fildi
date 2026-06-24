// Static / manually-maintained macro data — Fed members, SEP projections, bank research,
// economic event calendar, and FRED series registry.
// Update these after each FOMC meeting, SEP release, or calendar refresh.
import type { FedMember, FedProjection, BankResearch, MacroEvent } from "./macro-data.js";

export const FED_MEMBERS: FedMember[] = [
  // ── Voting members ──────────────────────────────────────────────────────────
  {
    name: "Kevin Warsh",
    title: "Chair (Designate / Governor)",
    voting: true,
    stance: "hawkish",
    priority: 100,
    notes: "Strong rules-based framework advocate; skeptical of QE expansion; prefers tighter balance sheet",
    recentChange: "Nominated as next Fed Chair by Trump (2026); historically hawkish",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/warsh.jpg",
  },
  {
    name: "Jerome Powell",
    title: "Chair",
    voting: true,
    stance: "neutral",
    notes: "Data-dependent; cautious on premature cuts; inflation trajectory key",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/powell.jpg",
  },
  {
    name: "Philip Jefferson",
    title: "Vice Chair",
    voting: true,
    stance: "neutral",
    notes: "Methodical; monitors core services inflation closely",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/jefferson.jpg",
  },
  {
    name: "Michelle Bowman",
    title: "Vice Chair for Supervision",
    voting: true,
    stance: "hawkish",
    notes: "Skeptical of cuts; wants sustained disinflation progress",
    recentChange: "Confirmed as Vice Chair for Supervision (2026)",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/bowman.jpg",
  },
  {
    name: "Lisa Cook",
    title: "Governor",
    voting: true,
    stance: "dovish",
    notes: "Labor market softening warrants measured easing",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/cook.jpg",
  },
  {
    name: "Christopher Waller",
    title: "Governor",
    voting: true,
    stance: "neutral",
    notes: "Open to cuts if core PCE cooperates; market-friendly",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/waller.jpg",
  },
  {
    name: "Adriana Kugler",
    title: "Governor",
    voting: true,
    stance: "dovish",
    notes: "Dual mandate balanced; labor softening supports cuts",
    photoUrl: "https://www.federalreserve.gov/aboutthefed/bios/board/images/kugler.jpg",
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
    title: "Chicago Fed",
    voting: true,
    stance: "dovish",
    notes: "Disinflation on track; advocates for lower rates",
  },
  {
    name: "Susan Collins",
    title: "Boston Fed",
    voting: true,
    stance: "neutral",
    notes: "Patient; wants durable evidence before easing",
  },
  {
    name: "Thomas Barkin",
    title: "Richmond Fed",
    voting: true,
    stance: "neutral",
    notes: "Wants inflation durably at 2%; risk of premature cuts",
  },
  // ── Non-voting (influential) ─────────────────────────────────────────────────
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
// Source: FOMC SEP March 2026 — update after each FOMC SEP release
export const SEP_PROJECTIONS: FedProjection[] = [
  { year: 2026, fedRate: 3.875, gdp: 1.7, unemployment: 4.5, corePce: 2.8 },
  { year: 2027, fedRate: 3.375, gdp: 1.8, unemployment: 4.4, corePce: 2.3 },
  { year: 2028, fedRate: 3.125, gdp: 1.9, unemployment: 4.3, corePce: 2.1 },
];
export const SEP_DATE = "Mar 2026";

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

export const INDICATOR_SERIES: Record<string, { id: string; label: string; unit: string; isYoY?: boolean }> = {
  cpi:               { id: "CPIAUCSL",        label: "CPI",              unit: "Index", isYoY: true },
  coreCpi:           { id: "CPILFESL",        label: "Core CPI",         unit: "Index", isYoY: true },
  corePce:           { id: "PCEPILFE",        label: "Core PCE",         unit: "Index", isYoY: true },
  ppi:               { id: "PPIACO",          label: "PPI",              unit: "Index", isYoY: true },
  unemployment:      { id: "UNRATE",          label: "Unemployment",     unit: "%" },
  nonfarmPayrolls:   { id: "PAYEMS",          label: "Nonfarm Payrolls", unit: "Thousands" },
  jolts:             { id: "JTSJOL",          label: "JOLTS Openings",   unit: "Thousands" },
  gdp:               { id: "A191RL1Q225SBEA", label: "Real GDP (annl.)", unit: "%" },
  retailSales:       { id: "RSXFS",           label: "Retail Sales",     unit: "$B" },
  consumerSentiment: { id: "UMCSENT",         label: "Cons. Sentiment",  unit: "Index" },
  fedFundsRate:      { id: "DFF",             label: "Fed Funds Rate",   unit: "%" },
};
