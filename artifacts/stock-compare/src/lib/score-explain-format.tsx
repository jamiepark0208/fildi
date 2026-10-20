import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Shared "ag-grid" table look used across the app (see macro.tsx SEP Projections table):
// bordered container, dense uppercase header row, zebra rows, hover highlight, tabular numerals.
// bg-black/30 gives the table its own visibly darker surface vs. the translucent row it sits in
// (rows use bg-*/5, near-identical to the card background — without this the table edges vanish).
/** Scroll both axes when content overflows — never clip wide agent/rank tables. */
export const GRID_WRAP   = "border border-[#d4af37]/20 rounded-lg overflow-auto bg-black/40";
export const GRID_HEADER = "border-b border-[#d4af37]/20 bg-black";
export const GRID_TH     = "py-1 px-2.5 font-medium text-[11px] uppercase tracking-widest text-[#d4af37] whitespace-nowrap";
export const GRID_TD     = "py-1 px-2.5 text-[13px] tabular-nums";
export const gridRow = (i: number) =>
  cn("border-b border-[#d4af37]/10 last:border-0 hover:bg-[#d4af37]/5 transition-colors", i % 2 === 1 && "bg-black/30");

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
  return "text-white/50";
}

export function percentileColor(pct: number): string {
  if (pct >= 80) return "text-emerald-400";
  if (pct >= 60) return "text-emerald-300/80";
  if (pct <= 20) return "text-red-400";
  if (pct <= 40) return "text-red-300/80";
  return "text-white/60";
}

export function percentileBadge(pct: number): string {
  if (pct >= 80) return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (pct >= 60) return "bg-emerald-500/10 text-emerald-300/80 border-emerald-500/20";
  if (pct <= 20) return "bg-red-500/15 text-red-400 border-red-500/30";
  if (pct <= 40) return "bg-red-500/10 text-red-300/80 border-red-500/20";
  return "bg-secondary/40 text-white/60 border-border/40";
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
