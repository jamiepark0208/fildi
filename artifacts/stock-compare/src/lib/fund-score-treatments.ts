/**
 * Live fundamental score catalog for Scorecard Guide.
 * Must match artifacts/api-server/src/lib/fund-score-engine.ts (METRICS + STYLE_FAMILY_WEIGHTS).
 * Persisted scores use this — NOT FAMILY_PRESETS.PUT_SELLER / editable admin presets.
 */
export type StyleBucket =
  | "value"
  | "growth"
  | "blend"
  | "garp"
  | "quality_defensive"
  | "pre_revenue"
  | "financial";

export type FamilyName = "value" | "growth" | "quality" | "safety";

export const STYLE_FAMILY_WEIGHTS: Record<StyleBucket, Record<FamilyName, number>> = {
  value: { value: 35, growth: 15, quality: 30, safety: 20 },
  growth: { value: 14, growth: 35, quality: 33, safety: 18 },
  garp: { value: 25, growth: 28, quality: 32, safety: 15 },
  blend: { value: 25, growth: 25, quality: 30, safety: 20 },
  quality_defensive: { value: 15, growth: 15, quality: 40, safety: 30 },
  pre_revenue: { value: 5, growth: 40, quality: 25, safety: 30 },
  financial: { value: 25, growth: 15, quality: 30, safety: 30 },
};

export const CROSS_SECTION_BLEND = {
  peer: 0.55,
  sector: 0.3,
  universe: 0.15,
  /** Whole % for UI — never float * 100 in JSX (0.55 → 55.000…1). */
  pct(w: number) {
    return Math.round(w * 100);
  },
};

/** Final total blend after family scores + post-gates. */
export const SECTOR_OPPORTUNITY_LAYER = {
  weight: 0.1,
  components: { size: 0.5, prospects: 0.3, cheap: 0.2 },
};

export type EngineMetric = {
  key: string;
  label: string;
  family: FamilyName;
  baseIntra: number;
  higherIsBetter: boolean;
  goldInputs: string;
  treatment: string;
};

/** Exact metric set scored by fund-score-engine (base intra-weights). */
export const ENGINE_METRICS: EngineMetric[] = [
  { key: "earningsYield", label: "Earnings Yield", family: "value", baseIntra: 3, higherIsBetter: true, goldInputs: "netIncome / marketCap", treatment: "Exclude pre-rev & unprofitable; haircut cyclical/distress" },
  { key: "fcfYield", label: "FCF Yield", family: "value", baseIntra: 3, higherIsBetter: true, goldInputs: "freeCashFlow / marketCap", treatment: "↑ value style; ↑ REIT/cyclical" },
  { key: "ps", label: "Price / Sales", family: "value", baseIntra: 1.5, higherIsBetter: false, goldInputs: "priceToSales", treatment: "Haircut if distressed" },
  { key: "peg", label: "PEG", family: "value", baseIntra: 2, higherIsBetter: false, goldInputs: "pegRatio (derived)", treatment: "Exclude pre-rev & unprofitable; ↑ growth/garp" },
  { key: "fwdpe", label: "Forward P/E", family: "value", baseIntra: 2, higherIsBetter: false, goldInputs: "forwardPe", treatment: "Exclude pre-rev" },
  { key: "evEbitda", label: "EV / EBITDA", family: "value", baseIntra: 2, higherIsBetter: false, goldInputs: "evEbitda", treatment: "↑ value; ↑ cyclical" },
  { key: "evRev", label: "EV / Revenue", family: "value", baseIntra: 1, higherIsBetter: false, goldInputs: "evRevenue", treatment: "Kept for unprofitable operators" },
  { key: "pb", label: "Price / Book", family: "value", baseIntra: 1, higherIsBetter: false, goldInputs: "priceToBook", treatment: "↑ financials; downweight when P/TBV present; exclude if PB<0" },
  { key: "ptbv", label: "Price / TBV", family: "value", baseIntra: 2, higherIsBetter: false, goldInputs: "mcap / (tbvps × shares)", treatment: "Financials only; ↑ bank value signal" },
  { key: "pFfo", label: "Price / FFO", family: "value", baseIntra: 2.5, higherIsBetter: false, goldInputs: "mcap / (NI + D&A)", treatment: "REITs only; ↑ vs NI yield" },
  { key: "expEy", label: "Expected EY", family: "value", baseIntra: 3.5, higherIsBetter: true, goldInputs: "1/fwdPE or NI×(1+g_cap)/mcap", treatment: "Universe-heavy blend; growth capped at 35%" },
  { key: "divy", label: "Dividend Yield", family: "value", baseIntra: 1, higherIsBetter: true, goldInputs: "dividendYield", treatment: "↑ REIT & financial" },

  { key: "revgrow", label: "Revenue Growth", family: "growth", baseIntra: 2.5, higherIsBetter: true, goldInputs: "revenueGrowthYoY", treatment: "↑ growth/pre-rev (×1.15); ↓ value; clamped ±100%" },
  { key: "revaccel", label: "Revenue Accel", family: "growth", baseIntra: 2, higherIsBetter: true, goldInputs: "revGrowth − prior", treatment: "—" },
  { key: "epsgrow", label: "EPS Growth", family: "growth", baseIntra: 2.5, higherIsBetter: true, goldInputs: "epsGrowth", treatment: "Exclude unprofitable; tilt ×1.15 growth; clamped ±100%" },
  { key: "upside", label: "Analyst Upside", family: "growth", baseIntra: 1, higherIsBetter: true, goldInputs: "target/price − 1", treatment: "Capped weight" },
  { key: "avgEpsSurprise", label: "Avg EPS Surprise", family: "growth", baseIntra: 1, higherIsBetter: true, goldInputs: "earnings_calendar", treatment: "—" },
  { key: "ibesSue", label: "IBES SUE", family: "growth", baseIntra: 0, higherIsBetter: true, goldInputs: "wrds_research.ibes_surpsum avg ≤4", treatment: "Weight 0 since A25 F1 (lab IC ≈ 0); kept for display. LSEG/StarMine stay display-only (not in fund_score)." },
  { key: "ibesRevBreadth", label: "IBES Rev Breadth", family: "growth", baseIntra: 1.5, higherIsBetter: true, goldInputs: "wrds_research.ibes_statsum (numup−numdown)/n", treatment: "Optional (same coverage fix as ibesFwdGrowth): no IBES = skipped, not missing." },
  { key: "ibesFwdGrowth", label: "Fwd EPS Growth (FY1→FY2)", family: "growth", baseIntra: 2.5, higherIsBetter: true, goldInputs: "wrds_research.ibes_statsum FY2/FY1 − 1, same statpers, ≤120d", treatment: "fund-1.1.0. Optional: no IBES coverage = skipped (no coverage shrink). Null when FY1 jumps >25% while FY2 <10% (one-off). Evidence: research/fair_value/FACTOR_STUDY.md." },

  { key: "grossmgn", label: "Gross Margin", family: "quality", baseIntra: 2, higherIsBetter: true, goldInputs: "grossMargin", treatment: "↑ quality/garp/growth" },
  { key: "operatingmgn", label: "Operating Margin", family: "quality", baseIntra: 2.25, higherIsBetter: true, goldInputs: "operatingMargin", treatment: "↑ quality/garp/growth" },
  { key: "netmgn", label: "Net Margin", family: "quality", baseIntra: 3.25, higherIsBetter: true, goldInputs: "netMargin or NI/rev", treatment: "Exclude REIT; ↑ growth-quality" },
  { key: "roe", label: "ROE", family: "quality", baseIntra: 2, higherIsBetter: true, goldInputs: "returnOnEquity", treatment: "↑ financial; haircut Chinese" },
  { key: "fcfmgn", label: "FCF Margin", family: "quality", baseIntra: 2.25, higherIsBetter: true, goldInputs: "FCF / revenue", treatment: "↑ REIT / growth-quality" },
  { key: "roicwacc", label: "ROIC − WACC", family: "quality", baseIntra: 1.5, higherIsBetter: true, goldInputs: "roic − wacc", treatment: "Exclude REIT; haircut Chinese" },
  { key: "gpa", label: "Gross Profitability", family: "quality", baseIntra: 2, higherIsBetter: true, goldInputs: "grossProfit / totalAssets", treatment: "Needs gold assets" },
  { key: "accruals", label: "Accruals Ratio", family: "quality", baseIntra: 2, higherIsBetter: false, goldInputs: "(NI−OCF)/assets", treatment: "Needs assets + annual OCF" },
  { key: "fScore", label: "Piotroski F-Score", family: "quality", baseIntra: 2, higherIsBetter: true, goldInputs: "derived signals", treatment: "Partial without history priors" },

  { key: "cashrun", label: "Cash Runway", family: "safety", baseIntra: 3, higherIsBetter: true, goldInputs: "cash / |qOCF|", treatment: "↓ financial; ↑ Chinese/distress/pre-rev" },
  { key: "intcov", label: "Interest Coverage", family: "safety", baseIntra: 2.5, higherIsBetter: true, goldInputs: "ebit / interest", treatment: "—" },
  { key: "dilution", label: "Dilution Rate", family: "safety", baseIntra: 2, higherIsBetter: false, goldInputs: "Δ shares", treatment: "↑ growth/pre-rev/Chinese/distress" },
  { key: "cr", label: "Current Ratio", family: "safety", baseIntra: 1.5, higherIsBetter: true, goldInputs: "currentRatio", treatment: "Exclude banks; ↑ distress" },
  { key: "de", label: "Debt / Equity", family: "safety", baseIntra: 1, higherIsBetter: false, goldInputs: "debtToEquity", treatment: "Exclude all financials" },
  { key: "netDebtEbitda", label: "Net Debt / EBITDA", family: "safety", baseIntra: 2, higherIsBetter: false, goldInputs: "(debt−cash)/EBITDA", treatment: "Exclude all financials" },
  { key: "beta", label: "Beta", family: "safety", baseIntra: 1.5, higherIsBetter: false, goldInputs: "beta (capped 3.5)", treatment: "↑ Chinese weight; fills safety coverage" },
  { key: "netCashAssets", label: "Net Cash / Assets", family: "safety", baseIntra: 2, higherIsBetter: true, goldInputs: "(cash−debt)/assets", treatment: "Solvency; ↑ Chinese" },
];

export const ENGINE_BY_KEY: Record<string, EngineMetric> = Object.fromEntries(
  ENGINE_METRICS.map((m) => [m.key, m]),
);

/** Compact labels for Breakdown Value/Growth/Quality/Safety columns (avoid truncate “…”). */
const SCORE_SHORT_LABEL: Record<string, string> = {
  earningsYield: "Earn Yld",
  fcfYield: "FCF Yld",
  ps: "P/S",
  peg: "PEG",
  fwdpe: "Fwd P/E",
  evEbitda: "EV/EBITDA",
  evRev: "EV/Rev",
  pb: "P/B",
  ptbv: "P/TBV",
  pFfo: "P/FFO",
  expEy: "Exp EY",
  divy: "Div Yld",
  revgrow: "Rev Grow",
  revaccel: "Rev Accel",
  epsgrow: "EPS Grow",
  upside: "Upside",
  avgEpsSurprise: "EPS Surpr",
  ibesSue: "IBES SUE",
  ibesRevBreadth: "Rev Breadth",
  ibesFwdGrowth: "Fwd EPS G",
  grossmgn: "Gross Mgn",
  operatingmgn: "Op Mgn",
  netmgn: "Net Mgn",
  roe: "ROE",
  fcfmgn: "FCF Mgn",
  roicwacc: "ROIC−WACC",
  gpa: "Gross Prof",
  accruals: "Accruals",
  fScore: "F-Score",
  cashrun: "Cash Run",
  intcov: "Int Cov",
  dilution: "Dilution",
  cr: "Curr Rat",
  de: "D/E",
  netDebtEbitda: "ND/EBITDA",
  beta: "Beta",
  netCashAssets: "Net Cash",
};

/** Plain-English hover tips — what the number means (peer pN explained separately). */
const SCORE_TIP: Record<string, string> = {
  epsgrow: "Year-over-year EPS growth used in the growth score.",
  ibesRevBreadth: "Analyst revision breadth from IBES: (upgrades − downgrades) ÷ # estimates. Positive = more raises than cuts.",
  ibesFwdGrowth: "Street forward EPS growth: FY2 consensus ÷ FY1 − 1.",
  ibesSue: "IBES standardized unexpected earnings (SUE). Display-weighted near zero in the live score.",
  netmgn: "Net income ÷ revenue (net margin) in the quality score.",
  fcfmgn: "Free cash flow ÷ revenue (cash conversion of sales).",
  cashrun: "Cash runway in quarters: cash ÷ |quarterly operating cash burn|. Higher = more runway.",
  intcov: "Interest coverage: EBIT ÷ interest expense. Higher = easier to service debt.",
  accruals: "Accruals ratio (NI − OCF) ÷ assets. Higher often means weaker earnings quality.",
  fScore: "Piotroski F-Score (0–9 style checklist of balance-sheet / profitability improvements).",
  revaccel: "Change in revenue growth vs the prior period (acceleration).",
  gpa: "Gross profitability: gross profit ÷ total assets.",
  roicwacc: "ROIC minus WACC — economic spread after cost of capital.",
  netDebtEbitda: "Net debt ÷ EBITDA. Lower = less leverage vs earnings.",
  netCashAssets: "(Cash − debt) ÷ assets. Higher = more net cash on the balance sheet.",
  dilution: "Share-count growth rate. Higher = more dilution (worse for safety).",
  expEy: "Expected earnings yield from forward estimates (model input).",
  avgEpsSurprise: "Average recent EPS surprise vs consensus.",
};

/** Short label + tooltip for score-evidence rows (topMetrics keys). */
export function scoreMetricUi(key: string): { label: string; tip: string } {
  const m = ENGINE_BY_KEY[key];
  const label = SCORE_SHORT_LABEL[key] ?? m?.label ?? key;
  const tip =
    SCORE_TIP[key]
    ?? (m ? `${m.label}. Inputs: ${m.goldInputs}.` : key);
  return { label, tip };
}

export type TreatmentStep = {
  id: string;
  title: string;
  detector: string;
  action: string;
  metricEffects: string[];
};

export const TREATMENT_FLOW: TreatmentStep[] = [
  {
    id: "pre_revenue",
    title: "Pre-revenue / pre-scale",
    detector: "Little or no revenue, or tiny revenue and still losing money",
    action: "Use pre-revenue style — drop earnings yield, PEG, forward P/E",
    metricEffects: [
      `Weights: value ${STYLE_FAMILY_WEIGHTS.pre_revenue.value}% · growth ${STYLE_FAMILY_WEIGHTS.pre_revenue.growth}% · quality ${STYLE_FAMILY_WEIGHTS.pre_revenue.quality}% · safety ${STYLE_FAMILY_WEIGHTS.pre_revenue.safety}%`,
    ],
  },
  {
    id: "financial",
    title: "Banks, insurers, REITs",
    detector: "Financial scoring mode or peer path",
    action: "Financial style — bank/REIT metrics instead of industrial leverage",
    metricEffects: [
      "Drop D/E and net debt/EBITDA; banks also drop current ratio",
      "REITs lean on div yield, FCF, P/FFO; banks lean on ROE, P/B, P/TBV",
    ],
  },
  {
    id: "unprofitable",
    title: "Unprofitable but operating",
    detector: "Real revenue, negative net income",
    action: "Growth/blend style — never score as cheap on P/E",
    metricEffects: ["Drop earnings yield, PEG, EPS growth"],
  },
  {
    id: "style_norms",
    title: "Value / growth / GARP / quality / blend",
    detector: "How cheap vs how fast it grows vs peers",
    action: "Pick a style; family weights follow the table below",
    metricEffects: [],
  },
  {
    id: "mode_tilts",
    title: "Cyclical, Chinese ADR, distress",
    detector: "Energy/mining/semi · Chinese · balance-sheet stress",
    action: "Same style; nudge individual metrics (and China −10% on total)",
    metricEffects: [],
  },
  {
    id: "post_gates",
    title: "Final caps",
    detector: "After family blend",
    action: "Clip extremes so thin or speculative names cannot print fake highs",
    metricEffects: [
      "Speculative / micro-revenue capped at 55",
      "Megacaps lean more on quality",
      "Thin safety coverage → neutral prior (or unrank)",
    ],
  },
];

export const SCORE_PIPELINE_STEPS = [
  "Pull fundamentals + peer group",
  "Build metrics (skip blanks; cap wild growth/PEG)",
  `Rank vs peers (${CROSS_SECTION_BLEND.pct(CROSS_SECTION_BLEND.peer)}%), sector (${CROSS_SECTION_BLEND.pct(CROSS_SECTION_BLEND.sector)}%), and all stocks (${CROSS_SECTION_BLEND.pct(CROSS_SECTION_BLEND.universe)}%)`,
  "Pick a style → apply family weights + exclusions",
  `Blend in ${CROSS_SECTION_BLEND.pct(SECTOR_OPPORTUNITY_LAYER.weight)}% peer-group opportunity → save total score`,
];

export const SPECIALTY_GAP_NOTES = [
  { want: "Bank CET1 / NIM / NPL", status: "Paid data only", interim: "Use P/TBV + ROE for now" },
  { want: "REIT AFFO", status: "FFO proxy only", interim: "P/FFO from NI + D&A" },
  { want: "Insurance combined ratio", status: "Paid data only", interim: "ROE + P/TBV" },
];
