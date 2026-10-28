/**
 * Tab chrome hierarchy (Live / Rankings / Macro / Scorecard Guide):
 *
 *   L1  page tabs     — `subTabClass(active, hue, "md")`  colored fill when on
 *   L2  section tabs  — `guideSubTabClass(active)`         gold fill when on
 *   L3  dig / row     — `subTabClass(active, hue, "sm")`   small colored pills
 *
 * Idle = white (never zinc grey). Tables/headers: GRID_* in score-explain-format.
 */
import { cn } from "@/lib/utils";
import { SUB_TAB_IDLE, subTabOn } from "@/lib/score-explain-format";

export type SubTabHue = "sky" | "violet" | "amber" | "orange" | "emerald" | "rose" | "gold";

export function subTabClass(active: boolean, hue: SubTabHue, size: "sm" | "md" = "sm"): string {
  return cn(
    size === "sm"
      ? "text-[10px] font-bold px-2 py-0.5 rounded transition-colors"
      : "text-[11px] font-semibold px-2.5 h-6 rounded transition-colors",
    active ? subTabOn(hue) : SUB_TAB_IDLE,
  );
}

/** Rankings L1 — one hue each (match Live Market/Macro/News). */
export const RANKINGS_TAB_HUE: Record<string, SubTabHue> = {
  fundamental: "sky",
  technical: "violet",
  options: "amber",
  strategies: "orange",
  ladder: "emerald",
  rules: "rose",
};

/** Macro page section tabs — match Live Market/News strip (colored on, white idle). */
export const MACRO_TAB_HUE: Record<string, SubTabHue> = {
  themes: "gold",
  regime: "violet",
  liquidity: "sky",
  volatility: "amber",
  policy: "orange",
  heatmap: "emerald",
  calendar: "rose",
  scenario: "gold",
};

/** Live › Market section strip (side × mode). */
export const LIVE_MARKET_TAB_HUE: Record<string, SubTabHue> = {
  puts: "emerald",
  oversold: "sky",
  calls: "rose",
  overbought: "amber",
};

/** Live › News / Alerts section strips. */
export const LIVE_NEWS_TAB_HUE: Record<string, SubTabHue> = {
  daily: "amber",
  inbox: "sky",
};

export const LIVE_ALERTS_TAB_HUE: Record<string, SubTabHue> = {
  book: "rose",
  manage: "orange",
};

/**
 * L2 section tabs — gold on / white idle.
 * Live Market (Sell Puts · Oversold…), Scorecard Fund·Tech·Options, Rankings scope pairs.
 */
export function guideSubTabClass(active: boolean): string {
  return cn(
    "text-[11px] font-semibold px-2.5 h-6 rounded transition-colors",
    active ? "bg-[#d4af37] text-black" : SUB_TAB_IDLE,
  );
}

/** L2 paired toggles (Watchlist|Overall, Sell Puts|Calls). Same chrome as Live L2. */
export function scopePairClass(active: boolean): string {
  return guideSubTabClass(active);
}
