import { useState, useMemo, useRef, useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions, StockMetrics } from "@workspace/api-client-react";
import { TickerShelf } from "@/components/ticker-shelf";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { MetricsTable } from "@/components/metrics-table";
import { ScorecardBreakdown } from "@/components/scorecard-breakdown";
import { type StockScore } from "@/lib/rankings";
import { AppPage } from "@/components/app-page";
import { StockCards } from "@/components/stock-cards";
import { PriceChart, Period } from "@/components/price-chart";
import { queryKeys } from "@/lib/query-keys";
import { idlePrefetchRouteChunks } from "@/lib/prefetch-policy";

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

  // Per-ticker queries for the selected tickers (display + loading state)
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

  const { data: serverRankings, isLoading: rankingsLoading } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async () => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json() as Promise<Array<{
        ticker: string;
        totalScore: number | null;
        valueScore?: number | null;
        qualityScore: number | null;
        growthScore: number | null;
        safetyScore: number | null;
        rank: number;
        regime: string;
        computedAt: string;
        metricScores?: Record<string, { value: number | null; weightedScore: number }>;
        peerGroupId?: string | null;
        peerGroupName?: string | null;
        peerGroupSize?: number;
        styleBucket?: string | null;
        confidence?: string | null;
      }>>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Idle-prefetch next-likely route chunks once this page's own data has
  // settled — never while rankings is still in-flight (launch policy edge case).
  useEffect(() => {
    if (!rankingsLoading) idlePrefetchRouteChunks();
  }, [rankingsLoading]);

  const rankings = useMemo((): StockScore[] => {
    if (!serverRankings?.length) return [];
    const stockByTicker = new Map(loadedStocks.map(s => [s.ticker, s]));
    return [...serverRankings]
      .filter(r => r.totalScore != null && r.rank > 0)
      .sort((a, b) => a.rank - b.rank)
      .map(r => ({
        ticker:       r.ticker,
        companyName:  stockByTicker.get(r.ticker)?.companyName ?? r.ticker,
        totalScore:   r.totalScore as number,
        maxPossible:  100,
        rank:         r.rank,
        metricScores: Object.fromEntries(
          Object.entries(r.metricScores ?? {}).map(([k, v]) => [k, { value: v.value, weightedScore: v.weightedScore, rank: 0 }])
        ),
        reason:       "",
        familyScores: {
          value:   { score: r.valueScore ?? 50, coverage: 0, lowCoverage: r.valueScore == null },
          quality: { score: r.qualityScore ?? 50, coverage: 1, lowCoverage: r.qualityScore == null },
          growth:  { score: r.growthScore ?? 50, coverage: 1, lowCoverage: r.growthScore == null },
          safety:  { score: r.safetyScore ?? 50, coverage: 1, lowCoverage: r.safetyScore == null },
        },
        regime: r.regime,
        peerGroupId:   r.peerGroupId ?? undefined,
        peerGroupName: r.peerGroupName ?? undefined,
        peerGroupSize: r.peerGroupSize,
      }));
  }, [serverRankings, loadedStocks]);

  const hasData = loadedStocks.some(s => s.currentPrice !== undefined && s.currentPrice !== null);

  return (
    <AppPage className="bg-background selection:bg-primary/30" contentClassName="min-w-0">
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Fundamental Analysis</h1>
            <p className="text-xs text-amber-100 mt-0.5">Compare up to 5 equities simultaneously</p>
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

          {rankings.length >= 2 && (
            <RankingsLeaderboard
              scores={rankings}
              stocks={loadedStocks}
              scoredAsOf={serverRankings?.[0]?.computedAt ?? null}
            />
          )}
          {hasData && (
            <MetricsTable stocks={loadedStocks} loadingTickers={loadingTickers} />
          )}
          {rankings.length >= 2 && <ScorecardBreakdown scores={rankings} />}
        </div>
    </AppPage>
  );
}
