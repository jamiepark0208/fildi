import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { AppPage } from "@/components/app-page";
import { cn } from "@/lib/utils";
import {
  subTabClass,
  guideSubTabClass,
} from "@/lib/sub-tabs";
import { type TechnicalRow } from "@/lib/technical-rankings";

const MacroEmbedded = lazy(() => import("@/pages/macro"));
import { RegimeBanner, CHECKPOINT_TIME_PT, type RegimeCheckpoint, type RegimeOutlook } from "@/components/live/regime-banner";
import { RegimeSessionChart } from "@/components/live/regime-session-chart";
import { formatMdYy } from "@/lib/format";
import { DataTip } from "@/components/data-tip";
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
import { IndexMoversStrip } from "@/components/live/index-movers-strip";
import { TopOptionsTable } from "@/components/live/top-options-table";
import { DailyNewsPanel } from "@/components/live/daily-news-panel";
import { MarketContextStrip } from "@/components/live/market-context-strip";
import { PortfolioAlertsPanel } from "@/components/live/portfolio-alerts-panel";
import { PutManageAlerts } from "@/components/live/put-manage-alerts";
import { NewsInboxPanel } from "@/components/live/news-inbox-panel";
import { pct } from "@/components/live/live-format";
import { queryKeys } from "@/lib/query-keys";
import { useRecConflicts } from "@/hooks/use-rec-conflicts";
import { useMoverFacts } from "@/hooks/use-mover-facts";

interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  asOf?: string;
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

async function fetchRegime(): Promise<{ checkpoints: RegimeCheckpoint[]; outlook: RegimeOutlook }> {
  const r = await fetch("/api/live/regime", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  const body = await r.json();
  // Tolerate older array-shaped responses during rolling deploys.
  if (Array.isArray(body)) return { checkpoints: body, outlook: {} };
  return {
    checkpoints: body.checkpoints ?? [],
    outlook: body.outlook ?? {},
  };
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
  const priceStr = quote.price != null
    ? quote.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
  return (
    <div className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0">
      <span className="text-[11px] font-mono font-semibold text-white">{label ?? quote.ticker}</span>
      <span className="text-[11px] font-mono text-sky-300/80">{priceStr}</span>
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
  if (asiaContext.length === 0) {
    return (
      <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto">
        <IndexMoversStrip />
      </div>
    );
  }
  const changes = asiaContext.map(q => q.changePercent).filter((v): v is number => v != null);
  const positive = changes.filter(c => c > 0).length;
  const negative = changes.filter(c => c < 0).length;
  let badgeLabel = "Asia: Mixed overnight";
  let badgeClass = "text-amber-50";
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

  // Freshest quote stamp among Asia indices — cache write time, not a daily memo.
  const asOfIso = asiaContext
    .map((q) => q.asOf)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  const asOfLabel = asOfIso
    ? `as of ${formatMdYy(asOfIso)} ${new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(asOfIso))} PT`
    : null;

  const tip = [
    catalystLabel.replace(/^—\s*/, ""),
    asOfLabel,
    "Display-only overnight read — does not feed Model List or regime.",
  ].filter(Boolean).join("\n");

  return (
    <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto">
      <IndexMoversStrip />
      {asiaContext.map(q => (
        <MarketContextChip key={q.ticker} quote={q} label={ASIA_TICKER_LABELS[q.ticker] ?? q.ticker} />
      ))}
      <DataTip tip={tip}>
        <span className={cn("text-[11px] font-medium shrink-0 cursor-default", badgeClass)}>{badgeLabel}</span>
      </DataTip>
    </div>
  );
}

type PageTab = "market" | "macro" | "news" | "alerts";
type SubTab = "sell" | "candidates";
type MarketSection = "puts" | "oversold" | "calls" | "overbought";
type NewsSection = "daily" | "inbox";
type AlertsSection = "book" | "manage";

const PAGE_TABS: { id: PageTab; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "macro", label: "Macro" },
  { id: "news", label: "News" },
  { id: "alerts", label: "Portfolio Alerts" },
];

const LIVE_TAB_HUE = { market: "sky", macro: "violet", news: "amber", alerts: "rose" } as const;

const MARKET_SECTIONS: { id: MarketSection; label: string; side: HotlistSide; sub: SubTab }[] = [
  { id: "puts", label: "Top Puts", side: "dip", sub: "sell" },
  { id: "oversold", label: "Oversold", side: "dip", sub: "candidates" },
  { id: "calls", label: "Top Calls", side: "rally", sub: "sell" },
  { id: "overbought", label: "Overbought", side: "rally", sub: "candidates" },
];

const NEWS_SECTIONS: { id: NewsSection; label: string }[] = [
  { id: "daily", label: "Daily Brief" },
  { id: "inbox", label: "Inbox" },
];

const ALERTS_SECTIONS: { id: AlertsSection; label: string }[] = [
  { id: "book", label: "Book Risk" },
  { id: "manage", label: "Put Manage" },
];

function marketSectionFrom(side: HotlistSide, sub: SubTab): MarketSection {
  return MARKET_SECTIONS.find((t) => t.side === side && t.sub === sub)?.id ?? "puts";
}

/** Shared L2 strip chrome — matches Macro section tabs. */
function SectionTabStrip({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="shrink-0 px-6 py-1.5 overflow-x-auto">
      <div className="flex items-center gap-2 flex-nowrap min-w-0">
        <div className="inline-flex items-center gap-0.5 flex-wrap shrink-0">{children}</div>
        {trailing != null && <div className="ml-auto flex items-center gap-2 shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}

function PageTabToggle({ tab, onChange }: { tab: PageTab; onChange: (t: PageTab) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 flex-wrap shrink-0">
      {PAGE_TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={subTabClass(tab === id, LIVE_TAB_HUE[id], "md")}
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

  /** Session chart symbol — SPY/QQQ toggles or click from movers/hotlist. */
  const [chartSymbol, setChartSymbol] = useState("SPY");

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
  const marketSection = marketSectionFrom(side, subTab);
  const [newsSection, setNewsSection] = useState<NewsSection>(() => {
    try {
      const v = localStorage.getItem("fildi_live_news");
      return NEWS_SECTIONS.some((t) => t.id === v) ? (v as NewsSection) : "daily";
    } catch { return "daily"; }
  });
  useEffect(() => { try { localStorage.setItem("fildi_live_news", newsSection); } catch { /* */ } }, [newsSection]);
  const [alertsSection, setAlertsSection] = useState<AlertsSection>(() => {
    try {
      const v = localStorage.getItem("fildi_live_alerts");
      return ALERTS_SECTIONS.some((t) => t.id === v) ? (v as AlertsSection) : "book";
    } catch { return "book"; }
  });
  useEffect(() => { try { localStorage.setItem("fildi_live_alerts", alertsSection); } catch { /* */ } }, [alertsSection]);

  function selectMarketSection(id: MarketSection) {
    const t = MARKET_SECTIONS.find((x) => x.id === id);
    if (!t) return;
    setSide(t.side);
    setSubTab(t.sub);
  }

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

  // Facts (IV/earnings) load after the board — was blocking /live/movers cold path.
  const moverFactInputs = useMemo(() => {
    const lists = movers?.global;
    if (!lists) return { tickers: [] as string[], pct: {} as Record<string, number | null> };
    const all = [...lists.gainers, ...lists.losers, ...lists.mostActive];
    const pctMap: Record<string, number | null> = {};
    const tickers: string[] = [];
    for (const m of all) {
      const t = m.ticker.toUpperCase();
      if (m.changePercent == null || Math.abs(m.changePercent) < 5) continue;
      if (pctMap[t] != null) continue;
      pctMap[t] = m.changePercent;
      tickers.push(t);
    }
    return { tickers, pct: pctMap };
  }, [movers]);
  const { data: moverFacts } = useMoverFacts(moverFactInputs.tickers, 5, moverFactInputs.pct);

  const { data: regimePayload } = useQuery({
    queryKey: ["live-regime"],
    queryFn: fetchRegime,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const regime = regimePayload?.checkpoints;
  const regimeOutlook = regimePayload?.outlook;

  // Candidates / hotlist-only — defer until that sub-tab is open.
  const needCandidates = pageTab === "market" && subTab === "candidates";
  // Entry verdicts also feed the session-chart header on ticker click (Market tab).
  const needEntrySignals = pageTab === "market";

  const { data: entrySignals } = useQuery({
    queryKey: ["live-entry-signals"],
    queryFn: fetchEntrySignals,
    refetchInterval: 60_000,
    enabled: needEntrySignals,
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
        .map(s => [s.ticker.toUpperCase(), s]),
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
    <AppPage contentClassName="px-0 pb-0">
      <div className="w-full flex flex-col min-h-0">
        {/* L1 — page tabs (Market / Macro / News / Alerts) */}
        <div className="shrink-0 border-b border-[#d4af37]/15 bg-zinc-950 px-6 py-2 overflow-x-auto">
          <PageTabToggle tab={pageTab} onChange={setPageTab} />
        </div>

        {/* L2 — section tabs (Macro owns its own strip inside MacroEmbedded) */}
        {pageTab === "market" && (
          <SectionTabStrip
            trailing={
              <>
                <button
                  type="button"
                  onClick={() => refreshMutation.mutate()}
                  disabled={refreshMutation.isPending}
                  className={cn(
                    "inline-flex items-center gap-1 h-7 px-2.5 shrink-0 rounded border border-[#d4af37]/20",
                    "bg-zinc-950 text-[11px] font-semibold text-white/80 hover:text-white hover:bg-white/10 transition-colors",
                    "disabled:opacity-50 disabled:pointer-events-none",
                  )}
                  title="Refresh hotlist + live prices"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
                  Refresh
                </button>
                <span className="text-[10px] text-white whitespace-nowrap shrink-0 tabular-nums">
                  {lastRefreshedLabel}
                </span>
                {!isLoading && !data?.lastRefreshedAt && (
                  <span className="text-[10px] text-amber-200/60 whitespace-nowrap">No data yet</span>
                )}
              </>
            }
          >
            {MARKET_SECTIONS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectMarketSection(t.id)}
                className={guideSubTabClass(marketSection === t.id)}
              >
                {t.label}
              </button>
            ))}
          </SectionTabStrip>
        )}
        {pageTab === "news" && (
          <SectionTabStrip>
            {NEWS_SECTIONS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setNewsSection(t.id)}
                className={guideSubTabClass(newsSection === t.id)}
              >
                {t.label}
              </button>
            ))}
          </SectionTabStrip>
        )}
        {pageTab === "alerts" && (
          <SectionTabStrip>
            {ALERTS_SECTIONS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setAlertsSection(t.id)}
                className={guideSubTabClass(alertsSection === t.id)}
              >
                {t.label}
              </button>
            ))}
          </SectionTabStrip>
        )}

        {pageTab === "macro" ? (
          <Suspense fallback={
            <div className="flex items-center justify-center min-h-[40vh]">
              <Loader2 className="h-6 w-6 animate-spin text-amber-200/40" />
            </div>
          }>
            <MacroEmbedded embedded />
          </Suspense>
        ) : pageTab === "alerts" ? (
          <div className="px-6 py-3 max-w-5xl mx-auto w-full space-y-3">
            {alertsSection === "book" ? <PortfolioAlertsPanel /> : <PutManageAlerts />}
          </div>
        ) : pageTab === "news" ? (
          <div className="px-4 pt-1 pb-3 max-w-6xl mx-auto w-full space-y-2">
            {newsSection === "daily" ? <DailyNewsPanel compact /> : <NewsInboxPanel />}
          </div>
        ) : (
          <div className="px-6 py-3 max-w-5xl mx-auto w-full space-y-1.5">
            <AsiaOvernightRow
              asiaContext={data?.asiaContext ?? []}
              hasCatalystToday={data?.hasCatalystToday ?? false}
              catalystCalendarStale={data?.catalystCalendarStale ?? false}
            />
            <MarketContextStrip />

            <RegimeBanner checkpoints={regime} outlook={regimeOutlook} />
            <RegimeSessionChart
              symbol={chartSymbol}
              onSymbolChange={setChartSymbol}
              checkpoints={regime}
              outlook={regimeOutlook}
              entrySignal={entryByTicker.get(chartSymbol.toUpperCase())}
              entryAsOf={entryAsOf}
            />

            <PatternDigestCard />

            <section className="space-y-1">
              {moversLoading && !movers ? (
                <p className="text-[11px] text-amber-200/40">Loading movers…</p>
              ) : (
                <div className="relative grid grid-cols-3 gap-3">
                  {moversFetching && movers && (
                    <span className="absolute -top-4 right-0 text-[9px] text-amber-200/35 tabular-nums">updating…</span>
                  )}
                  <MoverHeatmapGrid title="Gainers" movers={movers?.global.gainers ?? []} showVolume facts={moverFacts} onTickerClick={setChartSymbol} />
                  <MoverHeatmapGrid title="Losers" movers={movers?.global.losers ?? []} showVolume facts={moverFacts} onTickerClick={setChartSymbol} />
                  <MoverHeatmapGrid title="Most Active" movers={movers?.global.mostActive ?? []} showVolume facts={moverFacts} onTickerClick={setChartSymbol} />
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
                  onTickerClick={setChartSymbol}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </AppPage>
  );
}
