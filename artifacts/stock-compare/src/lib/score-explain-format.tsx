import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Shared "ag-grid" table look used across the app (see macro.tsx SEP Projections table):
// bordered container, dense uppercase header row, zebra rows, hover highlight, tabular numerals.
export const GRID_WRAP   = "border border-border/60 rounded-lg overflow-hidden";
export const GRID_HEADER = "border-b border-border/60 bg-secondary/20";
export const GRID_TH     = "py-1.5 px-2.5 font-medium text-[10px] uppercase tracking-widest text-muted-foreground whitespace-nowrap";
export const GRID_TD     = "py-1.5 px-2.5 text-[11px] tabular-nums";
export const gridRow = (i: number) =>
  cn("border-b border-border/20 last:border-0 hover:bg-secondary/10 transition-colors", i % 2 === 1 && "bg-secondary/5");

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
