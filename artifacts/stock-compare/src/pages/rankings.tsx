import { useEffect, useMemo } from "react";
import { useSessionState } from "@/hooks/use-session-state";
import { useQuery } from "@tanstack/react-query";
import { AppPage } from "@/components/app-page";
import { RankingsLeaderboard } from "@/components/rankings-leaderboard";
import { TechnicalLeaderboard } from "@/components/technical-leaderboard";
import { OptionsScannerContent, OPTIONS_FILTER_SLOT_ID } from "@/pages/options-scanner";
import { type StockScore } from "@/lib/rankings";
import { type TechnicalRow, computeTechnicalRankingsV2 } from "@/lib/technical-rankings";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { queryKeys } from "@/lib/query-keys";
import { StructuresHub } from "@/components/options-structures/StructuresHub";
import { STRUCTURES_META_SLOT_ID } from "@/components/options-structures/structure-slots";
import { RankingsRules } from "@/components/rankings-rules";
import { PutLadder } from "@/components/options-structures/PutLadder";
import { RANKINGS_TAB_HUE, scopePairClass, subTabClass } from "@/lib/sub-tabs";

const RANKINGS_TABS: { id: "fundamental" | "technical" | "options" | "strategies" | "ladder" | "rules"; label: string }[] = [
  { id: "fundamental", label: "Fundamentals" },
  { id: "technical",   label: "Technicals" },
  { id: "options",     label: "Options" },
  { id: "strategies",  label: "Structures" }, // Lab (S076+A192) + nested Long options (S086)
  { id: "ladder",      label: "Ladder" },     // S088: sold puts + covered calls, every |Δ| band × 1/2/4 wk side by side + today's names per band
  { id: "rules",       label: "Rules" },      // every input × strategy: wants high/low, verdict, live where (strategy_rules.json)
];

// Rankings-only view: same two leaderboards shown on Fundamental/Technical
// pages, without the compare-shelf chart or ticker-search UI.
export default function Rankings() {
  const [tab, setTab] = useSessionState<"fundamental" | "technical" | "options" | "strategies" | "ladder" | "rules">("fildi_rankings_tab", "fundamental");
  // Migrate old top-level / nested "Long options" → Structures (long call/put rows).
  useEffect(() => {
    if ((tab as string) === "long") setTab("strategies");
  }, [tab, setTab]);
  // Technical tab lens: oversold (sell puts) vs overbought (sell calls) — mirrors the
  // Options tab's page-level Sell Puts/Sell Calls toggle, persisted independently.
  const [techSide, setTechSide] = useSessionState<"puts" | "calls">("fildi_technical_side", "puts");
  // Options: Watchlist (live scanner) vs Overall (nightly premium-IV snapshots).
  const [optionsScope, setOptionsScope] = useSessionState<"watchlist" | "overall">("fildi_options_scope", "watchlist");
  const { weights } = useScoringPreferences();

  // Fundamentals tab used to also fan out /stocks/quotes for the whole watchlist
  // (Yahoo × N) and always pull /technicals/all — that starved the main thread /
  // Yahoo pool and made Fundamentals feel stuck. Names fall back to ticker;
  // explain already has peerGroup on the score row.
  const { data: serverRankings, isLoading: fundLoading } = useQuery({
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
    enabled: tab === "fundamental",
  });

  const fundamentalRankings = useMemo((): StockScore[] => {
    if (!serverRankings?.length) return [];
    return [...serverRankings]
      // Unranked tickers (coverage too thin) are dropped rather than shown at rank 0 —
      // this is what kept WTR at #1 of 558 off the strength of a single metric.
      .filter(r => r.ranked && r.totalScore !== null)
      .sort((a, b) => a.rank - b.rank)
      .map(r => ({
        ticker:       r.ticker,
        companyName:  r.ticker,
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
  }, [serverRankings]);

  const { data: allTechnicalsData, isLoading: techLoading } = useQuery({
    queryKey: queryKeys.technicalsAll,
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all", { credentials: "include" });
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: tab === "technical",
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
    <AppPage className="bg-background selection:bg-primary/30" contentClassName="p-3">
          <div className="flex items-center gap-1 mb-2 flex-wrap">
            {/* L1 — colored page tabs (same as Live Market/Macro/News) */}
            <div className="inline-flex items-center gap-0.5 flex-wrap">
              {RANKINGS_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={subTabClass(tab === t.id, RANKINGS_TAB_HUE[t.id] ?? "gold", "md")}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* L2 — gold scope / side (same as Live Sell Puts · Oversold strip) */}
            {(tab === "options" || tab === "technical") && (
              <span className="mx-0.5 h-4 w-px bg-[#d4af37]/25 shrink-0 self-center" aria-hidden />
            )}

            {/* Fixed order on Options: Scope → Sell Puts/Calls → filters (portal).
                Sell Puts also shows on Technical. Never reshuffle when flipping scope. */}
            {tab === "options" && (
              <div className="inline-flex items-center gap-0.5 shrink-0">
                <button type="button" onClick={() => setOptionsScope("watchlist")} className={scopePairClass(optionsScope === "watchlist")}>
                  Watchlist
                </button>
                <button type="button" onClick={() => setOptionsScope("overall")} className={scopePairClass(optionsScope === "overall")}>
                  Overall
                </button>
              </div>
            )}

            {(tab === "technical" || tab === "options") && (
              <div className="inline-flex items-center gap-0.5 shrink-0">
                <button type="button" onClick={() => setTechSide("puts")} className={scopePairClass(techSide === "puts")}>
                  Sell Puts
                </button>
                <button type="button" onClick={() => setTechSide("calls")} className={scopePairClass(techSide === "calls")}>
                  Sell Calls
                </button>
              </div>
            )}

            {/* Right side of tab row: Options filters and/or Structures meta (portal targets). */}
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 ml-auto min-w-0">
              <div id={OPTIONS_FILTER_SLOT_ID} className="flex items-center" />
              {tab === "strategies" ? (
                <div
                  id={STRUCTURES_META_SLOT_ID}
                  className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 min-w-0 text-[11px]"
                />
              ) : null}
            </div>
          </div>

          {tab === "fundamental" && (
            fundLoading ? (
              <p className="text-sm text-muted-foreground animate-pulse">Loading fundamental rankings…</p>
            ) : fundamentalRankings.length >= 2 ? (
              <RankingsLeaderboard
                scores={fundamentalRankings}
                scoredAsOf={serverRankings?.[0]?.computedAt ?? null}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No fundamental rankings yet — scores rebuild after nightly enrichment.</p>
            )
          )}

          {tab === "technical" && (
            techLoading ? (
              <p className="text-sm text-muted-foreground animate-pulse">Loading technical rankings…</p>
            ) : technicalScores.length >= 2 ? (
              <TechnicalLeaderboard
                scores={technicalScores}
                rowMap={technicalRowMap}
                side={techSide === "calls" ? "call" : "put"}
                scoredAsOf={technicalScoredAsOf}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No technical rankings yet — open Technical once scores are cached.</p>
            )
          )}

          {tab === "strategies" && <StructuresHub />}

          {tab === "ladder" && <PutLadder />}

          {tab === "rules" && <RankingsRules />}

          {tab === "options" && (
            <OptionsScannerContent
              showHeader={false}
              universe={optionsScope}
              side={techSide}
              onSideChange={setTechSide}
            />
          )}
    </AppPage>
  );
}
