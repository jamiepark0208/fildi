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
  note: "Default 55% peer + 30% sector + 15% universe. Soft peers (chinese/speculative/<8) and expEy use heavier sector/universe. Megacaps get 25% universe.",
};

/** Final total blend after family scores + post-gates. */
export const SECTOR_OPPORTUNITY_LAYER = {
  weight: 0.1,
  components: { size: 0.5, prospects: 0.3, cheap: 0.2 },
  note: "final = 90% company + 10% peer-group opportunity (size / prospects / 1÷PE). Speculative groups size-haircut ×0.5. Persisted as fund_company_score + fund_sector_score; fund_total_score is blended.",
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
    title: "True pre-revenue / pre-scale",
    detector: "Revenue null/≤0, OR revenue <$50M and NI < 0",
    action: "Style = pre_revenue (group mode pre_revenue_ok alone never forces this)",
    metricEffects: [
      "Exclude: earningsYield, PEG, Fwd P/E",
      `Family: V${STYLE_FAMILY_WEIGHTS.pre_revenue.value} G${STYLE_FAMILY_WEIGHTS.pre_revenue.growth} Q${STYLE_FAMILY_WEIGHTS.pre_revenue.quality} S${STYLE_FAMILY_WEIGHTS.pre_revenue.safety}`,
    ],
  },
  {
    id: "financial",
    title: "Financial (bank / insurance / REIT / broker)",
    detector: "scoring_mode ∈ financial|insurance|reit|financial_mixed OR peer path match",
    action: "Style = financial",
    metricEffects: [
      "Exclude: D/E, Net Debt/EBITDA; banks also exclude Current Ratio",
      "REITs: exclude Net Margin & ROIC−WACC; ↑ Div Yield, FCF, P/FFO",
      "↑ ROE, P/B, P/TBV (Finnhub TBVPS); CET1/combined still paid-only",
    ],
  },
  {
    id: "unprofitable",
    title: "Unprofitable operator",
    detector: "Revenue ≥ $50M and NI < 0",
    action: "Style growth/blend — never value via cheap P/E",
    metricEffects: ["Exclude: earningsYield, PEG, EPS growth"],
  },
  {
    id: "style_norms",
    title: "Value / Growth / GARP / Quality / Blend",
    detector: "Cross-section value vs growth norms (peer+sector+universe blend)",
    action: "Assign style from v/g thresholds",
    metricEffects: Object.entries(STYLE_FAMILY_WEIGHTS)
      .filter(([k]) => !["pre_revenue", "financial"].includes(k))
      .map(([k, w]) => `${k}: V${w.value} G${w.growth} Q${w.quality} S${w.safety}`),
  },
  {
    id: "mode_tilts",
    title: "Cyclical / Chinese / Distress tilts",
    detector: "energy|mining|semi/memory · chinese · PB<0 or CR<0.5",
    action: "Style unchanged; intra-metric multipliers",
    metricEffects: [
      "Cyclical/semi: EY/ROE/margins haircut; EV/EBITDA & expEy ↑",
      "Chinese: ROE/ROIC/PEG ↓; runway/FCF/beta/netCash/expEy ↑; total ×0.90",
      "Distress: EY/PB/PS ×0.4; runway/CR/dilution ×1.5",
    ],
  },
  {
    id: "post_gates",
    title: "Post-score gates (v3)",
    detector: "After family blend",
    action: "Cap / haircut / require safety",
    metricEffects: [
      "Growth capped ±100% for scoring; PEG floored at 0.25",
      "expEy = 1/fwdPE or NI×(1+g≤35%)/mcap — universe-heavy norms",
      "Missing safety → prior 38 (or unrank if coverage <15%)",
      "Speculative/micro-rev total capped at 55",
      "P/S total haircut OFF (mult=1) — P/S already in value family (no double-count)",
      "Megacap (≥$200B): blend-style uses V15/G20/Q40/S25; plus total = 0.72×total + 0.28×Q when Q≥48",
      "Yields: prefer 1/PE; reject fwdPE<5; null NI/FCF÷mcap if |yield|>25% (ADR currency)",
    ],
  },
];

export const SCORE_PIPELINE_STEPS = [
  "Load gold fundamentals + primary peer group + scoring_mode",
  "Compute raw metrics (nulls skipped; growth/PEG outlier caps)",
  "Normalize inside peer_group_members (winsorize 2/98)",
  "Normalize inside sector (peer_group_id prefix) when ≥3 names",
  "Normalize vs full universe",
  `Blend cross-section: default ${CROSS_SECTION_BLEND.peer * 100}/${CROSS_SECTION_BLEND.sector * 100}/${CROSS_SECTION_BLEND.universe * 100} peer/sector/universe (soft peers & expEy heavier sector/universe)`,
  "Blend with own history (70/30 peer-hist helper)",
  "Assign style via TREATMENT_FLOW; apply exclusions + intra tilts",
  "Family blend via STYLE_FAMILY_WEIGHTS[style]; safety prior if thin; speculative/China/megacap post-gates",
  `Sector opportunity layer (${SECTOR_OPPORTUNITY_LAYER.weight * 100}%): peer-group size/prospects/cheapness → blend into total; persist company+sector+total`,
];

export const SPECIALTY_GAP_NOTES = [
  {
    want: "CET1 / NIM / NPL",
    status: "Not on free FMP/Finnhub/Yahoo/EDGAR",
    interim: "P/TBV + ROE + exclude structural leverage",
  },
  {
    want: "FFO / AFFO",
    status: "AFFO still missing; FFO proxy wired",
    interim: "ffoProxy = NI + EDGAR D&A → pFfo metric for REITs",
  },
  {
    want: "Combined ratio",
    status: "Not on free APIs",
    interim: "ROE + P/TBV for insurers until paid feed",
  },
  {
    want: "P/TBV",
    status: "Wired — Finnhub/FMP TBVPS → gold → ptbv (financials only)",
    interim: "CET1 still paid-only; P/TBV is the free-tier bank value signal",
  },
];
