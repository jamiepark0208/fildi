// Stock DB summary bar: ticker count + coverage + enrich status (no Refresh — refetch is via queue).
import { coverageColor } from "./stock-db-palette";
import type { StockDBEntry } from "./stock-db-types";

export function StockDbSummaryBar({ data, coverage, enrichChip, enrichTitle, reviewCount, suspectCount }: {
  data: StockDBEntry[];
  coverage: number;
  /** Optional one-line enrich status (no duplicate cov %). */
  enrichChip?: string | null;
  /** Hover detail — per-source fetch counts (enrichment is field-level, not ticker list). */
  enrichTitle?: string | null;
  reviewCount?: number | null;
  suspectCount?: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 px-0.5 py-0.5 text-[11px] font-mono tabular-nums text-white border-b border-[#d4af37]/20">
      <span><b className="text-[#d4af37]">{data.length}</b> tickers</span>
      <span>Coverage <b className={coverageColor(coverage)}>{coverage}%</b></span>
      {reviewCount != null && (
        <span title="Sign flip or 3× scale. Ordinary vendor gaps are already stored.">Review <b className={reviewCount > 0 ? "text-orange-300" : "text-white"}>{reviewCount}</b></span>
      )}
      {suspectCount != null && (
        <span title="Value outside the allowed range for that field">Suspect <b className={suspectCount > 0 ? "text-amber-300" : "text-white"}>{suspectCount}</b></span>
      )}
      {enrichChip ? (
        <span className="text-white/90 truncate max-w-[28rem]" title={enrichTitle || enrichChip}>{enrichChip}</span>
      ) : null}
    </div>
  );
}
