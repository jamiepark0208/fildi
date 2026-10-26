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
  /** Vendor that produced this chain — Yahoo usually means Schwab miss/fallback. */
  source?: "schwab" | "yahoo";
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
export type SortKey = "rank" | "optionScore" | "score" | "income" | "iv" | "otm" | "buffer";

export function pfNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

export type ColRange = { lo: number; hi: number };

/** Continuous column heat (low→high): text color red → yellow → green. No background box. */
export function columnHeatStyle(
  value: number | null | undefined,
  range: ColRange | null | undefined,
  invert = false,
): { color?: string } {
  if (value == null || !Number.isFinite(value) || !range || range.hi <= range.lo) return {};
  let t = (value - range.lo) / (range.hi - range.lo);
  t = Math.max(0, Math.min(1, t));
  if (invert) t = 1 - t;
  // hue 0 (red) → 60 (yellow) → 120 (green); light enough to read on dark rows
  const hue = t * 120;
  return { color: `hsl(${hue}, 78%, ${58 + t * 10}%)` };
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

export function SortableHeader({ label, sortKey, active, className, width, onClick, title }: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  /** Prefer flex/grid cell classes; legacy width=* still ok. */
  className?: string;
  width?: string;
  title?: string;
  onClick: (key: SortKey) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onClick(sortKey)}
      className={cn(
        "text-left font-semibold transition-colors min-w-0",
        width,
        className,
        active ? "text-[#d4af37]" : "text-[#d4af37]/85 hover:text-[#d4af37]",
      )}
    >
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap leading-none">
        {label}{active ? <span className="text-[9px] opacity-80">▾</span> : null}
      </span>
    </button>
  );
}

/** Shared leaderboard column track — even fr on score cols; Price slightly wider for $ + %. */
export const OPTIONS_BOARD_COLS =
  "grid w-full grid-cols-[26px_minmax(70px,1.15fr)_minmax(88px,1.25fr)_minmax(38px,0.75fr)_minmax(42px,0.8fr)_minmax(36px,0.7fr)_minmax(42px,0.85fr)_minmax(42px,0.85fr)_minmax(40px,0.8fr)_minmax(44px,0.85fr)_minmax(42px,0.85fr)_32px] gap-x-2 items-center";