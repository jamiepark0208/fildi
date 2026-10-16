import { cn } from "@/lib/utils";
import type { IndicatorResult } from "@/lib/technical-rankings";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  incomePct: number;
  meetsGate: boolean;
  bidIsLive: boolean;
  quoteStale?: boolean;
  delta: number | null;
  spreadPct: number | null;
}

export interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  exactDte: number;
  settlementDte: number;
  spot: number;
  tier: 1 | 2 | 3;
  puts: OptionRow[];
  calls: OptionRow[];
  fetchedAt: number;
}

export interface IvTermPoint {
  label:  string; // "1W" | "1M" | "2M" | "3M" | "6M" | "1Y"
  expiry: string;
  dte:    number;
  iv:     number; // decimal, e.g. 0.32
}

export interface MacroRegimeResult {
  vix: number | null;
  spxChange1d: number | null;
  ndxChange1d: number | null;
  rutChange1d: number | null;
  regime: import("@/lib/option-scorer-constants").MacroRegime;
  indexDirection: "RALLY" | "NEUTRAL" | "CRASH";
  error?: string;
}

export type ScorecardRow = IndicatorResult & { stale: boolean };
export type SortKey = "optionScore" | "score" | "income" | "iv" | "otm" | "buffer";

export function pfNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

export type ColRange = { lo: number; hi: number };

/** Continuous column heat (low→high). Better than 3-bin green/yellow/red for ranking boards. */
export function columnHeatStyle(
  value: number | null | undefined,
  range: ColRange | null | undefined,
  invert = false,
): { backgroundColor?: string } {
  if (value == null || !Number.isFinite(value) || !range || range.hi <= range.lo) return {};
  let t = (value - range.lo) / (range.hi - range.lo);
  t = Math.max(0, Math.min(1, t));
  if (invert) t = 1 - t;
  // slate (low) → amber (mid) → emerald (high)
  const hue = t < 0.5 ? 210 - t * 100 : 45 + (t - 0.5) * 190;
  const sat = 55 + t * 20;
  const light = 32 + t * 8;
  const alpha = 0.18 + t * 0.42;
  return { backgroundColor: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})` };
}

export function colRange(values: Array<number | null | undefined>): ColRange | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return hi > lo ? { lo, hi } : null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const RED_TAG = "#ef4444";

export function SortableHeader({ label, sortKey, active, className, width, onClick }: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  /** Prefer flex/grid cell classes; legacy width=* still ok. */
  className?: string;
  width?: string;
  onClick: (key: SortKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(sortKey)}
      className={cn(
        "text-left font-normal transition-colors min-w-0",
        width,
        className,
        active ? "text-[#d4af37]" : "text-amber-200/55 hover:text-[#d4af37]",
      )}
    >
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap leading-none">
        {label}{active ? <span className="text-[9px] opacity-80">▾</span> : null}
      </span>
    </button>
  );
}

/** Shared leaderboard column track — fills the card width evenly. */
export const OPTIONS_BOARD_COLS =
  "grid w-full grid-cols-[28px_minmax(72px,1.35fr)_minmax(52px,1fr)_minmax(44px,0.9fr)_minmax(52px,1fr)_minmax(40px,0.8fr)_minmax(44px,0.95fr)_minmax(48px,1fr)_minmax(40px,0.8fr)_minmax(48px,1fr)_minmax(44px,0.95fr)_40px] gap-x-2.5 items-center";