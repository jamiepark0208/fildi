import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions, StockMetrics } from "@workspace/api-client-react";
import { TickerShelf } from "@/components/ticker-shelf";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { MetricsTable } from "@/components/metrics-table";
import { ScorecardBreakdown } from "@/components/scorecard-breakdown";
import { computeRankings } from "@/lib/rankings";
import { Sidebar } from "@/components/sidebar";
import { StockCards } from "@/components/stock-cards";
import { PriceChart, Period } from "@/components/price-chart";
import { Search } from "lucide-react";

export default function Home() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("1M");
  
  const handleAddTickerClick = () => {
    const input = document.querySelector('input[placeholder="Add ticker..."]') as HTMLInputElement;
    if (input) {
      input.focus();
    }
  };

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
        stocks.push({ ticker: tickers[i], companyName: "Unknown" } as StockMetrics);
      }
    });
    return stocks;
  }, [queries, tickers]);

  const rankings = useMemo(() => {
    const validStocks = loadedStocks.filter(s => s.currentPrice !== undefined);
    return computeRankings(validStocks);
  }, [loadedStocks]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar onAddTickerClick={handleAddTickerClick} />

      <main className="flex-1 ml-[220px] p-6 lg:p-10 max-w-[1600px] w-full mx-auto">
        {/* Header Area */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 mb-10">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-1">Fundamental Analysis</h1>
            <p className="text-muted-foreground text-sm">Evaluate up to 5 public equities simultaneously.</p>
          </div>
          
          <div className="flex items-center min-h-[48px]">
            <TickerShelf
              tickers={tickers}
              loadingTickers={loadingTickers}
              onAdd={handleAddTicker}
              onRemove={handleRemoveTicker}
            />
          </div>
        </div>

        {tickers.length > 0 ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <StockCards 
              tickers={tickers} 
              loadedStocks={loadedStocks} 
              loadingTickers={loadingTickers} 
              rankings={rankings} 
            />

            <PriceChart 
              tickers={tickers}
              loadedStocks={loadedStocks}
              selectedPeriod={selectedPeriod}
              onPeriodChange={setSelectedPeriod}
            />

            <div className="space-y-8">
              {rankings.length >= 2 && (
                <RankingsLeaderboard scores={rankings} />
              )}
              
              <MetricsTable stocks={loadedStocks} loadingTickers={loadingTickers} />
              
              {rankings.length >= 2 && (
                <ScorecardBreakdown scores={rankings} />
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-32 text-muted-foreground border-2 border-dashed border-border/50 rounded-2xl bg-card/10 flex flex-col items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-secondary/50 flex items-center justify-center mb-6">
              <Search className="w-8 h-8 opacity-40" />
            </div>
            <h3 className="text-xl font-bold mb-2 text-foreground">No assets selected</h3>
            <p className="max-w-sm">Add tickers using the search bar or the Add Ticker button in the sidebar to begin analysis.</p>
          </div>
        )}
      </main>
    </div>
  );
}
