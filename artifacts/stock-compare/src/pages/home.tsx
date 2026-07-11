import { useState, useMemo, useRef, useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions, StockMetrics } from "@workspace/api-client-react";
import { TickerShelf } from "@/components/ticker-shelf";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { MetricsTable } from "@/components/metrics-table";
import { ScorecardBreakdown } from "@/components/scorecard-breakdown";
import { type StockScore } from "@/lib/rankings";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { Sidebar } from "@/components/sidebar";
import { StockCards } from "@/components/stock-cards";
import { PriceChart, Period } from "@/components/price-chart";
import { useWatchlist } from "@/hooks/use-watchlist";
import { queryKeys } from "@/lib/query-keys";
import { idlePrefetchRouteChunks } from "@/lib/prefetch-policy";

interface HomeProps {
  tickers: string[];
  setTickers: React.Dispatch<React.SetStateAction<string[]>>;
}

export default function Home({ tickers, setTickers }: HomeProps) {
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("1M");
  const inputRef = useRef<HTMLInputElement>(null);
  const { weights } = useScoringPreferences();
  const { tickers: watchlistTickers } = useWatchlist();

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

  const peerGroupsQuery = useQuery({
    queryKey: ["peer-groups", watchlistTickers],
    queryFn: async () => {
      const res = await fetch(`/api/fundamentals/peer-groups?tickers=${watchlistTickers.join(",")}`);
      if (!res.ok) return {} as Record<string, { groupId: string; confidence: "mapped" | "auto" | "unmapped"; metricExclusions?: string[] }>;
      return res.json() as Promise<Record<string, { groupId: string; confidence: "mapped" | "auto" | "unmapped"; metricExclusions?: string[] }>>;
    },
    enabled: watchlistTickers.length > 0,
    staleTime: 24 * 60 * 60 * 1000,
  });
  const peerGroupMap = peerGroupsQuery.data ?? {};

  const regimeQuery = useQuery({
    queryKey: ["macro-regime"],
    queryFn: async () => {
      const res = await fetch("/api/regime/macro");
      if (!res.ok) return null;
      const json = await res.json() as { regime?: string };
      return json.regime ?? null;
    },
    staleTime: 60 * 60 * 1000,
  });
  const regime = regimeQuery.data ?? undefined;

  const riskFreeRateQuery = useQuery({
    queryKey: ["risk-free-rate"],
    queryFn: async () => {
      const res = await fetch("/api/macro/risk-free-rate");
      if (!res.ok) return null;
      const json = await res.json() as { riskFreeRate: number | null };
      return json.riskFreeRate;
    },
    staleTime: 4 * 60 * 60 * 1000,
  });
  const riskFreeRate = riskFreeRateQuery.data ?? null;

  const { data: serverRankings, isLoading: rankingsLoading } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async () => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json() as Promise<Array<{ ticker: string; totalScore: number; qualityScore: number; growthScore: number; safetyScore: number; rank: number; regime: string; computedAt: string; metricScores?: Record<string, { value: number | null; weightedScore: number }> }>>;
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
    const watchlistSet = new Set(watchlistTickers);
    const stockByTicker = new Map(loadedStocks.map(s => [s.ticker, s]));
    return serverRankings
      .filter(r => watchlistSet.has(r.ticker))
      .sort((a, b) => a.rank - b.rank)
      .map(r => ({
        ticker:       r.ticker,
        companyName:  stockByTicker.get(r.ticker)?.companyName ?? r.ticker,
        totalScore:   r.totalScore,
        maxPossible:  100,
        rank:         r.rank,
        metricScores: Object.fromEntries(
          Object.entries(r.metricScores ?? {}).map(([k, v]) => [k, { value: v.value, weightedScore: v.weightedScore, rank: 0 }])
        ),
        reason:       "",
        familyScores: {
          value:   { score: 50,             coverage: 0, lowCoverage: true },
          quality: { score: r.qualityScore, coverage: 1, lowCoverage: false },
          growth:  { score: r.growthScore,  coverage: 1, lowCoverage: false },
          safety:  { score: r.safetyScore,  coverage: 1, lowCoverage: false },
        },
      }));
  }, [serverRankings, loadedStocks, watchlistTickers]);

  const hasData = loadedStocks.some(s => s.currentPrice !== undefined && s.currentPrice !== null);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 min-w-0" style={{ marginLeft: 'var(--sidebar-w, 220px)', transition: 'margin-left 200ms ease' }}>
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

          {rankings.length >= 2 && <RankingsLeaderboard scores={rankings} stocks={loadedStocks} />}
          {hasData && (
            <MetricsTable stocks={loadedStocks} loadingTickers={loadingTickers} />
          )}
          {rankings.length >= 2 && <ScorecardBreakdown scores={rankings} />}
        </div>
      </main>
    </div>
  );
}
