import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { TopNav } from "@/components/top-nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeTechnicalRankingsV2, type TechnicalRow } from "@/lib/technical-rankings";
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
import { MoverHeatmapGrid, SectorMoverBars, type MoversResponse } from "@/components/live/movers";
import { TopOptionsTable } from "@/components/live/top-options-table";
import { pct } from "@/components/live/live-format";

interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

interface LiveState {
  hotlist: HotlistEntry[];
  rallyHotlist: HotlistEntry[];
  marketContext: MarketContextQuote[];
  lastRefreshedAt: number | null;
}

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

function MarketContextChip({ quote }: { quote: MarketContextQuote }) {
  const up = (quote.changePercent ?? 0) >= 0;
  return (
    <div className="flex items-center gap-1 bg-zinc-950 border border-[#d4af37]/20 rounded px-1.5 py-0.5 shrink-0">
      <span className="text-[11px] font-mono font-semibold text-white">{quote.ticker}</span>
      <span className="text-[11px] font-mono text-sky-300/80">{quote.price != null ? quote.price.toFixed(2) : "—"}</span>
      <span className={cn("text-[11px] font-mono font-medium", up ? "text-green-500" : "text-red-500")}>
        {pct(quote.changePercent)}
      </span>
    </div>
  );
}

/** Oversold vs Overbought — page-level mode (mirrors the scanner's puts/calls toggle). */
function SideToggle({ side, onChange }: { side: HotlistSide; onChange: (s: HotlistSide) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[#d4af37]/25 overflow-hidden text-xs font-semibold">
      {([
        ["dip", "Oversold · Sell Puts"],
        ["rally", "Overbought · Sell Calls"],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            "px-3 py-1.5 transition-colors",
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

type SubTab = "sell" | "candidates";

/** Sub-tabs inside the combined options/candidates card — labels flip with side. */
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
  const sellLabel = side === "rally" ? "Top Calls to Sell" : "Top Puts to Sell";
  const candidatesLabel = side === "rally" ? "Overbought" : "Oversold";
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
      {([
        ["sell", sellLabel],
        ["candidates", `${candidatesLabel} (${candidateCount})`],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            "px-2 py-1 transition-colors",
            subTab === value ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
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

  const [subTab, setSubTab] = useState<SubTab>("sell");

  const { data, isLoading } = useQuery({
    queryKey: ["live-state"],
    queryFn: () => apiLive("/state"),
  });

  const { data: movers, isLoading: moversLoading } = useQuery({
    queryKey: ["live-movers"],
    queryFn: fetchMovers,
  });

  const { data: regime } = useQuery({
    queryKey: ["live-regime"],
    queryFn: fetchRegime,
    refetchInterval: 60_000,
  });

  const { data: entrySignals } = useQuery({
    queryKey: ["live-entry-signals"],
    queryFn: fetchEntrySignals,
    refetchInterval: 60_000,
  });

  const { data: entryStats } = useQuery({
    queryKey: ["live-entry-stats"],
    queryFn: fetchEntryStats,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: fundRankingsData } = useQuery({
    queryKey: ["fundamentals", "rankings"],
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: allTechnicalsData } = useQuery({
    queryKey: ["technicals", "all"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all");
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const fundScoreMap = useMemo(
    () => new Map((fundRankingsData ?? []).map(r => [r.ticker, r.totalScore])),
    [fundRankingsData],
  );

  // Side-aware V2 technical scores: put components (oversold/reversal) for dip,
  // call components (overbought/exhaustion) for rally — same switch as the scanner.
  const techScoreMap = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, number>();
    return new Map(
      computeTechnicalRankingsV2(allTechnicalsData, {}, undefined, isRally ? "call" : "put")
        .map(s => [s.ticker, s.totalScore]),
    );
  }, [allTechnicalsData, isRally]);

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

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />
      <main className="pt-14 p-6">
        <div className="max-w-5xl mx-auto space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {data?.marketContext.map((q) => <MarketContextChip key={q.ticker} quote={q} />)}
              {!isLoading && (data?.marketContext.length ?? 0) === 0 && (
                <p className="text-sm text-amber-200/40">No data yet — click Refresh.</p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-3">
                <SideToggle side={side} onChange={setSide} />
                <Button
                  onClick={() => refreshMutation.mutate()}
                  disabled={refreshMutation.isPending}
                  size="sm"
                >
                  <RefreshCw className={cn("h-4 w-4 mr-2", refreshMutation.isPending && "animate-spin")} />
                  Refresh
                </Button>
              </div>
              <SubTabToggle side={side} subTab={subTab} onChange={setSubTab} candidateCount={sortedHotlist.length} />
              <p className="text-[10px] text-amber-200/40">Last refreshed: {lastRefreshedLabel}</p>
            </div>
          </div>

          <RegimeBanner checkpoints={regime} />

          <PatternDigestCard />

          <section className="space-y-1.5">
            {moversLoading && !movers ? (
              <p className="text-sm text-amber-200/40">Loading movers…</p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3">
                  <MoverHeatmapGrid title="Gainers" movers={movers?.global.gainers ?? []} />
                  <MoverHeatmapGrid title="Losers" movers={movers?.global.losers ?? []} />
                  <MoverHeatmapGrid title="Most Active" movers={movers?.global.mostActive ?? []} showVolume />
                </div>
                {(movers?.sectors.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
                      Sector Breakdown
                    </h3>
                    <SectorMoverBars groups={movers!.sectors} />
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="space-y-1.5">
            {subTab === "candidates" && sideStats && entryStats && entryStats.gradedDays > 0 && (
              <span
                className="block text-[11px] font-mono text-sky-300/60"
                title={`Forward returns of past Entry verdicts over the last ${entryStats.days} days (${entryStats.gradedDays} graded days). Avg next-day / next-5-day return from the signal price.${isRally ? " Rally side sells calls — Enter wants NEGATIVE forward returns here." : " This is the accountability layer — if Enter doesn't beat Wait here, don't trust the verdicts."}`}
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
              <TopOptionsTable side={isRally ? "call" : "put"} n={7} />
            ) : sortedHotlist.length === 0 ? (
              !isLoading && (
                <p className="text-sm text-amber-200/40">
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
              />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
