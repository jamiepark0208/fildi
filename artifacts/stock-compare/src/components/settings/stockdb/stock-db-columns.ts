import type { FundamentalsRow, TechnicalsRow } from "./stock-db-types";

// ── Column definitions ────────────────────────────────────────────────────────

export type FmtType = "pct" | "ratio" | "dollars" | "price" | "shares";

export interface ColDef {
  key: keyof FundamentalsRow;
  label: string;
  family: "value" | "growth" | "quality" | "safety" | "meta";
  fmt: FmtType;
  suspect?: (v: number) => boolean;
  optional?: boolean;
}

// Fields where distribution is right-skewed — log-transform before z-score
export const LOG_TRANSFORM_COLS = new Set(["peRatio", "forwardPe", "pegRatio", "priceToBook", "priceToSales", "evEbitda", "evRevenue"]);

// Growth fields where a value > 10× (1000%) indicates a near-zero prior-period base
export const NM_GROWTH_COLS = new Set(["epsGrowth", "revenueGrowthYoY", "revenueGrowthYoyPrior"]);

export const COLS: ColDef[] = [
  // VALUE — suspect only for structural impossibilities (negative prices/yields)
  { key: "peRatio",             label: "P/E",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "pegRatio",            label: "PEG",        family: "value",   fmt: "ratio",  suspect: v => v < 0 },
  { key: "forwardPe",           label: "Fwd P/E",    family: "value",   fmt: "ratio",  suspect: v => v < 0 },
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
  { key: "quarterlyOCF",        label: "Qtrly OCF",  family: "safety",  fmt: "dollars" } as unknown as ColDef,
  // RAW INPUTS
  { key: "freeCashFlow",        label: "FCF",        family: "safety",  fmt: "dollars" },
  { key: "totalRevenue",        label: "Revenue",    family: "safety",  fmt: "dollars" },
  { key: "netIncome",           label: "Net Income", family: "safety",  fmt: "dollars" },
  { key: "totalStockholdersEquity", label: "Equity", family: "safety",  fmt: "dollars" },
  { key: "sharesOutstanding",   label: "Shares",     family: "meta",    fmt: "shares" },
  { key: "sharesOutstandingPrior",label:"Shares Pr", family: "meta",    fmt: "shares" },
  { key: "beta",                label: "Beta",       family: "meta",    fmt: "ratio",  suspect: v => v > 10 || v < -5 },
  { key: "effectiveTaxRate",    label: "Tax Rate",   family: "meta",    fmt: "pct",    suspect: v => v < -0.5 || v > 1.0 },
];

(COLS.find(c => c.label === "Qtrly OCF") as ColDef).key = "quarterlyOperatingCashFlow" as keyof FundamentalsRow;

export const FAMILY_COLORS: Record<string, string> = {
  value:   "text-blue-400",
  growth:  "text-green-400",
  quality: "text-purple-400",
  safety:  "text-amber-400",
  meta:    "text-amber-200/50",
};

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
  { key: "ivRank",            label: "IV Rank",   family: "volatility", fmt: p01  },
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
  signal:     "text-red-400",
  momentum:   "text-cyan-400",
  volume:     "text-indigo-400",
  volatility: "text-orange-400",
  structure:  "text-teal-400",
};
