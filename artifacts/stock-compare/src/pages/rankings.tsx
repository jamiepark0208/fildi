import { useMemo } from "react";
import { useSessionState } from "@/hooks/use-session-state";
import { useQuery } from "@tanstack/react-query";
import { StockMetrics } from "@workspace/api-client-react";
import { TopNav } from "@/components/top-nav";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { TechnicalLeaderboard } from "@/components/technical-leaderboard";
import { OptionsScannerContent } from "@/pages/options-scanner";
import { type StockScore } from "@/lib/rankings";
import { type TechnicalRow, computeTechnicalRankingsV2 } from "@/lib/technical-rankings";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useWatchlist } from "@/hooks/use-watchlist";
import { queryKeys } from "@/lib/query-keys";

// Rankings-only view: same two leaderboards shown on Fundamental/Technical
// pages, without the compare-shelf chart or ticker-search UI.
export default function Rankings() {
  const [tab, setTab] = useSessionState<"fundamental" | "technical" | "options">("fildi_rankings_tab", "fundamental");
  const { weights } = useScoringPreferences();
  const { tickers: watchlistTickers } = useWatchlist();

  const tickerKey = useMemo(() => [...watchlistTickers].sort().join(","), [watchlistTickers]);

  const quotesQuery = useQuery({
    queryKey: ["stocks-quotes", tickerKey],
    queryFn: async (): Promise<Record<string, StockMetrics | { error: string }>> => {
      const res = await fetch(`/api/stocks/quotes?tickers=${encodeURIComponent(tickerKey)}`);
      if (!res.ok) throw new Error("quotes fetch failed");
      return res.json();
    },
    enabled: tickerKey.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const loadedStocks = useMemo((): StockMetrics[] => {
    const data = quotesQuery.data;
    if (!data) return [];
    return Object.entries(data)
      .filter((entry): entry is [string, StockMetrics] => !("error" in entry[1]))
      .map(([, stock]) => stock);
  }, [quotesQuery.data]);

  const { data: serverRankings } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async () => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json() as Promise<Array<{ ticker: string; totalScore: number; qualityScore: number; growthScore: number; safetyScore: number; rank: number; regime: string; computedAt: string; metricScores?: Record<string, { value: number | null; weightedScore: number }> }>>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const fundamentalRankings = useMemo((): StockScore[] => {
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

  const { data: allTechnicalsData } = useQuery({
    queryKey: ["technicals", "all"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all");
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const technicalScores = useMemo(() => {
    if (!allTechnicalsData?.length) return [];
    return computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical);
  }, [allTechnicalsData, weights.technical]);

  const technicalRowMap = useMemo(
    () => allTechnicalsData ? Object.fromEntries(allTechnicalsData.map(r => [r.ticker, r])) : undefined,
    [allTechnicalsData],
  );

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30">
      <TopNav />

      <main className="pt-14 min-w-0">
        <div className="p-5">
          <Tabs value={tab} onValueChange={v => setTab(v as "fundamental" | "technical" | "options")}>
            <TabsList className="h-10 mb-4">
              <TabsTrigger
                value="fundamental"
                className="text-sm px-4 data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-300"
              >
                Fundamentals
              </TabsTrigger>
              <TabsTrigger
                value="technical"
                className="text-sm px-4 data-[state=active]:bg-violet-500/20 data-[state=active]:text-violet-300"
              >
                Technicals
              </TabsTrigger>
              <TabsTrigger
                value="options"
                className="text-sm px-4 data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-300"
              >
                Options
              </TabsTrigger>
            </TabsList>

            <TabsContent value="fundamental" className="mt-0">
              {fundamentalRankings.length >= 2 ? (
                <RankingsLeaderboard scores={fundamentalRankings} stocks={loadedStocks} />
              ) : (
                <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see fundamental rankings.</p>
              )}
            </TabsContent>

            <TabsContent value="technical" className="mt-0">
              {technicalScores.length >= 2 ? (
                <TechnicalLeaderboard scores={technicalScores} rowMap={technicalRowMap} />
              ) : (
                <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see technical rankings.</p>
              )}
            </TabsContent>

            <TabsContent value="options" className="mt-0">
              <OptionsScannerContent showHeader={false} />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
