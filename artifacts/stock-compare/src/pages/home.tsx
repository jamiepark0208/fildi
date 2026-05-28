import { useState, useMemo, useRef } from "react";
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

interface HomeProps {
  tickers: string[];
  setTickers: React.Dispatch<React.SetStateAction<string[]>>;
}

export default function Home({ tickers, setTickers }: HomeProps) {
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("1M");
  const inputRef = useRef<HTMLInputElement>(null);

  const focusInput = () => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder="Add ticker..."]');
    el?.focus();
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
    tickers.forEach((ticker, i) => { obj[ticker] = queries[i]?.isLoading || false; });
    return obj;
  }, [tickers, queries]);

  const loadedStocks = useMemo(() => {
    const stocks: StockMetrics[] = [];
    queries.forEach((q, i) => {
      if (q.data) stocks.push(q.data);
      else if (!q.isLoading) stocks.push({ ticker: tickers[i], companyName: "" } as StockMetrics);
    });
    return stocks;
  }, [queries, tickers]);

  const rankings = useMemo(() => {
    const validStocks = loadedStocks.filter(s => s.currentPrice !== undefined && s.currentPrice !== null);
    return computeRankings(validStocks);
  }, [loadedStocks]);

  const hasData = loadedStocks.some(s => s.currentPrice !== undefined && s.currentPrice !== null);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Fundamental Analysis</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Compare up to 5 equities simultaneously</p>
          </div>
          <TickerShelf
            tickers={tickers}
            loadingTickers={loadingTickers}
            onAdd={handleAddTicker}
            onRemove={handleRemoveTicker}
          />
        </div>

        <div className="p-5 space-y-4">
          <StockCards
            tickers={tickers}
            loadedStocks={loadedStocks}
            loadingTickers={loadingTickers}
            rankings={rankings}
            onAddClick={focusInput}
            onRemove={handleRemoveTicker}
          />

          <PriceChart
            tickers={tickers}
            loadedStocks={loadedStocks}
            selectedPeriod={selectedPeriod}
            onPeriodChange={setSelectedPeriod}
          />

          {hasData && (
            <div className="space-y-4">
              {rankings.length >= 2 && <RankingsLeaderboard scores={rankings} />}
              <MetricsTable stocks={loadedStocks} loadingTickers={loadingTickers} />
              {rankings.length >= 2 && <ScorecardBreakdown scores={rankings} />}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
