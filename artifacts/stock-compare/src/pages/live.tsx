import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";
import { type TechnicalRow } from "@/lib/technical-rankings";

const MacroEmbedded = lazy(() => import("@/pages/macro"));
import { RegimeBanner, CHECKPOINT_TIME_PT, type RegimeCheckpoint } from "@/components/live/regime-banner";
import { PatternDigestCard } from "@/components/live/pattern-digest-card";
import {
  HotlistTable,
  VERDICT_LABEL,
  type HotlistSide,
  type HotlistEntry,
  type EntrySignal,
  type EntryVerdict,
} from "@/components/live/hotlist-table";
import { MoverHeatmapGrid, type MoversResponse } from "@/components/live/movers";
import { TopOptionsTable } from "@/components/live/top-options-table";
import { DailyNewsPanel } from "@/components/live/daily-news-panel";
import { PortfolioAlertsPanel } from "@/components/live/portfolio-alerts-panel";
import { NewsInboxPanel } from "@/components/live/news-inbox-panel";
import { pct } from "@/components/live/live-format";
import { queryKeys } from "@/lib/query-keys";
import { useRecConflicts } from "@/hooks/use-rec-conflicts";

interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

interface LiveState {
  hotlist: HotlistEntry[];
  rallyHotlist: HotlistEntry[];
  marketContext: MarketContextQuote[];
  asiaContext: MarketContextQuote[];
  hasCatalystToday: boolean;
  catalystCalendarStale: boolean;
  lastRefreshedAt: number | null;
}

const ASIA_TICKER_LABELS: Record<string, string> = {
  "^KS11": "KOSPI",
  "^N225": "Nikkei",
  "^HSI": "Hang Seng",
};

async function apiLive(path: string, opts?: RequestInit): Promise<LiveState> {
  const r = await fetch(`/api/live${path}`, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function fetchMovers(): Promise<MoversResponse> {
  const r = await fetch("/api/live/movers", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function fetchRegime(): Promise<RegimeCheckpoint[]> {
  const r = await fetch("/api/live/regime", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

interface EntrySignalsSnapshot {
  computedAt: number;
  afterCheckpointMin: number | null;
  regimeDirection: RegimeCheckpoint["direction"];
  regimeConfidence: number | null;
  signals: EntrySignal[];
}

async function fetchEntrySignals(): Promise<EntrySignalsSnapshot | null> {
  const r = await fetch("/api/live/entry-signals", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

interface VerdictStats { n: number; avgFwd1dPct: number | null; avgFwd5dPct: number | null }
interface EntryStatsResponse {
  days: number;
  gradedDays: number;
  dip: Record<EntryVerdict, VerdictStats>;
  rally: Record<EntryVerdict, VerdictStats>;
}

async function fetchEntryStats(): Promise<EntryStatsResponse> {
  const r = await fetch("/api/live/entry-stats", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function MarketContextChip({ quote, label }: { quote: MarketContextQuote; label?: string }) {
  const up = (quote.changePercent ?? 0) >= 0;
  return (
    <div className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0">
      <span className="text-[11px] font-mono font-semibold text-white">{label ?? quote.ticker}</span>
      <span className="text-[11px] font-mono text-sky-300/80">{quote.price != null ? quote.price.toFixed(2) : "—"}</span>
      <span className={cn("text-[11px] font-mono font-medium", up ? "text-green-500" : "text-red-500")}>
        {pct(quote.changePercent)}
      </span>
    </div>
  );
}

/** Overnight Asia read (KOSPI/Nikkei/HSI close before the US session opens) + whether
 * today has a scheduled high-importance US catalyst likely to dominate instead. Display-only. */
function AsiaOvernightRow({
  asiaContext,
  hasCatalystToday,
  catalystCalendarStale,
}: {
  asiaContext: MarketContextQuote[];
  hasCatalystToday: boolean;
  catalystCalendarStale: boolean;
}) {
  if (asiaContext.length === 0) return null;
  const changes = asiaContext.map(q => q.changePercent).filter((v): v is number => v != null);
  const positive = changes.filter(c => c > 0).length;
  const negative = changes.filter(c => c < 0).length;
  let badgeLabel = "Asia: Mixed overnight";
  let badgeClass = "text-zinc-300";
  if (changes.length > 0 && positive >= 2) { badgeLabel = "Asia: Risk-On overnight"; badgeClass = "text-emerald-400"; }
  else if (changes.length > 0 && negative >= 2) { badgeLabel = "Asia: Risk-Off overnight"; badgeClass = "text-red-400"; }

  // Once the macro calendar runs past its last known event, "no catalyst today"
  // stops being a confirmed read and becomes "no data for today" — say so instead
  // of asserting Asia is the likely driver on a day we simply haven't checked.
  const catalystLabel = catalystCalendarStale
    ? "— catalyst calendar needs an update, unknown"
    : hasCatalystToday
      ? "— US catalyst today, may dominate"
      : "— no major US catalyst, Asia may lead";

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {asiaContext.map(q => (
        <MarketContextChip key={q.ticker} quote={q} label={ASIA_TICKER_LABELS[q.ticker] ?? q.ticker} />
      ))}
      <span className={cn("text-[11px] font-medium shrink-0", badgeClass)}>{badgeLabel}</span>
      <span className={cn("text-[11px] shrink-0", catalystCalendarStale ? "text-amber-200" : "text-zinc-300")}>
        {catalystLabel}
      </span>
    </div>
  );
}

/** Oversold vs Overbought — page-level mode (mirrors the scanner's puts/calls toggle). */
function SideToggle({ side, onChange }: { side: HotlistSide; onChange: (s: HotlistSide) => void }) {
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold shrink-0">
      {([
        ["dip", "Oversold"],
        ["rally", "Overbought"],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            "px-2 py-1 transition-colors",
            side === value
              ? value === "dip" ? "bg-green-600 text-white" : "bg-red-600 text-white"
              : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

type PageTab = "market" | "macro" | "news" | "alerts";
type SubTab = "sell" | "candidates";

const PAGE_TABS: { id: PageTab; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "macro", label: "Macro" },
  { id: "news", label: "News" },
  { id: "alerts", label: "Portfolio Alerts" },
];

function PageTabToggle({ tab, onChange }: { tab: PageTab; onChange: (t: PageTab) => void }) {
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold shrink-0">
      {PAGE_TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "px-2.5 py-1 transition-colors",
            tab === id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Sub-tabs inside Market — labels flip with side. */
function SubTabToggle({
  side,
  subTab,
  onChange,
  candidateCount,
}: {
  side: HotlistSide;
  subTab: SubTab;
  onChange: (t: SubTab) => void;
  candidateCount: number;
}) {
  const sellLabel = side === "rally" ? "Top Calls" : "Top Puts";
  const candidatesLabel = side === "rally" ? "Overbought" : "Oversold";
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
      {([
        ["sell", sellLabel],
        ["candidates", `${candidatesLabel} (${candidateCount})`],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "px-2 py-1 transition-colors",
            subTab === value ? "bg-[#d4af37]/80 text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Live() {
  const queryClient = useQueryClient();

  // Persisted like the scanner's fildi_scanner_mode — the whole page is scoped to one side at a time.
  const [side, setSide] = useState<HotlistSide>(() => {
    try { return (localStorage.getItem("fildi_live_side") as HotlistSide) || "dip"; } catch { return "dip"; }
  });
  useEffect(() => { try { localStorage.setItem("fildi_live_side", side); } catch { /* private mode */ } }, [side]);
  const isRally = side === "rally";

  const [pageTab, setPageTab] = useState<PageTab>(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("page");
      if (fromUrl && PAGE_TABS.some((t) => t.id === fromUrl)) return fromUrl as PageTab;
      const stored = localStorage.getItem("fildi_live_page") as PageTab | null;
      if (stored && PAGE_TABS.some((t) => t.id === stored)) return stored;
    } catch { /* */ }
    return "market";
  });
  useEffect(() => { try { localStorage.setItem("fildi_live_page", pageTab); } catch { /* */ } }, [pageTab]);
  // Deep-link: /live?page=macro (&tab=… handled by Macro)
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("page");
    if (fromUrl && PAGE_TABS.some((t) => t.id === fromUrl)) setPageTab(fromUrl as PageTab);
  }, []);

  const [subTab, setSubTab] = useState<SubTab>("sell");

  const { data, isLoading } = useQuery({
    queryKey: ["live-state"],
    queryFn: () => apiLive("/state"),
    // Cold post-restart: server returns empty immediately and warms in background.
    refetchInterval: (q) => (q.state.data?.lastRefreshedAt == null ? 2_000 : false),
    staleTime: 60_000,
  });

  const { data: movers, isLoading: moversLoading, isFetching: moversFetching } = useQuery({
    queryKey: ["live-movers"],
    queryFn: fetchMovers,
    // Match Yahoo screener TTL (5m) — efficiency-playbook Live movers row.
    staleTime: 5 * 60_000,
    // Keep last board while refetching so Live never blanks to "Loading movers…".
    placeholderData: (prev) => prev,
  });

  const { data: regime } = useQuery({
    queryKey: ["live-regime"],
    queryFn: fetchRegime,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Candidates / hotlist-only — defer until that sub-tab is open.
  const needCandidates = pageTab === "market" && subTab === "candidates";

  const { data: entrySignals } = useQuery({
    queryKey: ["live-entry-signals"],
    queryFn: fetchEntrySignals,
    refetchInterval: 60_000,
    enabled: needCandidates,
    staleTime: 60_000,
  });

  const { data: entryStats } = useQuery({
    queryKey: ["live-entry-stats"],
    queryFn: fetchEntryStats,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    enabled: needCandidates,
  });

  const { data: fundRankingsData } = useQuery({
    queryKey: ["fundamentals", "rankings", "slim"],
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings?slim=1");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    enabled: needCandidates,
  });

  const techSide: "put" | "call" = isRally ? "call" : "put";
  const { data: allTechnicalsData } = useQuery({
    queryKey: queryKeys.technicalsAllSlim,
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all?slim=1", { credentials: "include" });
      if (!res.ok) throw new Error("technicals/all slim fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needCandidates,
  });

  const { data: techRankingsData } = useQuery({
    queryKey: queryKeys.technicalsRankings(techSide),
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch(`/api/technicals/rankings?side=${techSide}`, { credentials: "include" });
      if (!res.ok) throw new Error("technicals/rankings fetch failed");
      return res.json();
    },
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needCandidates,
  });

  const fundScoreMap = useMemo(
    () => new Map((fundRankingsData ?? []).map(r => [r.ticker, r.totalScore])),
    [fundRankingsData],
  );

  // Side-aware V2 totals from API (same put/call switch as Options).
  const techScoreMap = useMemo(() => {
    if (!techRankingsData?.length) return new Map<string, number>();
    return new Map(techRankingsData.map((s) => [s.ticker, s.totalScore]));
  }, [techRankingsData]);

  // Raw technicals rows by ticker — ER proximity / IV rank / support levels / falling-knife
  // are all already computed nightly and shipped in this payload; no extra fetch.
  const techRowMap = useMemo(
    () => new Map((allTechnicalsData ?? []).map(r => [r.ticker, r])),
    [allTechnicalsData],
  );

  const refreshMutation = useMutation({
    mutationFn: () => apiLive("/refresh", { method: "POST" }),
    onSuccess: (next) => {
      queryClient.setQueryData(["live-state"], next);
      queryClient.invalidateQueries({ queryKey: ["live-movers"] });
    },
  });

  const lastRefreshedLabel = data?.lastRefreshedAt
    ? new Date(data.lastRefreshedAt).toLocaleTimeString()
    : "never";

  // Dip: most oversold first. Rally: most overbought first.
  const sortedHotlist = useMemo(() => {
    const list = isRally ? data?.rallyHotlist : data?.hotlist;
    return [...(list ?? [])].sort((a, b) => (isRally ? b.rsi - a.rsi : a.rsi - b.rsi));
  }, [data, isRally]);

  // Pre-side snapshots have no `side` on signals — treat them as dip.
  const entryByTicker = useMemo(
    () => new Map(
      (entrySignals?.signals ?? [])
        .filter(s => (s.side ?? "dip") === side)
        .map(s => [s.ticker, s]),
    ),
    [entrySignals, side],
  );
  const entryAsOf = entrySignals?.afterCheckpointMin != null
    ? (CHECKPOINT_TIME_PT[entrySignals.afterCheckpointMin] ?? `${entrySignals.afterCheckpointMin}m after open`)
    : null;

  const sideStats = isRally ? entryStats?.rally : entryStats?.dip;

  const dipTickers = useMemo(() => (data?.hotlist ?? []).map(e => e.ticker), [data?.hotlist]);
  const rallyTickers = useMemo(() => (data?.rallyHotlist ?? []).map(e => e.ticker), [data?.rallyHotlist]);
  const { byTicker: conflictsByTicker } = useRecConflicts(dipTickers, rallyTickers);

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />
      <main className={cn("pt-14", pageTab === "macro" ? "px-0 pb-0" : "p-6")}>
        <div className={cn(pageTab === "macro" ? "w-full" : "max-w-5xl mx-auto space-y-3")}>
          <div className={cn(
            "flex items-center gap-2 flex-nowrap overflow-x-auto",
            pageTab === "macro" && "px-6 py-2 border-b border-[#d4af37]/15 bg-zinc-950",
          )}>
            <PageTabToggle tab={pageTab} onChange={setPageTab} />
            {pageTab === "market" && (
              <>
                <SideToggle side={side} onChange={setSide} />
                <span
                  className="text-[10px] text-amber-200/40 whitespace-nowrap shrink-0 hidden sm:inline"
                  title="Backtest 2020–26 (scorecard lab): oversold / reversal / short-term signals showed no edge, and dip-buying did worse in broad selloffs. Trade ideas: Watchlist → Model List."
                >
                  RSI-side extremes, unvalidated · Model List decides
                </span>
                <SubTabToggle side={side} subTab={subTab} onChange={setSubTab} candidateCount={sortedHotlist.length} />
                <button
                  type="button"
                  onClick={() => refreshMutation.mutate()}
                  disabled={refreshMutation.isPending}
                  className={cn(
                    "inline-flex items-center gap-1 h-7 px-2.5 shrink-0 rounded border border-[#d4af37]/20",
                    "bg-zinc-950 text-[11px] font-semibold text-amber-200/70 hover:text-[#d4af37] transition-colors",
                    "disabled:opacity-50 disabled:pointer-events-none",
                  )}
                  title="Refresh hotlist + live prices"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
                  Refresh
                </button>
                <span className="text-[10px] text-amber-200/40 whitespace-nowrap shrink-0 tabular-nums">
                  {lastRefreshedLabel}
                </span>
                {!isLoading && !data?.lastRefreshedAt && (
                  <span className="text-[10px] text-amber-200/60 whitespace-nowrap">No data yet</span>
                )}
              </>
            )}
          </div>

          {pageTab === "macro" ? (
            <Suspense fallback={
              <div className="flex items-center justify-center min-h-[40vh]">
                <Loader2 className="h-6 w-6 animate-spin text-amber-200/40" />
              </div>
            }>
              <MacroEmbedded embedded />
            </Suspense>
          ) : pageTab === "alerts" ? (
            <PortfolioAlertsPanel />
          ) : pageTab === "news" ? (
            <div className="space-y-3">
              <DailyNewsPanel compact />
              <NewsInboxPanel />
            </div>
          ) : (
            <>
              <AsiaOvernightRow
                asiaContext={data?.asiaContext ?? []}
                hasCatalystToday={data?.hasCatalystToday ?? false}
                catalystCalendarStale={data?.catalystCalendarStale ?? false}
              />

              <RegimeBanner checkpoints={regime} />

              <PatternDigestCard />

              <section className="space-y-1.5">
                {moversLoading && !movers ? (
                  <p className="text-[11px] text-amber-200/40">Loading movers…</p>
                ) : (
                  <div className="relative grid grid-cols-3 gap-3">
                    {moversFetching && movers && (
                      <span className="absolute -top-4 right-0 text-[9px] text-amber-200/35 tabular-nums">updating…</span>
                    )}
                    <MoverHeatmapGrid title="Gainers" movers={movers?.global.gainers ?? []} facts={movers?.facts} />
                    <MoverHeatmapGrid title="Losers" movers={movers?.global.losers ?? []} facts={movers?.facts} />
                    <MoverHeatmapGrid title="Most Active" movers={movers?.global.mostActive ?? []} showVolume facts={movers?.facts} />
                  </div>
                )}
              </section>

              <section className="space-y-1.5">
                {subTab === "candidates" && sideStats && entryStats && entryStats.gradedDays > 0 && (
                  <span
                    className="block text-[10px] font-mono text-sky-300/60"
                    title={`Forward returns of past Entry verdicts over the last ${entryStats.days} days (${entryStats.gradedDays} graded days).`}
                  >
                    {(["enter", "wait", "avoid"] as const).map((v, i) => {
                      const s = sideStats[v];
                      if (!s || s.n === 0) return null;
                      return (
                        <span key={v}>
                          {i > 0 && " · "}
                          <span className={v === "enter" ? "text-green-400" : v === "wait" ? "text-yellow-400" : "text-red-400"}>
                            {VERDICT_LABEL[v]}
                          </span>
                          {` ${s.avgFwd1dPct != null ? `${s.avgFwd1dPct >= 0 ? "+" : ""}${s.avgFwd1dPct}% 1d` : "—"}${s.avgFwd5dPct != null ? ` / ${s.avgFwd5dPct >= 0 ? "+" : ""}${s.avgFwd5dPct}% 5d` : ""} (n=${s.n})`}
                        </span>
                      );
                    })}
                    {isRally && <span className="text-amber-200/30"> (↓ fwd = good)</span>}
                  </span>
                )}
                {subTab === "sell" ? (
                  <TopOptionsTable
                    side={isRally ? "call" : "put"}
                    n={7}
                    conflictsByTicker={conflictsByTicker}
                    regimeDirection={
                      [...(regime ?? [])].reverse().find((c) => c.status === "resolved" && c.direction != null)?.direction ?? null
                    }
                    regimeConfidence={
                      [...(regime ?? [])].reverse().find((c) => c.status === "resolved" && c.direction != null)?.confidence ?? null
                    }
                  />
                ) : sortedHotlist.length === 0 ? (
                  !isLoading && (
                    <p className="text-[11px] text-amber-200/40">
                      Waiting for scanner data — click Refresh once rankings are cached.
                    </p>
                  )
                ) : (
                  <HotlistTable
                    side={side}
                    entries={sortedHotlist}
                    techRowMap={techRowMap}
                    fundScoreMap={fundScoreMap}
                    techScoreMap={techScoreMap}
                    entryByTicker={entryByTicker}
                    entryAsOf={entryAsOf}
                    conflictsByTicker={conflictsByTicker}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
