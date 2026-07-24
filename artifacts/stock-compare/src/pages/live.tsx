import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { TopNav } from "@/components/top-nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { computeTechnicalRankingsV2, type TechnicalRow } from "@/lib/technical-rankings";

interface HotlistEntry {
  ticker: string;
  price: number;
  rsi: number;
  ivCurrent: number;
  return5d: number | null;
  stoch: number | null;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
}

interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

interface LiveState {
  hotlist: HotlistEntry[];
  marketContext: MarketContextQuote[];
  lastRefreshedAt: number | null;
}

interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

interface SectorMover {
  ticker: string;
  price: number;
  changePercent: number;
}

interface SectorMoverGroup {
  sector: string;
  avgChangePercent: number;
  tickerCount: number;
  topGainers: SectorMover[];
  topLosers: SectorMover[];
}

interface MoversResponse {
  global: { gainers: ScreenerMover[]; losers: ScreenerMover[]; mostActive: ScreenerMover[] };
  sectors: SectorMoverGroup[];
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

type RegimeDirection = "bullish" | "bearish" | "mixed";

interface RegimeCheckpoint {
  minAfterOpen: number;
  status: "pending" | "resolved";
  direction: RegimeDirection | null;
  confidence: number | null;
  label: string;
  computedLate: boolean;
  factors: string[];
}

// Market open is always 9:30 ET / 6:30 PT — both zones shift together on DST, so
// these are safe to hardcode rather than trust a computed label round-trip.
const CHECKPOINT_TIME_PT: Record<number, string> = {
  15: "6:45 AM PT",
  30: "7:00 AM PT",
  45: "7:15 AM PT",
  60: "7:30 AM PT",
  90: "8:00 AM PT",
  120: "8:30 AM PT",
  150: "9:00 AM PT",
  180: "9:30 AM PT",
};

async function fetchRegime(): Promise<RegimeCheckpoint[]> {
  const r = await fetch("/api/live/regime", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

type EntryVerdict = "enter" | "wait" | "avoid";

interface EntrySignal {
  ticker: string;
  price: number;
  direction: RegimeDirection | null;
  score: number;
  verdict: EntryVerdict;
  factors: string[];
}

interface EntrySignalsSnapshot {
  computedAt: number;
  afterCheckpointMin: number | null;
  regimeDirection: RegimeDirection | null;
  regimeConfidence: number | null;
  signals: EntrySignal[];
}

async function fetchEntrySignals(): Promise<EntrySignalsSnapshot | null> {
  const r = await fetch("/api/live/entry-signals", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

interface VerdictStats { n: number; avgFwd1dPct: number | null; avgFwd5dPct: number | null }
interface EntryStatsResponse { days: number; gradedDays: number; perVerdict: Record<EntryVerdict, VerdictStats> }

async function fetchEntryStats(): Promise<EntryStatsResponse> {
  const r = await fetch("/api/live/entry-stats", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// drizzle numeric columns arrive as strings — parse defensively (mirrors pf() in technical-rankings).
function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Nearest support BELOW current price from levels the nightly technicals job already
// computed (swing lows + pivot S1) — and whether an ~8% OTM put strike would sit
// below that support (support cushions the strike) or dangle unprotected above it.
function supportContext(row: TechnicalRow | undefined, price: number): { support: number; cushioned: boolean } | null {
  if (!row) return null;
  const levels = [num(row.swingLow20d), num(row.swingLow50d), num(row.pivotS1)]
    .filter((v): v is number => v != null && v > 0 && v < price);
  if (levels.length === 0) return null;
  const support = Math.max(...levels); // highest level still below price = nearest support
  const strike = price * 0.92;
  return { support, cushioned: support <= strike ? false : true };
}

function regimeDotColor(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "bg-muted-foreground/40";
  if (c.direction === "mixed") return "bg-yellow-500";
  return c.direction === "bullish" ? "bg-green-500" : "bg-red-500";
}

function regimeTextColor(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "text-muted-foreground";
  if (c.direction === "mixed") return "text-yellow-500";
  return c.direction === "bullish" ? "text-green-500" : "text-red-500";
}

function regimeShortLabel(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "—";
  if (c.direction === "mixed") return "Mix";
  return c.direction === "bullish" ? "Bull" : "Bear";
}

function RegimeBanner({ checkpoints }: { checkpoints: RegimeCheckpoint[] | undefined }) {
  const [openMin, setOpenMin] = useState<number | null>(null);
  if (!checkpoints?.length) return null;

  const cols = checkpoints.length;

  // Headline = latest resolved directional call; flag a flip vs. the checkpoint
  // before it — a mid-day regime flip is the single most tradeable banner event.
  const resolved = checkpoints.filter(c => c.status === "resolved" && c.direction != null);
  const latest = resolved[resolved.length - 1] ?? null;
  const prev = resolved[resolved.length - 2] ?? null;
  const flipped = latest != null && prev != null && prev.direction !== latest.direction;

  return (
    <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
      <div className="px-3 py-1.5 border-b border-zinc-600/40 bg-zinc-800/90 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-white uppercase tracking-wide">
          Intraday Regime
        </span>
        {latest && (
          <span className="flex items-center gap-2 text-[11px] font-mono">
            <span className={cn("font-semibold", regimeTextColor(latest))}>
              Now: {regimeShortLabel(latest)}{latest.confidence != null ? ` ${latest.confidence}%` : ""}
            </span>
            <span className="text-zinc-500">as of {CHECKPOINT_TIME_PT[latest.minAfterOpen] ?? latest.label}</span>
            {flipped && prev && (
              <span className="text-amber-400 font-semibold">
                ⚠ flipped from {regimeShortLabel(prev)} at {CHECKPOINT_TIME_PT[prev.minAfterOpen] ?? prev.label}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {checkpoints.map((c) => (
          <Popover key={c.minAfterOpen} open={openMin === c.minAfterOpen} onOpenChange={open => setOpenMin(open ? c.minAfterOpen : null)}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex flex-col items-center gap-1 py-2 border-r border-zinc-700/40 last:border-r-0",
                  "even:bg-zinc-800/40 hover:bg-amber-500/10 transition-colors",
                )}
              >
                <span className="text-[10px] text-zinc-400 font-mono whitespace-nowrap">
                  {CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label}{c.computedLate ? "*" : ""}
                </span>
                <span className="flex items-center gap-1">
                  <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", regimeDotColor(c))} />
                  <span className={cn("text-[10px] font-semibold whitespace-nowrap", regimeTextColor(c))}>
                    {regimeShortLabel(c)}{c.confidence != null ? ` ${c.confidence}%` : ""}
                  </span>
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="center">
              <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full shrink-0", regimeDotColor(c))} />
                <span className="font-semibold text-white">
                  {CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label}{c.computedLate ? " (late)" : ""}
                </span>
              </div>
              <div className="p-3 flex flex-col gap-1.5">
                {(c.factors ?? []).length > 0 ? (c.factors ?? []).map((f, i) => (
                  <span key={i} className="text-zinc-300 leading-snug font-mono text-[11px]">{f}</span>
                )) : (
                  <span className="text-zinc-500 italic">No breakdown available.</span>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ))}
      </div>
    </div>
  );
}

// ivCurrent/return5d from IndicatorResult are already plain percent numbers (e.g. 23.09 = 23.09%),
// not decimal fractions — matches the convention in options-scanner.tsx/technical.tsx.
function pct(v: number | null, digits = 1): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 65) return "text-green-500";
  if (score >= 45) return "text-yellow-500";
  return "text-red-500";
}

const VERDICT_STYLE: Record<EntryVerdict, string> = {
  enter: "bg-green-600/20 text-green-400 border-green-600/40",
  wait: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40",
  avoid: "bg-red-600/20 text-red-400 border-red-600/40",
};

const VERDICT_LABEL: Record<EntryVerdict, string> = { enter: "Enter", wait: "Wait", avoid: "Avoid" };

/** Entry-timing verdict pill + click-to-open factor breakdown, mirroring the regime banner popover. */
function EntryCell({ signal, asOf }: { signal: EntrySignal | undefined; asOf: string | null }) {
  if (!signal) return <span className="text-muted-foreground">—</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn("px-2 py-0.5 rounded border text-[11px] font-semibold transition-colors hover:brightness-125", VERDICT_STYLE[signal.verdict])}>
          {VERDICT_LABEL[signal.verdict]}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="center">
        <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center justify-between gap-2">
          <span className="font-semibold text-white">{signal.ticker} entry timing</span>
          {asOf && <span className="text-zinc-500 font-mono text-[10px]">as of {asOf}</span>}
        </div>
        <div className="p-3 flex flex-col gap-1.5">
          {signal.factors.map((f, i) => (
            <span key={i} className="text-zinc-300 leading-snug font-mono text-[11px]">{f}</span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SignalBadge({ signal }: { signal: HotlistEntry["signal"] }) {
  const variant = signal === "GO" ? "default" : signal === "WATCH" ? "secondary" : "outline";
  const color = signal === "GO" ? "bg-green-600 text-white" : signal === "WATCH" ? "bg-yellow-500 text-black" : "text-muted-foreground";
  return <Badge variant={variant} className={cn("text-xs", color)}>{signal}</Badge>;
}

function MarketContextChip({ quote }: { quote: MarketContextQuote }) {
  const up = (quote.changePercent ?? 0) >= 0;
  return (
    <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2">
      <span className="text-sm font-mono font-semibold text-foreground">{quote.ticker}</span>
      <span className="text-sm text-foreground">{quote.price != null ? quote.price.toFixed(2) : "—"}</span>
      <span className={cn("text-xs font-medium", up ? "text-green-500" : "text-red-500")}>
        {pct(quote.changePercent)}
      </span>
    </div>
  );
}

// Maps a %change value to a background color whose intensity scales with magnitude, clamped
// at maxMagnitude so single-digit movers still look visually distinct from the ±5%+ extremes.
function heatColor(changePercent: number | null, maxMagnitude = 5): string {
  if (changePercent == null) return "hsl(0, 0%, 50%, 0.08)";
  const magnitude = Math.min(Math.abs(changePercent), maxMagnitude) / maxMagnitude;
  const alpha = 0.12 + magnitude * 0.55;
  const hue = changePercent >= 0 ? 142 : 0; // matches text-green-500 / text-red-500 hues
  return `hsl(${hue}, 70%, 45%, ${alpha})`;
}

function heatBorderColor(changePercent: number | null): string {
  if (changePercent == null) return "hsl(0, 0%, 50%)";
  return changePercent >= 0 ? "hsl(142, 70%, 45%)" : "hsl(0, 70%, 50%)";
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

function MoverRow({ m, showVolume }: { m: ScreenerMover; showVolume?: boolean }) {
  const up = (m.changePercent ?? 0) >= 0;
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-xs border-l-2"
      style={{
        backgroundColor: heatColor(m.changePercent),
        borderLeftColor: heatBorderColor(m.changePercent),
      }}
    >
      <span className="font-mono font-bold text-foreground w-14 shrink-0">{m.ticker}</span>
      <span className="text-muted-foreground w-16 shrink-0">
        {m.price != null ? `$${m.price.toFixed(2)}` : "—"}
      </span>
      <span className={cn("font-bold w-14 shrink-0", up ? "text-green-500" : "text-red-500")}>
        {pct(m.changePercent)}
      </span>
      {showVolume && (
        <span className="text-muted-foreground ml-auto">
          {m.volume != null ? formatVolume(m.volume) : "—"}
        </span>
      )}
    </div>
  );
}

function MoverHeatmapGrid({
  title,
  movers,
  showVolume,
}: {
  title: string;
  movers: ScreenerMover[];
  showVolume?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide bg-card px-2 py-1 border-b border-border/60">
        {title}
      </h3>
      {movers.length === 0 ? (
        <p className="text-xs text-muted-foreground p-2">No data.</p>
      ) : (
        <div className="divide-y divide-border/30">
          {movers.slice(0, 8).map((m) => (
            <MoverRow key={m.ticker} m={m} showVolume={showVolume} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectorMoverBars({ groups }: { groups: SectorMoverGroup[] }) {
  const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g.avgChangePercent)));
  return (
    <div className="space-y-1.5">
      {groups.map((g) => {
        const up = g.avgChangePercent >= 0;
        const widthPct = (Math.abs(g.avgChangePercent) / maxAbs) * 50;
        return (
          <div
            key={g.sector}
            className="rounded-lg border border-border/60 bg-card px-3 py-2 hover:border-border transition-colors"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-foreground">{g.sector}</span>
              <span className="text-xs text-muted-foreground">{g.tickerCount} tickers</span>
              <span className={cn("text-sm font-bold font-mono", up ? "text-green-500" : "text-red-500")}>
                {pct(g.avgChangePercent)}
              </span>
            </div>

            <div className="relative h-1.5 rounded-full bg-secondary overflow-hidden mb-2">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <div
                className={cn("absolute inset-y-0 rounded-full", up ? "bg-green-500" : "bg-red-500")}
                style={up ? { left: "50%", width: `${widthPct}%` } : { right: "50%", width: `${widthPct}%` }}
              />
            </div>

            <div className="flex flex-wrap gap-1">
              {g.topGainers.map((m) => (
                <span
                  key={`g-${m.ticker}`}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded text-green-400"
                  style={{ backgroundColor: heatColor(m.changePercent, 5) }}
                >
                  {m.ticker} {pct(m.changePercent)}
                </span>
              ))}
              {g.topLosers.map((m) => (
                <span
                  key={`l-${m.ticker}`}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded text-red-400"
                  style={{ backgroundColor: heatColor(m.changePercent, 5) }}
                >
                  {m.ticker} {pct(m.changePercent)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Live() {
  const queryClient = useQueryClient();

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

  const techScoreMap = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, number>();
    return new Map(computeTechnicalRankingsV2(allTechnicalsData).map(s => [s.ticker, s.totalScore]));
  }, [allTechnicalsData]);

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

  const sortedHotlist = [...(data?.hotlist ?? [])].sort((a, b) => a.rsi - b.rsi);

  const entryByTicker = useMemo(
    () => new Map((entrySignals?.signals ?? []).map(s => [s.ticker, s])),
    [entrySignals],
  );
  const entryAsOf = entrySignals?.afterCheckpointMin != null
    ? (CHECKPOINT_TIME_PT[entrySignals.afterCheckpointMin] ?? `${entrySignals.afterCheckpointMin}m after open`)
    : null;

  return (
    <div className="min-h-[100dvh] bg-background">
      <TopNav />
      <main className="pt-14 p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-foreground">Live</h1>
              <p className="text-sm text-muted-foreground">
                Prototype — hot list refreshes manually for now. Last refreshed: {lastRefreshedLabel}
              </p>
            </div>
            <Button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              size="sm"
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", refreshMutation.isPending && "animate-spin")} />
              Refresh
            </Button>
          </div>

          <RegimeBanner checkpoints={regime} />

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Market Context
            </h2>
            <div className="flex flex-wrap gap-2">
              {data?.marketContext.map((q) => <MarketContextChip key={q.ticker} quote={q} />)}
              {!isLoading && (data?.marketContext.length ?? 0) === 0 && (
                <p className="text-sm text-muted-foreground">No data yet — click Refresh.</p>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Opportunities ({sortedHotlist.length})
              </h2>
              {entryStats && entryStats.gradedDays > 0 && (
                <span
                  className="text-[11px] font-mono text-zinc-400"
                  title={`Forward returns of past Entry verdicts over the last ${entryStats.days} days (${entryStats.gradedDays} graded days). Avg next-day / next-5-day return from the signal price. This is the accountability layer — if Enter doesn't beat Wait here, don't trust the verdicts.`}
                >
                  {(["enter", "wait", "avoid"] as const).map((v, i) => {
                    const s = entryStats.perVerdict[v];
                    if (s.n === 0) return null;
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
                </span>
              )}
            </div>
            {sortedHotlist.length === 0 ? (
              !isLoading && (
                <p className="text-sm text-muted-foreground">
                  Waiting for scanner data — click Refresh once rankings are cached.
                </p>
              )
            ) : (
              <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-800/90 text-white">
                    <tr className="border-b border-zinc-600/40">
                      <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Ticker</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Price</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">RSI</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">IV · Rank</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">5d Return</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Stoch</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Support</th>
                      <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">ER</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Fund Score</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Tech Score</th>
                      <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Signal</th>
                      <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Entry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedHotlist.map((e) => {
                      const fundScore = fundScoreMap.get(e.ticker) ?? null;
                      const techScore = techScoreMap.get(e.ticker) ?? null;
                      const tech = techRowMap.get(e.ticker);
                      const ivRank = num(tech?.ivRank); // [0,1] self-relative
                      const support = supportContext(tech, e.price);
                      const erDays = tech?.earningsDaysOut ?? null;
                      const erSoon = erDays != null && erDays >= 0 && erDays <= 7;
                      const knife = tech?.fallingKnife === 1;
                      return (
                      <tr key={e.ticker} className="bg-zinc-900/40 even:bg-zinc-800/40 hover:bg-zinc-700/50 transition-colors">
                        <td className="px-3 py-1.5 font-mono font-semibold text-white">
                          {e.ticker}
                          {knife && <span className="ml-1 text-red-500" title="Falling knife: >2 ATR below MA50 and MA200 with MACD falling">⚠</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-white">{e.price.toFixed(2)}</td>
                        <td className={cn("px-3 py-1.5 text-right font-mono", e.rsi < 30 ? "text-green-400 font-semibold" : "text-white")}>
                          {e.rsi.toFixed(1)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-amber-400">
                          {e.ivCurrent.toFixed(0)}%
                          <span className={cn("ml-1", ivRank != null && ivRank >= 0.7 ? "text-amber-300 font-semibold" : "text-zinc-500")}>
                            {ivRank != null ? `R${Math.round(ivRank * 100)}` : ""}
                          </span>
                        </td>
                        <td className={cn("px-3 py-1.5 text-right font-mono", (e.return5d ?? 0) < 0 ? "text-red-400" : "text-green-400")}>
                          {pct(e.return5d)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-white">{e.stoch != null ? e.stoch.toFixed(0) : "—"}</td>
                        <td
                          className="px-3 py-1.5 text-right font-mono text-zinc-300"
                          title={support ? `Nearest support below price (swing lows / pivot S1). ${support.cushioned ? "An ~8% OTM strike would sit BELOW this support (cushioned)." : "An ~8% OTM strike would sit ABOVE this support (no cushion)."}` : undefined}
                        >
                          {support ? (
                            <>
                              {support.support.toFixed(2)}
                              <span className={cn("ml-1 font-semibold", support.cushioned ? "text-green-400" : "text-red-400")}>
                                {support.cushioned ? "✓" : "✗"}
                              </span>
                            </>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {erSoon ? (
                            <span className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-amber-400 text-[10px] font-semibold" title={`Earnings in ${erDays} day${erDays === 1 ? "" : "s"}`}>
                              {erDays}d
                            </span>
                          ) : (
                            <span className="text-zinc-600 text-[10px]">{erDays != null ? `${erDays}d` : "—"}</span>
                          )}
                        </td>
                        <td className={cn("px-3 py-1.5 text-right font-mono", scoreColor(fundScore))}>
                          {fundScore != null ? fundScore.toFixed(0) : "—"}
                        </td>
                        <td className={cn("px-3 py-1.5 text-right font-mono", scoreColor(techScore))}>
                          {techScore != null ? techScore.toFixed(0) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-center"><SignalBadge signal={e.signal} /></td>
                        <td className="px-3 py-1.5 text-center"><EntryCell signal={entryByTicker.get(e.ticker)} asOf={entryAsOf} /></td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Movers
            </h2>
            {moversLoading && !movers ? (
              <p className="text-sm text-muted-foreground">Loading movers…</p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <MoverHeatmapGrid title="Gainers" movers={movers?.global.gainers ?? []} />
                  <MoverHeatmapGrid title="Losers" movers={movers?.global.losers ?? []} />
                  <MoverHeatmapGrid title="Most Active" movers={movers?.global.mostActive ?? []} showVolume />
                </div>
                {(movers?.sectors.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Sector Breakdown
                    </h3>
                    <SectorMoverBars groups={movers!.sectors} />
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
