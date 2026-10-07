import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { RecConflict } from "@/lib/rec-conflicts";

/** Amber chip — mirrors street-synthesis conflict tone; links to Model List. */
export function RecConflictChip({
  conflicts,
  compact = false,
}: {
  conflicts: RecConflict[];
  /** Scanner / dense tables — single-letter mark. */
  compact?: boolean;
}) {
  if (conflicts.length === 0) return null;
  const title = conflicts.map(c => c.text).join(" · ");
  return (
    <Link
      href="/watchlist"
      title={title}
      className={cn(
        "inline-flex items-center rounded border font-semibold leading-none shrink-0",
        compact
          ? "ml-0.5 px-0.5 py-px text-[8px] border-amber-400/40 bg-amber-600/25 text-amber-100"
          : "ml-1 px-1 py-px text-[9px] border-amber-400/50 bg-amber-600/30 text-amber-50 hover:border-[#d4af37] hover:text-[#d4af37]",
      )}
    >
      {compact ? "M" : "⚠ Model"}
    </Link>
  );
}
