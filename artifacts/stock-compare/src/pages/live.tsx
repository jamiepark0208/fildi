import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { TopNav } from "@/components/top-nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

function MoverRow({ m }: { m: ScreenerMover }) {
  const up = (m.changePercent ?? 0) >= 0;
  return (
    <div className="flex items-center justify-between text-sm px-3 py-1.5">
      <span className="font-mono font-semibold text-foreground">{m.ticker}</span>
      <span className="text-foreground">{m.price != null ? m.price.toFixed(2) : "—"}</span>
      <span className={cn("font-medium", up ? "text-green-500" : "text-red-500")}>{pct(m.changePercent)}</span>
    </div>
  );
}

function MoverList({ title, movers }: { title: string; movers: ScreenerMover[] }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-2 bg-secondary">
        {title}
      </h3>
      <div className="divide-y divide-border">
        {movers.length === 0 ? (
          <p className="text-sm text-muted-foreground px-3 py-2">No data.</p>
        ) : (
          movers.slice(0, 8).map((m) => <MoverRow key={m.ticker} m={m} />)
        )}
      </div>
    </div>
  );
}

function SectorMoversTable({ groups }: { groups: SectorMoverGroup[] }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-secondary text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Sector</th>
            <th className="text-right font-medium px-3 py-2">Avg Change</th>
            <th className="text-left font-medium px-3 py-2">Top Gainers</th>
            <th className="text-left font-medium px-3 py-2">Top Losers</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {groups.map((g) => (
            <tr key={g.sector} className="hover:bg-secondary/50">
              <td className="px-3 py-2 text-foreground">{g.sector}</td>
              <td className={cn("px-3 py-2 text-right font-medium", g.avgChangePercent >= 0 ? "text-green-500" : "text-red-500")}>
                {pct(g.avgChangePercent)}
              </td>
              <td className="px-3 py-2 text-foreground font-mono text-xs">
                {g.topGainers.map((m) => `${m.ticker} ${pct(m.changePercent)}`).join("  ")}
              </td>
              <td className="px-3 py-2 text-foreground font-mono text-xs">
                {g.topLosers.map((m) => `${m.ticker} ${pct(m.changePercent)}`).join("  ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Opportunities ({sortedHotlist.length})
            </h2>
            {sortedHotlist.length === 0 ? (
              !isLoading && (
                <p className="text-sm text-muted-foreground">
                  Waiting for scanner data — click Refresh once rankings are cached.
                </p>
              )
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-secondary text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Ticker</th>
                      <th className="text-right font-medium px-3 py-2">Price</th>
                      <th className="text-right font-medium px-3 py-2">RSI</th>
                      <th className="text-right font-medium px-3 py-2">IV</th>
                      <th className="text-right font-medium px-3 py-2">5d Return</th>
                      <th className="text-right font-medium px-3 py-2">Stoch</th>
                      <th className="text-right font-medium px-3 py-2">Fund Score</th>
                      <th className="text-right font-medium px-3 py-2">Tech Score</th>
                      <th className="text-center font-medium px-3 py-2">Signal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedHotlist.map((e) => {
                      const fundScore = fundScoreMap.get(e.ticker) ?? null;
                      const techScore = techScoreMap.get(e.ticker) ?? null;
                      return (
                      <tr key={e.ticker} className="hover:bg-secondary/50">
                        <td className="px-3 py-2 font-mono font-semibold text-foreground">{e.ticker}</td>
                        <td className="px-3 py-2 text-right text-foreground">{e.price.toFixed(2)}</td>
                        <td className={cn("px-3 py-2 text-right", e.rsi < 30 ? "text-green-500 font-medium" : "text-foreground")}>
                          {e.rsi.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right text-foreground">{e.ivCurrent.toFixed(0)}%</td>
                        <td className={cn("px-3 py-2 text-right", (e.return5d ?? 0) < 0 ? "text-red-500" : "text-green-500")}>
                          {pct(e.return5d)}
                        </td>
                        <td className="px-3 py-2 text-right text-foreground">{e.stoch != null ? e.stoch.toFixed(0) : "—"}</td>
                        <td className={cn("px-3 py-2 text-right font-mono", scoreColor(fundScore))}>
                          {fundScore != null ? fundScore.toFixed(0) : "—"}
                        </td>
                        <td className={cn("px-3 py-2 text-right font-mono", scoreColor(techScore))}>
                          {techScore != null ? techScore.toFixed(0) : "—"}
                        </td>
                        <td className="px-3 py-2 text-center"><SignalBadge signal={e.signal} /></td>
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <MoverList title="Gainers" movers={movers?.global.gainers ?? []} />
                  <MoverList title="Losers" movers={movers?.global.losers ?? []} />
                  <MoverList title="Most Active" movers={movers?.global.mostActive ?? []} />
                </div>
                {(movers?.sectors.length ?? 0) > 0 && <SectorMoversTable groups={movers!.sectors} />}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
