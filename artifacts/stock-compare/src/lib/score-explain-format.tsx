import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Shared table look — Peers-flat (Jamie 10-27): no nested gold box inside a panel.
// Header underline only; body 11px white; never muted grey for primary cells.
/** Scroll both axes when content overflows — never clip wide agent/rank tables. */
export const GRID_WRAP   = "overflow-auto min-w-0 w-full";
export const GRID_HEADER = "border-b border-[#d4af37]/20";
export const GRID_TH     = "py-0.5 px-1 font-semibold text-[9px] uppercase tracking-wide text-[#d4af37] whitespace-nowrap";
export const GRID_TD     = "py-0.5 px-1 text-[11px] tabular-nums text-white";
export const gridRow = (i: number) =>
  cn("border-b border-[#d4af37]/10 last:border-0 hover:bg-[#d4af37]/5 transition-colors", i % 2 === 1 && "bg-white/[0.02]");

/** Page / dig sub-tabs — distinct on color, white text when idle (no zinc grey). */
export const SUB_TAB_IDLE = "text-white/80 hover:text-white hover:bg-white/10";
export function subTabOn(hue: "sky" | "violet" | "amber" | "orange" | "emerald" | "rose" | "gold"): string {
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

// Compact detail-table cell: forces single-line content at header-row height —
// use in expanded metric/inputs breakdowns so a data row never grows taller than its header.
export const ROW_CELL = "py-0.5 text-[11px] whitespace-nowrap overflow-hidden text-ellipsis";

export const FAMILY_BAR_COLOR: Record<"value" | "quality" | "growth" | "safety", string> = {
  value:   "bg-sky-400",
  quality: "bg-purple-400",
  growth:  "bg-green-400",
  safety:  "bg-amber-400",
};

export function zScoreColor(z: number): string {
  if (z >= 1.5) return "text-emerald-400";
  if (z >= 0.5) return "text-emerald-300/80";
  if (z <= -1.5) return "text-red-400";
  if (z <= -0.5) return "text-red-300/80";
  return "text-amber-100/80";
}

export function percentileColor(pct: number): string {
  if (pct >= 80) return "text-emerald-400";
  if (pct >= 60) return "text-emerald-300/80";
  if (pct <= 20) return "text-red-400";
  if (pct <= 40) return "text-red-300/80";
  return "text-amber-100";
}

/** Jamie contrast: white on zinc; hue on border only. */
export function percentileBadge(pct: number): string {
  if (pct >= 80) return "bg-zinc-900 text-white border-emerald-400/70";
  if (pct >= 60) return "bg-zinc-900 text-white border-emerald-400/50";
  if (pct <= 20) return "bg-zinc-900 text-white border-rose-400/70";
  if (pct <= 40) return "bg-zinc-900 text-white border-rose-400/50";
  return "bg-zinc-900 text-zinc-300 border-zinc-600";
}

// Highlights key data points inside AI-generated bullet text: percentages, multiples ("2.3x"),
// dollar figures, ratios ("28% vs 12%"), and parenthetical asides — so a scanning eye lands on
// the numbers that justify the claim instead of re-reading the whole sentence.
const HIGHLIGHT_RE = /([+-]?\$?\d[\d,]*\.?\d*%|\d+\.?\d*x\b|#\d+)/gi;

export function highlightBullet(text: string): React.ReactNode {
  // String.split with a capturing group interleaves matches at odd indices.
  const parts = text.split(HIGHLIGHT_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    const isMatch = i % 2 === 1;
    if (isMatch) {
      const isNegative = part.startsWith("-");
      return (
        <span key={i} className={cn("font-semibold font-mono", isNegative ? "text-red-400" : "text-emerald-400")}>
          {part}
        </span>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
