import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions, StockMetrics } from "@workspace/api-client-react";
import { BarChart2 } from "lucide-react";
import { TickerShelf } from "@/components/ticker-shelf";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { MetricsTable } from "@/components/metrics-table";
import { ScorecardBreakdown } from "@/components/scorecard-breakdown";
import { computeRankings } from "@/lib/rankings";

export default function Home() {
  const [tickers, setTickers] = useState<string[]>([]);

  const handleAddTicker = (ticker: string) => {
    if (!tickers.includes(ticker) && tickers.length < 5) {
      setTickers((prev) => [...prev, ticker]);
    }
  };

  const handleRemoveTicker = (ticker: string) => {
    setTickers((prev) => prev.filter((t) => t !== ticker));
  };

  const queries = useQueries({
    queries: tickers.map((ticker) => ({
      ...getGetStockQuoteQueryOptions({ ticker }),
      staleTime: 10 * 60 * 1000,
      gcTime: 15 * 60 * 1000,
    })),
  });

  const loadingTickers = useMemo(() => {
    const obj: Record<string, boolean> = {};
    tickers.forEach((ticker, i) => {
      obj[ticker] = queries[i]?.isLoading || false;
    });
    return obj;
  }, [tickers, queries]);

  const loadedStocks = useMemo(() => {
    const stocks: StockMetrics[] = [];
    queries.forEach((q, i) => {
      if (q.data) {
        stocks.push(q.data);
      } else if (!q.isLoading) {
        // Fallback for failed/missing stock if needed, or we just skip it
        stocks.push({ ticker: tickers[i], companyName: "Unknown" } as StockMetrics);
      }
    });
    return stocks;
  }, [queries, tickers]);

  const rankings = useMemo(() => {
    // Only rank stocks that have data successfully loaded
    const validStocks = loadedStocks.filter(s => s.currentPrice !== undefined);
    return computeRankings(validStocks);
  }, [loadedStocks]);

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
              <BarChart2 className="w-5 h-5" />
            </div>
            <span className="font-bold tracking-tight">EQUITRON</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold mb-3 tracking-tight">Multi-Asset Analysis</h1>
          <p className="text-lg text-muted-foreground mb-8 max-w-3xl">
            Evaluate up to 5 public equities simultaneously. Rank assets based on valuation, growth, and profitability.
          </p>

          <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Active Assets</h2>
            <TickerShelf
              tickers={tickers}
              loadingTickers={loadingTickers}
              onAdd={handleAddTicker}
              onRemove={handleRemoveTicker}
            />
          </div>
        </div>

        {tickers.length > 0 ? (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {rankings.length >= 2 && (
              <RankingsLeaderboard scores={rankings} />
            )}
            
            <MetricsTable stocks={loadedStocks} loadingTickers={loadingTickers} />
            
            {rankings.length >= 2 && (
              <ScorecardBreakdown scores={rankings} />
            )}
          </div>
        ) : (
          <div className="text-center py-24 text-muted-foreground">
            <BarChart2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <h3 className="text-xl font-bold mb-2">No assets selected</h3>
            <p>Add a ticker symbol above to begin the comparison.</p>
          </div>
        )}
      </main>
    </div>
  );
}
