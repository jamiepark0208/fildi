// Stock DB summary bar: ticker count + coverage + enrich status (no Refresh — refetch is via queue).
import { coverageColor } from "./stock-db-palette";
import type { StockDBEntry } from "./stock-db-types";

export function StockDbSummaryBar({ data, coverage, enrichChip, enrichTitle }: {
  data: StockDBEntry[];
  coverage: number;
  /** Optional one-line enrich status (no duplicate cov %). */
  enrichChip?: string | null;
  /** Hover detail — per-source fetch counts (enrichment is field-level, not ticker list). */
  enrichTitle?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 px-0.5 py-0.5 text-[11px] font-mono tabular-nums text-white border-b border-[#d4af37]/20">
      <span><b className="text-[#d4af37]">{data.length}</b> tickers</span>
      <span>Coverage <b className={coverageColor(coverage)}>{coverage}%</b></span>
      {enrichChip ? (
        <span className="text-white/90 truncate max-w-[28rem]" title={enrichTitle || enrichChip}>{enrichChip}</span>
      ) : null}
    </div>
  );
}
