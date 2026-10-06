import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { RecConflict } from "@/lib/rec-conflicts";

/** Amber chip — mirrors street-synthesis conflict tone; links to Model List. */
export function RecConflictChip({
  conflicts,
}: {
  conflicts: RecConflict[];
}) {
  if (conflicts.length === 0) return null;
  const title = conflicts.map(c => c.text).join(" · ");
  return (
    <Link
      href="/watchlist"
      title={title}
      className={cn(
        "ml-1 inline-flex items-center rounded border px-1 py-px text-[9px] font-semibold leading-none",
        "border-amber-400/50 bg-amber-600/30 text-amber-50 hover:border-[#d4af37] hover:text-[#d4af37]",
      )}
    >
      ⚠ Model
    </Link>
  );
}
