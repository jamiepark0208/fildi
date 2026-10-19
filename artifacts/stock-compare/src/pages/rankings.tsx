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
  // Options: Watchlist (live scanner) vs Overall (nightly premium-IV snapshots).
  const [optionsScope, setOptionsScope] = useSessionState<"watchlist" | "overall">("fildi_options_scope", "watchlist");
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
      return res.json() as Promise<Array<{
        ticker: string;
        totalScore: number | null;
        companyScore?: number | null;
        sectorScore?: number | null;
        valueScore?: number | null;
        qualityScore: number | null;
        growthScore: number | null;
        safetyScore: number | null;
        coverage: { value?: number; quality: number; growth: number; safety: number; total: number };
        ranked: boolean;
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
          value:   { score: r.valueScore ?? 50, coverage: r.coverage.value ?? 0, lowCoverage: r.valueScore == null },
          quality: { score: r.qualityScore ?? 50, coverage: r.coverage.quality, lowCoverage: r.qualityScore == null },
          growth:  { score: r.growthScore  ?? 50, coverage: r.coverage.growth,  lowCoverage: r.growthScore  == null },
          safety:  { score: r.safetyScore  ?? 50, coverage: r.coverage.safety,  lowCoverage: r.safetyScore  == null },
        },
        regime: r.regime,
        peerGroupId:   r.peerGroupId ?? undefined,
        peerGroupName: r.peerGroupName ?? undefined,
        peerGroupSize: r.peerGroupSize,
        styleBucket:   r.styleBucket ?? null,
        companyScore:  r.companyScore ?? null,
        sectorScore:   r.sectorScore ?? null,
        confidence:    r.confidence ?? null,
      }));
  }, [serverRankings, loadedStocks]);

  const { data: allTechnicalsData } = useQuery({
    queryKey: queryKeys.technicalsAll,
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all", { credentials: "include" });
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

  const technicalScoredAsOf = useMemo(() => {
    if (!allTechnicalsData?.length) return null;
    let maxMs = 0;
    for (const r of allTechnicalsData) {
      const t = (r as TechnicalRow).technicalsLastFetched;
      if (!t) continue;
      const ms = new Date(t).getTime();
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }
    return maxMs > 0 ? new Date(maxMs).toISOString() : null;
  }, [allTechnicalsData]);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30">
      <TopNav />

      <main className="pt-14 min-w-0">
        <div className="p-3 min-w-0">
          <div className="flex items-center gap-1 mb-2 flex-wrap">
            <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
              {RANKINGS_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "px-2 py-1 transition-colors",
                    tab === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Fixed order on Options: Scope → Sell Puts/Calls → filters (portal).
                Sell Puts also shows on Technical. Never reshuffle when flipping scope. */}
            {tab === "options" && (
              <div className="flex items-center rounded-full border border-[#d4af37]/25 bg-zinc-950 p-0.5 text-[11px] h-6 shrink-0">
                <button
                  onClick={() => setOptionsScope("watchlist")}
                  className={cn(
                    "px-2 h-5 rounded-full transition-colors font-semibold",
                    optionsScope === "watchlist" ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  Watchlist
                </button>
                <button
                  onClick={() => setOptionsScope("overall")}
                  className={cn(
                    "px-2 h-5 rounded-full transition-colors font-semibold",
                    optionsScope === "overall" ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  Overall
                </button>
              </div>
            )}

            {(tab === "technical" || tab === "options") && (
              <div className="flex items-center rounded-full border border-[#d4af37]/25 bg-zinc-950 p-0.5 text-[11px] h-6 shrink-0">
                <button
                  onClick={() => setTechSide("puts")}
                  className={cn(
                    "px-2 h-5 rounded-full transition-colors font-semibold",
                    techSide === "puts" ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  Sell Puts
                </button>
                <button
                  onClick={() => setTechSide("calls")}
                  className={cn(
                    "px-2 h-5 rounded-full transition-colors font-semibold",
                    techSide === "calls" ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
                  )}
                >
                  Sell Calls
                </button>
              </div>
            )}

            {/* Host for Options filter Settings popover — scanner portals here */}
            <div id={OPTIONS_FILTER_SLOT_ID} className="flex items-center ml-auto" />
          </div>

          {tab === "fundamental" && (
            fundamentalRankings.length >= 2 ? (
              <RankingsLeaderboard
                scores={fundamentalRankings}
                stocks={loadedStocks}
                scoredAsOf={serverRankings?.[0]?.computedAt ?? null}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see fundamental rankings.</p>
            )
          )}

          {tab === "technical" && (
            technicalScores.length >= 2 ? (
              <TechnicalLeaderboard
                scores={technicalScores}
                rowMap={technicalRowMap}
                side={techSide === "calls" ? "call" : "put"}
                scoredAsOf={technicalScoredAsOf}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Add at least 2 tickers to your watchlist to see technical rankings.</p>
            )
          )}

          {tab === "options" && (
            <OptionsScannerContent
              showHeader={false}
              universe={optionsScope}
              side={techSide}
              onSideChange={setTechSide}
            />
          )}
        </div>
      </main>
    </div>
  );
}
