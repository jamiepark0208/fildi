/**
 * Sub-tabs — one segmented control (shadcn / Vercel dark tabs).
 *
 *   Track   `SUB_TAB_BAR`   one recessed group
 *   Segment `subTabClass`   white text; selected segment is raised
 *
 * Idle stays white. Tables/headers: GRID_* in score-explain-format.
 */
import { cn } from "@/lib/utils";

export type SubTabHue =
  | "sky" | "violet" | "amber" | "orange" | "emerald" | "rose" | "gold"
  | "cyan" | "fuchsia" | "lime" | "teal";

/** The track. Slate, so it is not the page black or the nav. */
export const SUB_TAB_BAR =
  "inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-slate-800 p-1";

const TAB_SEGMENT =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium leading-none transition-colors";

/** Idle segment: white, no box of its own. */
export const SUB_TAB_IDLE = "bg-transparent text-white hover:bg-white/10";

/** Selected segment when a row has no per-tab hue. */
export const SUB_TAB_ON = "bg-[#d4af37] text-black shadow-sm";

export function subTabOn(hue: SubTabHue): string {
  switch (hue) {
    case "sky": return "bg-sky-400 text-black shadow-sm";
    case "violet": return "bg-violet-400 text-black shadow-sm";
    case "amber": return "bg-amber-300 text-black shadow-sm";
    case "orange": return "bg-orange-400 text-black shadow-sm";
    case "emerald": return "bg-emerald-400 text-black shadow-sm";
    case "rose": return "bg-rose-400 text-black shadow-sm";
    case "gold": return "bg-[#d4af37] text-black shadow-sm";
    case "cyan": return "bg-cyan-400 text-black shadow-sm";
    case "fuchsia": return "bg-fuchsia-400 text-black shadow-sm";
    case "lime": return "bg-lime-400 text-black shadow-sm";
    case "teal": return "bg-teal-400 text-black shadow-sm";
  }
}

export function subTabClass(active: boolean, _hue: SubTabHue, _size: "sm" | "md" = "sm"): string {
  return cn(TAB_SEGMENT, active ? SUB_TAB_ON : SUB_TAB_IDLE);
}

/** Rankings L1 — one hue each (match Live Market/Macro/News). */
export const RANKINGS_TAB_HUE: Record<string, SubTabHue> = {
  total: "gold",
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
  return cn(TAB_SEGMENT, active ? SUB_TAB_ON : SUB_TAB_IDLE);
}

/** L2 paired toggles (Watchlist|Overall, Sell Puts|Calls). Same chrome as Live L2. */
export function scopePairClass(active: boolean): string {
  return guideSubTabClass(active);
}

/**
 * Settings chrome ladder (nav is TopNav near-black):
 *   L1 settings tabs  — zinc-900 (lighter than nav)
 *   L2 Fund/Tech/Opt  — zinc-800 (lighter than L1), full-bleed, flush under L1
 * Both bars share the same height (h-9) so L1/L2 read as one ladder.
 */
const SETTINGS_BAR_BASE =
  "shrink-0 h-9 flex items-center border-b border-[#d4af37]/20 px-4";
export const SETTINGS_L1_BAR = `${SETTINGS_BAR_BASE} bg-zinc-900`;
export const SETTINGS_L2_BAR = `${SETTINGS_BAR_BASE} bg-zinc-800`;

/** Radix TabsList shell — one row, gold border, no wrap (Scorecard / street panels). */
export const RADIX_TAB_LIST = cn(SUB_TAB_BAR, "w-auto max-w-full justify-start overflow-x-auto");

/** Same track, when the list sits on the settings L2 bar. */
export const RADIX_TAB_LIST_ON_STRIP = cn(SUB_TAB_BAR, "max-w-full overflow-x-auto");

/** Radix trigger — same segment as `subTabClass`. */
export const RADIX_TAB_TRIGGER = cn(
  TAB_SEGMENT,
  SUB_TAB_IDLE,
  "data-[state=active]:text-black data-[state=active]:shadow-sm",
  "[&:nth-child(5n+1)[data-state=active]]:bg-sky-400",
  "[&:nth-child(5n+2)[data-state=active]]:bg-violet-400",
  "[&:nth-child(5n+3)[data-state=active]]:bg-amber-300",
  "[&:nth-child(5n+4)[data-state=active]]:bg-emerald-400",
  "[&:nth-child(5n+5)[data-state=active]]:bg-rose-400",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
  "disabled:pointer-events-none disabled:opacity-50",
);

/** Same segment. Kept so older call sites stay on this control. */
export const RADIX_TAB_TRIGGER_STRIP = RADIX_TAB_TRIGGER;
