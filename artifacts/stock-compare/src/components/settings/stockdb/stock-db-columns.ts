import type { FundamentalsRow, TechnicalsRow } from "./stock-db-types";

// ── Column definitions ────────────────────────────────────────────────────────

export type FmtType = "pct" | "ratio" | "dollars" | "price" | "shares" | "text";

export interface ColDef {
  key: keyof FundamentalsRow;
  label: string;
  family: "value" | "growth" | "quality" | "safety" | "meta";
  fmt: FmtType;
  suspect?: (v: number) => boolean;
  optional?: boolean;
}

/** Split long headers onto 2 lines to shrink column width (e.g. "Fwd P/E" → Fwd / P/E). */
export function headerLines(label: string): string[] {
  const space = label.indexOf(" ");
  if (space > 0) return [label.slice(0, space), label.slice(space + 1)];
  const slash = label.indexOf("/");
  if (slash > 0 && label.length >= 6) {
    return [label.slice(0, slash + 1), label.slice(slash + 1)];
  }
  return [label];
}

// Fields where distribution is right-skewed — log-transform before z-score
export const LOG_TRANSFORM_COLS = new Set(["peRatio", "forwardPe", "pegRatio", "forwardPeg", "priceToBook", "priceToSales", "evEbitda", "evRevenue"]);

// Growth fields where a value > 10× (1000%) indicates a near-zero prior-period base
export const NM_GROWTH_COLS = new Set(["epsGrowth", "revenueGrowthYoY", "revenueGrowthYoyPrior"]);

export const COLS: ColDef[] = [
  // VALUE — suspect only for structural impossibilities (negative prices/yields)
  { key: "peRatio",             label: "P/E",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "pegRatio",            label: "PEG",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "forwardPe",           label: "Fwd P/E",    family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "forwardPeg",          label: "Fwd PEG",    family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "priceToBook",         label: "P/B",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "priceToSales",        label: "P/S",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "evEbitda",            label: "EV/EBITDA",  family: "value",   fmt: "ratio",  suspect: v => v < -200 },
  { key: "evRevenue",           label: "EV/Rev",     family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "dividendYield",       label: "Div Yield",  family: "value",   fmt: "pct",    suspect: v => v < 0 || v > 2.0 },
  // GROWTH — z-score flags outliers; N/M displayed for near-zero base (>10×)
  { key: "revenueGrowthYoY",    label: "Rev Growth", family: "growth",  fmt: "pct" },
  { key: "revenueGrowthYoyPrior",label:"Rev Gro Pr", family: "growth",  fmt: "pct" },
  { key: "epsGrowth",           label: "EPS Growth", family: "growth",  fmt: "pct" },
  { key: "analystTargetPrice",  label: "Analyst TP", family: "growth",  fmt: "price",  suspect: v => v <= 0 },
  // QUALITY — only flag values beyond economic possibility
  { key: "grossMargin",         label: "Gross Mgn",  family: "quality", fmt: "pct",    suspect: v => v > 1.5 || v < -2.0 },
  { key: "operatingMargin",     label: "Op Margin",  family: "quality", fmt: "pct",    suspect: v => v > 1.5 || v < -5.0 },
  { key: "netMargin",           label: "Net Margin", family: "quality", fmt: "pct",    suspect: v => v > 1.5 || v < -10.0 },
  { key: "returnOnEquity",      label: "ROE",        family: "quality", fmt: "pct" },
  { key: "returnOnAssets",      label: "ROA",        family: "quality", fmt: "pct" },
  { key: "roic",                label: "ROIC",       family: "quality", fmt: "pct" },
  { key: "wacc",                label: "WACC",       family: "quality", fmt: "pct",    suspect: v => v <= 0 || v > 0.8 },
  // SAFETY
  { key: "currentRatio",        label: "Curr Ratio", family: "safety",  fmt: "ratio",  suspect: v => v <= 0 },
  { key: "debtToEquity",        label: "D/E",        family: "safety",  fmt: "ratio",  suspect: v => v < 0 },
  { key: "ebitda",              label: "EBITDA",     family: "safety",  fmt: "dollars" },
  { key: "ebit",                label: "EBIT",       family: "safety",  fmt: "dollars" },
  { key: "interestExpense",     label: "Int Exp",    family: "safety",  fmt: "dollars", suspect: v => v < 0 },
  { key: "totalDebt",           label: "Total Debt", family: "safety",  fmt: "dollars" },
  { key: "cashAndEquivalents",  label: "Cash",       family: "safety",  fmt: "dollars" },
  { key: "quarterlyOperatingCashFlow", label: "Qtrly OCF", family: "safety", fmt: "dollars" },
  { key: "annualOperatingCashFlow",    label: "Ann OCF",   family: "safety", fmt: "dollars" },
  // RAW INPUTS
  { key: "freeCashFlow",        label: "FCF",        family: "safety",  fmt: "dollars" },
  { key: "totalRevenue",        label: "Revenue",    family: "safety",  fmt: "dollars" },
  { key: "grossProfit",         label: "Gross Profit", family: "safety", fmt: "dollars" },
  { key: "netIncome",           label: "Net Income", family: "safety",  fmt: "dollars" },
  { key: "totalAssets",         label: "Total Assets", family: "safety", fmt: "dollars" },
  { key: "totalStockholdersEquity", label: "Equity", family: "safety",  fmt: "dollars" },
  { key: "sharesOutstanding",   label: "Shares",     family: "meta",    fmt: "shares" },
  { key: "sharesOutstandingPrior",label:"Shares Pr", family: "meta",    fmt: "shares" },
  { key: "beta",                label: "Beta",       family: "safety",  fmt: "ratio",  suspect: v => v > 10 || v < -5 },
  { key: "effectiveTaxRate",    label: "Tax Rate",   family: "meta",    fmt: "pct",    suspect: v => v < -0.5 || v > 1.0 },
  { key: "styleBucket",         label: "Style",      family: "meta",    fmt: "text",   optional: true },
  { key: "fundTotalScore",      label: "Fund Score", family: "meta",    fmt: "ratio",  optional: true },
  { key: "fundCompanyScore",    label: "Fund Co",    family: "meta",    fmt: "ratio",  optional: true },
  { key: "fundSectorScore",     label: "Fund Sec",   family: "meta",    fmt: "ratio",  optional: true },
];

// Left accent only — label hue comes from FAMILY_LABEL in stock-db-palette.
export const FAMILY_COLORS: Record<string, string> = {
  total:   "border-l-2 border-l-[#d4af37]",
  value:   "border-l-2 border-l-sky-400",
  growth:  "border-l-2 border-l-emerald-400",
  quality: "border-l-2 border-l-violet-400",
  safety:  "border-l-2 border-l-[#d4af37]",
  meta:    "border-l-2 border-l-zinc-400",
};

export type FundFamily = ColDef["family"];

/** Persisted 0–100 family scores (+ total). Meta has no score — expand-only. */
export const FAMILY_SCORE_KEY: Record<Exclude<FundFamily, "meta"> | "total", keyof FundamentalsRow> = {
  total:   "fundTotalScore",
  value:   "fundValueScore",
  growth:  "fundGrowthScore",
  quality: "fundQualityScore",
  safety:  "fundSafetyScore",
};

export const SCORE_FAMILY_ORDER: FundFamily[] = ["value", "growth", "quality", "safety", "meta"];

/** Score keys promoted to summary columns — omit from Meta field expand. */
const META_SCORE_KEYS = new Set<keyof FundamentalsRow>([
  "fundTotalScore", "fundCompanyScore", "fundSectorScore",
  "fundValueScore", "fundQualityScore", "fundGrowthScore", "fundSafetyScore",
]);

export type VisibleFundCol =
  | { kind: "score"; id: "total" | FundFamily; key: keyof FundamentalsRow | null; label: string; family: FundFamily | "total"; expandable: boolean }
  | { kind: "field"; col: ColDef };

/** Fields shown when a family is expanded (Meta drops promoted score keys). */
export function familyFieldCols(fam: FundFamily): ColDef[] {
  return COLS.filter(c => {
    if (c.family !== fam) return false;
    if (fam === "meta" && META_SCORE_KEYS.has(c.key)) return false;
    return true;
  });
}

/** Collapsed: Total + V/G/Q/S/Meta scores. Expand one family → insert that family's field cols after its score. */
export function visibleFundCols(expanded: FundFamily | null): VisibleFundCol[] {
  const out: VisibleFundCol[] = [
    { kind: "score", id: "total", key: FAMILY_SCORE_KEY.total, label: "Total", family: "total", expandable: false },
  ];
  for (const fam of SCORE_FAMILY_ORDER) {
    const key = fam === "meta" ? null : FAMILY_SCORE_KEY[fam];
    out.push({
      kind: "score",
      id: fam,
      key,
      label: fam === "meta" ? "Meta" : fam[0].toUpperCase() + fam.slice(1),
      family: fam,
      expandable: true,
    });
    if (expanded === fam) {
      for (const col of familyFieldCols(fam)) out.push({ kind: "field", col });
    }
  }
  return out;
}

/** Fixed px widths — stops content-driven column jitter on expand. */
export const COL_W = {
  ticker: 76,
  score: 52,
  field: 58,
} as const;

export function fundTableWidthPx(cols: VisibleFundCol[]): number {
  return COL_W.ticker + cols.reduce((n, vc) => n + (vc.kind === "score" ? COL_W.score : COL_W.field), 0);
}

// ── Technicals column definitions ─────────────────────────────────────────────

export type TechFamily = "signal" | "momentum" | "volume" | "volatility" | "structure";

export interface TechColDef {
  key: keyof TechnicalsRow;
  label: string;
  family: TechFamily;
  fmt: (v: string | number | null | undefined) => string;
}

export const n1 = (v: string | number | null | undefined) => v == null ? "—" : parseFloat(String(v)).toFixed(1);
export const n2 = (v: string | number | null | undefined) => v == null ? "—" : parseFloat(String(v)).toFixed(2);
export const p1 = (v: string | number | null | undefined) => v == null ? "—" : parseFloat(String(v)).toFixed(1) + "%";
export const p01 = (v: string | number | null | undefined) => v == null ? "—" : (parseFloat(String(v)) * 100).toFixed(0) + "%";
export const txt = (v: string | number | null | undefined) => v == null ? "—" : String(v);
export const flag = (v: string | number | null | undefined) => v == null ? "—" : Number(v) === 1 ? "Yes" : "No";
export const days = (v: string | number | null | undefined) => v == null ? "—" : Math.round(Number(v)) + "d";

export const TECH_COLS: TechColDef[] = [
  // SIGNAL
  { key: "regime",            label: "Regime",    family: "signal",     fmt: txt  },
  { key: "fallingKnife",      label: "F.Knife",   family: "signal",     fmt: flag },
  { key: "earningsDaysOut",   label: "Earn.",     family: "signal",     fmt: days },
  // MOMENTUM
  { key: "rsi14",             label: "RSI",       family: "momentum",   fmt: n1   },
  { key: "mfi14",             label: "MFI",       family: "momentum",   fmt: n1   },
  { key: "stoch",             label: "Stoch %K",  family: "momentum",   fmt: n1   },
  { key: "macdDirection",     label: "MACD",      family: "momentum",   fmt: txt  },
  { key: "rsiVelocity",       label: "RSI Vel",   family: "momentum",   fmt: n2   },
  // VOLUME
  { key: "volumeRatio",       label: "Vol Ratio", family: "volume",     fmt: n2   },
  // VOLATILITY
  { key: "realizedVol20d",    label: "RVol 20d",  family: "volatility", fmt: p1   },
  { key: "ivRank",            label: "RV rank",   family: "volatility", fmt: p01  },
  { key: "atmPutIv",          label: "ATM IV",    family: "volatility", fmt: p1   },
  { key: "impliedMoveWeekly", label: "Impl Mv",   family: "volatility", fmt: p1   },
  { key: "bbWidthPct",        label: "BB Width",  family: "volatility", fmt: p01  },
  // STRUCTURE
  { key: "priceVsMa20Atr",    label: "vs MA20",   family: "structure",  fmt: n2   },
  { key: "priceVsMa50Atr",    label: "vs MA50",   family: "structure",  fmt: n2   },
  { key: "priceZScore",       label: "Z-Score",   family: "structure",  fmt: n2   },
  { key: "priceVsVwapPct",    label: "vs VWAP",   family: "structure",  fmt: p1   },
];

export const techFamilies: TechFamily[] = ["signal", "momentum", "volume", "volatility", "structure"];

export const TECH_FAMILY_COLORS: Record<TechFamily, string> = {
  signal:     "border-l-2 border-l-red-400 text-red-400",
  momentum:   "border-l-2 border-l-cyan-400 text-cyan-400",
  volume:     "border-l-2 border-l-indigo-400 text-indigo-300",
  volatility: "border-l-2 border-l-orange-400 text-orange-400",
  structure:  "border-l-2 border-l-teal-400 text-teal-300",
};
