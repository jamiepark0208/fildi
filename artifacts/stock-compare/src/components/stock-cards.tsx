import { StockMetrics } from "@workspace/api-client-react";
import { formatCurrency, formatPercent } from "@/lib/format";
import { StockScore } from "@/lib/rankings";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export const STOCK_COLORS = ["#38bdf8", "#fb923c", "#34d399", "#a78bfa", "#f472b6"];

interface StockCardsProps {
  tickers: string[];
  loadedStocks: StockMetrics[];
  loadingTickers: Record<string, boolean>;
  rankings: StockScore[];
}

export function StockCards({ tickers, loadedStocks, loadingTickers, rankings }: StockCardsProps) {
  if (tickers.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-4 mb-6">
      {tickers.map((ticker, index) => {
        const isLoading = loadingTickers[ticker];
        const stock = loadedStocks.find(s => s.ticker === ticker);
        const score = rankings.find(r => r.ticker === ticker);
        const color = STOCK_COLORS[index % STOCK_COLORS.length];

        if (isLoading) {
          return (
            <div key={ticker} className="flex-1 min-w-[220px] max-w-[320px] bg-card border border-border rounded-xl p-4 shadow-sm flex items-center justify-center min-h-[140px]" style={{ borderLeftColor: color, borderLeftWidth: 4 }}>
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          );
        }

        if (!stock) return null;

        // Rank styling
        let rankBadgeClass = "bg-secondary text-secondary-foreground";
        if (score?.rank === 1) rankBadgeClass = "bg-yellow-500 text-yellow-950 shadow-sm";
        else if (score?.rank === 2) rankBadgeClass = "bg-slate-300 text-slate-900 shadow-sm";
        else if (score?.rank === 3) rankBadgeClass = "bg-amber-700 text-amber-50 shadow-sm";

        return (
          <div 
            key={ticker} 
            className="flex-1 min-w-[220px] max-w-[320px] bg-card border border-border rounded-xl p-5 shadow-sm flex flex-col transition-all hover:border-primary/50"
            style={{ borderLeftColor: color, borderLeftWidth: 4 }}
          >
            <div className="flex justify-between items-start mb-6">
              <div>
                <h3 className="text-2xl font-bold tracking-tight leading-none">{stock.ticker}</h3>
                <p className="text-xs text-muted-foreground truncate max-w-[140px] mt-1.5">{stock.companyName}</p>
              </div>
              {score && (
                <div className={cn("px-2 py-0.5 rounded text-xs font-bold", rankBadgeClass)}>
                  #{score.rank}
                </div>
              )}
            </div>

            <div className="flex items-end justify-between mt-auto">
              <div>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {formatCurrency(stock.currentPrice)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {stock.sector ?? stock.stockType ?? ""}
                </div>
              </div>
              <div className="text-right">
                {score ? (
                  <div className="text-[11px] text-muted-foreground font-medium flex flex-col items-end">
                    <span className="uppercase tracking-wider mb-0.5">FILDI Score</span>
                    <span className="text-foreground text-sm">{score.totalScore.toFixed(1)} <span className="text-muted-foreground/50 text-xs">/ {score.maxPossible}</span></span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">N/A</div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
