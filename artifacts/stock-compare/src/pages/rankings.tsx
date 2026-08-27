import { useMemo } from "react";
import { useSessionState } from "@/hooks/use-session-state";
import { useQuery } from "@tanstack/react-query";
import { StockMetrics } from "@workspace/api-client-react";
import { TopNav } from "@/components/top-nav";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { TechnicalLeaderboard } from "@/components/technical-leaderboard";
import { OptionsScannerContent, OPTIONS_FILTER_SLOT_ID } from "@/pages/options-scanner";
import { type StockScore } from "@/lib/rankings";
import { type TechnicalRow, computeTechnicalRankingsV2 } from "@/lib/technical-rankings";
import { cn } from "@/lib/utils";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useWatchlist } from "@/hooks/use-watchlist";
import { queryKeys } from "@/lib/query-keys";

const RANKINGS_TABS: { id: "fundamental" | "technical" | "options"; label: string }[] = [
  { id: "fundamental", label: "Fundamentals" },
  { id: "technical",   label: "Technicals" },
  { id: "options",     label: "Options" },
];

// Rankings-only view: same two leaderboards shown on Fundamental/Technical
// pages, without the compare-shelf chart or ticker-search UI.
export default function Rankings() {
  const [tab, setTab] = useSessionState<"fundamental" | "technical" | "options">("fildi_rankings_tab", "fundamental");
  // Technical tab lens: oversold (sell puts) vs overbought (sell calls) — mirrors the
  // Options tab's page-level Sell Puts/Sell Calls toggle, persisted independently.
  const [techSide, setTechSide] = useSessionState<"puts" | "calls">("fildi_technical_side", "puts");
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
      // Scores are nullable: null = too little data to score honestly. The server gates
      // on coverage and shrinks toward neutral (see FAMILY_MIN_COVERAGE in fundamentals-db.ts),
      // and `ranked: false` means the ticker is deliberately off the leaderboard.
      return res.json() as Promise<Array<{ ticker: string; totalScore: number | null; qualityScore: number | null; growthScore: number | null; safetyScore: number | null; coverage: { quality: number; growth: number; safety: number; total: number }; ranked: boolean; rank: number; regime: string; computedAt: string; metricScores?: Record<string, { value: number | null; weightedScore: number }>; peerGroupId?: string | null; peerGroupName?: string | null; peerGroupSize?: number }>>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const fundamentalRankings = useMemo((): StockScore[] => {
    if (!serverRankings?.length) return [];
    const stockByTicker = new Map(loadedStocks.map(s => [s.ticker, s]));
    return [...serverRankings]
      // Unranked tickers (coverage too thin) are dropped rather than shown at rank 0 —
      // this is what kept WTR at #1 of 558 off the strength of a single metric.
      .filter(r => r.ranked && r.totalScore !== null)
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
          // No valuation metrics are scored server-side yet, so `value` stays a
          // zero-coverage placeholder rather than pretending to be a real 50.
          value:   { score: 50, coverage: 0, lowCoverage: true },
          quality: { score: r.qualityScore ?? 50, coverage: r.coverage.quality, lowCoverage: r.qualityScore == null },
          growth:  { score: r.growthScore  ?? 50, coverage: r.coverage.growth,  lowCoverage: r.growthScore  == null },
          safety:  { score: r.safetyScore  ?? 50, coverage: r.coverage.safety,  lowCoverage: r.safetyScore  == null },
        },
        regime: r.regime,
        peerGroupId:   r.peerGroupId ?? undefined,
        peerGroupName: r.peerGroupName ?? undefined,
        peerGroupSize: r.peerGroupSize,
      }));
  }, [serverRankings, loadedStocks]);

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
    return computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical, techSide === "calls" ? "call" : "put");
  }, [allTechnicalsData, weights.technical, techSide]);

  const technicalRowMap = useMemo(
    () => allTechnicalsData ? Object.fromEntries(allTechnicalsData.map(r => [r.ticker, r])) : undefined,
    [allTechnicalsData],
  );

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30">
      <TopNav />

      <main className="pt-14 min-w-0">
        <div className="p-5">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
              {RANKINGS_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "px-2.5 py-1.5 transition-colors",
                    tab === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Host for the Options tab's min-income filter — OptionsScannerContent
                portals its control here so it sits inline with the tabs instead of
                its own row; empty/inert on the other two tabs. */}
            <div id={OPTIONS_FILTER_SLOT_ID} className="flex items-center" />
          </div>

          {tab === "fundamental" && (
            fundamentalRankings.length >= 2 ? (
              <RankingsLeaderboard scores={fundamentalRankings} stocks={loadedStocks} />
            ) : (
              <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see fundamental rankings.</p>
            )
          )}

          {tab === "technical" && (
            technicalScores.length >= 2 ? (
              <>
                {/* Lens toggle — same styling as the Options tab's Sell Puts/Sell Calls */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex items-center rounded-full border border-border/60 bg-slate-900/40 p-0.5 text-xs h-7 shrink-0">
                    <button
                      onClick={() => setTechSide("puts")}
                      className={cn(
                        "px-2.5 h-6 rounded-full transition-colors font-semibold",
                        techSide === "puts" ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
                      )}
                    >
                      Sell Puts
                    </button>
                    <button
                      onClick={() => setTechSide("calls")}
                      className={cn(
                        "px-2.5 h-6 rounded-full transition-colors font-semibold",
                        techSide === "calls" ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
                      )}
                    >
                      Sell Calls
                    </button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {techSide === "puts" ? "Oversold lens — best put-selling setups" : "Overbought lens — best call-selling setups"}
                  </span>
                </div>
                <TechnicalLeaderboard
                  scores={technicalScores}
                  rowMap={technicalRowMap}
                  side={techSide === "calls" ? "call" : "put"}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see technical rankings.</p>
            )
          )}

          {tab === "options" && (
            <OptionsScannerContent showHeader={false} />
          )}
        </div>
      </main>
    </div>
  );
}
