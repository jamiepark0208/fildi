import type {
  MacroData, FedMember, BankResearch, MacroEvent, LiquiditySignal, VolatilitySignal,
} from "./macro-page-types";

// ── Formatting ─────────────────────────────────────────────────────────────────

export const fmt = (v: number | null | undefined, dec = 2) =>
  v != null ? v.toFixed(dec) : "—";

export const fmtPct = (v: number | null, dec = 1) =>
  v != null ? `${v.toFixed(dec)}%` : "—";

export const fmtK = (v: number | null) =>
  v != null ? v.toLocaleString() + "K" : "—";

export const fmtB = (v: number | null) =>
  v != null ? `$${(v / 1000).toFixed(1)}B` : "—";

export const fmtDate = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const fmtTs = (s: string) =>
  new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const fmtMonthYear = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" });

export const changeColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

export const inflColor = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-red-400" : v < 0 ? "text-green-400" : "text-muted-foreground";

export function fmtCot(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── VIX helpers ────────────────────────────────────────────────────────────────

export const VIX_LEVEL_LABELS: Record<MacroData["vix"]["level"], string> = {
  "very-low": "Very Low",
  low:        "Low",
  "low-mid":  "Low-Mid",
  mid:        "Mid",
  "mid-high": "Mid-High",
  high:       "High",
};

export function vixBadgeClass(level: MacroData["vix"]["level"]) {
  switch (level) {
    case "very-low":
    case "low":      return "bg-green-900/50 text-green-300 border-green-700";
    case "low-mid":
    case "mid":      return "bg-yellow-900/50 text-yellow-300 border-yellow-700";
    case "mid-high":
    case "high":     return "bg-red-900/50 text-red-300 border-red-700";
    default:         return "";
  }
}

// ── Stance helpers ─────────────────────────────────────────────────────────────

export function stanceBadgeClass(stance: FedMember["stance"] | BankResearch["stance"]) {
  if (stance === "hawkish" || stance === "bearish")
    return "bg-red-900/60 text-red-200";
  if (stance === "dovish" || stance === "bullish")
    return "bg-green-900/60 text-green-200";
  return "bg-yellow-900/60 text-yellow-200";
}

export function stanceLabel(stance: FedMember["stance"] | BankResearch["stance"]) {
  return stance.charAt(0).toUpperCase() + stance.slice(1);
}

// ── Indicator highlight helpers ────────────────────────────────────────────────

export function getIndicatorHighlight(
  label: string,
  dateStr: string | null,
  events: MacroEvent[],
  todayStr: string
): "recent" | "upcoming" | null {
  if (dateStr) {
    const d = new Date(dateStr + "T12:00:00").getTime();
    const t = new Date(todayStr + "T12:00:00").getTime();
    if (d <= t && t - d <= 7 * 24 * 60 * 60 * 1000) return "recent";
  }
  const nextWeekStr = new Date(new Date(todayStr + "T12:00:00").getTime() + 7 * 86400_000)
    .toISOString().slice(0, 10);
  const lbl = label.toLowerCase();
  const match = events.some((e) => {
    if (e.date < todayStr || e.date > nextWeekStr) return false;
    const ev = e.event.toLowerCase();
    return (
      (lbl.includes("cpi") && ev.includes("cpi") && !lbl.includes("core")) ||
      (lbl.includes("core cpi") && ev.includes("cpi")) ||
      (lbl.includes("pce") && (ev.includes("pce") || ev.includes("pcepilfe"))) ||
      (lbl.includes("ppi") && ev.includes("ppi")) ||
      (lbl.includes("unemployment") && ev.includes("unemployment")) ||
      (lbl.includes("payroll") && ev.includes("payroll")) ||
      (lbl.includes("jolts") && ev.includes("jolts")) ||
      (lbl.includes("gdp") && ev.includes("gdp")) ||
      (lbl.includes("retail") && ev.includes("retail")) ||
      (lbl.includes("sentiment") && ev.includes("sentiment"))
    );
  });
  return match ? "upcoming" : null;
}

// ── Event importance / indicator matching ──────────────────────────────────────

export function importanceBadgeClass(imp: MacroEvent["importance"]) {
  switch (imp) {
    case "high":   return "bg-amber-900/60 text-amber-200";
    case "medium": return "bg-blue-900/60 text-blue-200";
    case "low":    return "bg-secondary text-muted-foreground";
  }
}

// Event text → INDICATOR_SERIES key, for click-through to the Regime tab's indicator history.
// Matched by substring against MacroEvent.event; first match wins. Events with no match render
// as plain (non-clickable) rows — e.g. generic Fed-speak or press-conference entries.
const EVENT_INDICATOR_MAP: [string, string][] = [
  ["Core PCE", "corePce"],
  ["PCE", "corePce"],
  ["Core CPI", "coreCpi"],
  ["CPI", "cpi"],
  ["PPI", "ppi"],
  ["Nonfarm Payrolls", "nonfarmPayrolls"],
  ["JOLTS", "jolts"],
  ["Unemployment", "unemployment"],
  ["GDP", "gdp"],
  ["Retail Sales", "retailSales"],
  ["Consumer Sentiment", "consumerSentiment"],
  ["ISM Manufacturing", "ismManufacturing"],
  ["FOMC", "fedFundsRate"],
];

export function matchEventIndicatorKey(eventText: string): string | undefined {
  return EVENT_INDICATOR_MAP.find(([needle]) => eventText.includes(needle))?.[1];
}

// ── Shared level → style/label maps (Liquidity / Volatility read-cards + COT) ──

export const LIQUIDITY_LEVEL_STYLE: Record<LiquiditySignal["level"], { dot: string; text: string; badge: string }> = {
  supportive: { dot: "bg-green-400",  text: "text-green-400",  badge: "border-green-500/40 bg-green-500/10 text-green-400" },
  neutral:    { dot: "bg-slate-400",  text: "text-slate-300",  badge: "border-slate-500/40 bg-slate-500/10 text-slate-300" },
  draining:   { dot: "bg-orange-400", text: "text-orange-400", badge: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
  stress:     { dot: "bg-red-400",    text: "text-red-400",    badge: "border-red-500/40 bg-red-500/10 text-red-400" },
  unknown:    { dot: "bg-slate-500",  text: "text-muted-foreground", badge: "border-border text-muted-foreground" },
};

export const LIQUIDITY_LEVEL_LABEL: Record<LiquiditySignal["level"], string> = {
  supportive: "Supportive",
  neutral: "Neutral",
  draining: "Draining",
  stress: "Stress",
  unknown: "Unknown",
};

export const VOLATILITY_LEVEL_STYLE: Record<VolatilitySignal["level"], { dot: string; text: string; badge: string }> = {
  calm:     { dot: "bg-green-400",  text: "text-green-400",  badge: "border-green-500/40 bg-green-500/10 text-green-400" },
  normal:   { dot: "bg-slate-400",  text: "text-slate-300",  badge: "border-slate-500/40 bg-slate-500/10 text-slate-300" },
  elevated: { dot: "bg-orange-400", text: "text-orange-400", badge: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
  stress:   { dot: "bg-red-400",    text: "text-red-400",    badge: "border-red-500/40 bg-red-500/10 text-red-400" },
  unknown:  { dot: "bg-slate-500",  text: "text-muted-foreground", badge: "border-border text-muted-foreground" },
};

export const VOLATILITY_LEVEL_LABEL: Record<VolatilitySignal["level"], string> = {
  calm: "Calm",
  normal: "Normal",
  elevated: "Elevated",
  stress: "Stress",
  unknown: "Unknown",
};
