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

export type SubTabHue = "sky" | "violet" | "amber" | "orange" | "emerald" | "rose" | "gold";

/** Idle = white (never zinc grey). Also re-exported from score-explain-format when that lands. */
export const SUB_TAB_IDLE = "text-white/80 hover:text-white hover:bg-white/10";

export function subTabOn(hue: SubTabHue): string {
  switch (hue) {
    case "sky": return "bg-sky-400 text-black";
    case "violet": return "bg-violet-400 text-black";
    case "amber": return "bg-amber-300 text-black";
    case "orange": return "bg-orange-400 text-black";
    case "emerald": return "bg-emerald-400 text-black";
    case "rose": return "bg-rose-400 text-black";
    case "gold": return "bg-[#d4af37] text-black";
  }
}

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

/** Radix TabsList shell — one row, gold border, no wrap (Scorecard / street panels). */
export const RADIX_TAB_LIST =
  "inline-flex h-7 items-center justify-start gap-0.5 p-0.5 w-full overflow-x-auto overflow-y-hidden whitespace-nowrap rounded bg-zinc-950 border border-[#d4af37]/20 text-white";

/**
 * Radix TabsTrigger — L2 gold when active (data-state), white idle.
 * Prefer this over per-file TAB constants (A305).
 */
export const RADIX_TAB_TRIGGER = cn(
  "inline-flex items-center justify-center whitespace-nowrap rounded px-2.5 h-6 text-[11px] font-semibold transition-colors",
  "text-white/80 hover:text-white hover:bg-white/10",
  "data-[state=active]:bg-[#d4af37] data-[state=active]:text-black",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/50",
  "disabled:pointer-events-none disabled:opacity-50",
);
