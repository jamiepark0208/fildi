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

// ── Constants ─────────────────────────────────────────────────────────────────

export const RED_TAG = "#ef4444";

export function SortableHeader({ label, sortKey, active, width, onClick }: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  width: string;
  onClick: (key: SortKey) => void;
}) {
  return (
    <button
      onClick={() => onClick(sortKey)}
      className={cn(
        `${width} shrink-0 text-left transition-colors`,
        active ? "text-[#d4af37]" : "text-amber-200/70 hover:text-[#d4af37]",
      )}
    >
      {label}{active ? " ▾" : ""}
    </button>
  );
}
