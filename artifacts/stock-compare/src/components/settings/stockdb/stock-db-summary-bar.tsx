// Stock DB summary bar: ticker counts, missing rows, overall coverage, admin refresh.
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { coverageColor } from "./stock-db-palette";
import type { StockDBEntry } from "./stock-db-types";

export function StockDbSummaryBar({ data, noRow, coverage, isFetching, onRefresh }: {
  data: StockDBEntry[];
  noRow: number;
  coverage: number;
  isFetching: boolean;
  /** Admin only — omit to hide the Refresh button. */
  onRefresh?: () => void;
}) {
  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 px-3 py-2 flex items-center justify-between">
      <div className="flex gap-4 text-xs text-amber-200/50">
        <span><span className="text-white font-medium tabular-nums">{data.length}</span> tickers</span>
        <span><span className="text-white font-medium tabular-nums">{data.filter(d => d.isWatchlist).length}</span> watchlist</span>
        <span><span className="text-white font-medium tabular-nums">{data.filter(d => !d.isWatchlist).length}</span> peers only</span>
        <span><span className={cn("font-medium tabular-nums", noRow > 0 ? "text-red-400" : "text-green-400")}>{noRow}</span> missing rows</span>
        <span>Coverage <span className={cn("font-medium tabular-nums", coverageColor(coverage))}>{coverage}%</span></span>
      </div>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-amber-200/50 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      )}
    </div>
  );
}
