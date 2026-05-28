import { useMemo } from "react";
import { StockMetrics } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import { StockScore } from "@/lib/rankings";
import { cn } from "@/lib/utils";
import { Loader2, Plus } from "lucide-react";

export const STOCK_COLORS = ["#38bdf8", "#fb923c", "#34d399", "#a78bfa", "#f472b6"];
const MAX_SLOTS = 5;

interface StockCardsProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  loadingTickers: Record<string, boolean>;
  rankings: StockScore[];
  onAddClick: () => void;
  onRemove: (ticker: string) => void;
}

export function StockCards({ tickers, loadedStocks, loadingTickers, rankings, onAddClick, onRemove }: StockCardsProps) {
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => tickers[i] ?? null);

  const sortedSlots = useMemo(() => {
    const active = slots
      .map((ticker, originalIndex) => ({ ticker, originalIndex }))
      .filter(s => s.ticker !== null)
      .sort((a, b) => {
        const rankA = rankings.find(r => r.ticker === a.ticker)?.rank ?? 999;
        const rankB = rankings.find(r => r.ticker === b.ticker)?.rank ?? 999;
        return rankA - rankB;
      });
    const empty = slots
      .map((ticker, originalIndex) => ({ ticker, originalIndex }))
      .filter(s => s.ticker === null);
    return [...active, ...empty];
  }, [slots, rankings]);

  return (
    <div className="grid grid-cols-5 gap-3 mb-4">
      {sortedSlots.map(({ ticker, originalIndex }) => {
        const color = STOCK_COLORS[originalIndex];

        if (!ticker) {
          return (
            <button
              key={`empty-${originalIndex}`}
              onClick={onAddClick}
              className="h-[120px] rounded-xl border border-dashed border-border/60 bg-card/30 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all group"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <div className="w-8 h-8 rounded-full border border-dashed border-current flex items-center justify-center group-hover:border-solid transition-all">
                <Plus className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium">Add Stock</span>
            </button>
          );
        }

        const isLoading = loadingTickers[ticker];
        const stock = loadedStocks.find(s => s.ticker === ticker);
        const score = rankings.find(r => r.ticker === ticker);

        if (isLoading) {
          return (
            <div key={ticker} className="h-[120px] rounded-xl border border-border bg-card shadow-sm flex items-center justify-center" style={{ borderLeftColor: color, borderLeftWidth: 3 }}>
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          );
        }

        let rankBadgeClass = "bg-secondary text-secondary-foreground";
        if (score?.rank === 1) rankBadgeClass = "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
        else if (score?.rank === 2) rankBadgeClass = "bg-slate-400/20 text-slate-300 border border-slate-400/30";
        else if (score?.rank === 3) rankBadgeClass = "bg-amber-700/20 text-amber-500 border border-amber-700/30";

        return (
          <div
            key={ticker}
            className="relative h-[120px] rounded-xl border border-border bg-card shadow-sm p-3 flex flex-col justify-between"
            style={{ borderLeftColor: color, borderLeftWidth: 3 }}
          >
            <button
              onClick={() => onRemove(ticker)}
              className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors text-xs"
              title="Remove"
            >
              ×
            </button>

            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-base tracking-tight" style={{ color }}>{ticker}</span>
                {score && (
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-bold", rankBadgeClass)}>
                    #{score.rank}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5 pr-4">{stock?.companyName ?? "—"}</p>
            </div>

            <div className="flex items-end justify-between">
              <div className="text-lg font-bold font-mono tracking-tight">
                {formatCurrency(stock?.currentPrice)}
              </div>
              {score && (
                <div className="text-right">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Score</div>
                  <div className="text-xs font-bold text-foreground">{score.totalScore.toFixed(1)}</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
