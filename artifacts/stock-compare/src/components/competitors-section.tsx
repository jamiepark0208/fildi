import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWatchlist } from "@/hooks/use-watchlist";

export interface CompetitorRow {
  rank: number;
  ticker: string;
  combinedScore: number | null;
  techScore: number | null;
  fundScore: number | null;
  pendingBackfill: boolean;
}

interface CompetitorsResponse {
  ticker: string;
  sector: string | null;
  industry: string | null;
  competitors: CompetitorRow[];
}

function CombinedScore({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-sm text-foreground/45 font-mono">—</span>;
  }
  const color =
    score >= 75 ? "text-green-400" : score >= 55 ? "text-yellow-400" : score >= 35 ? "text-orange-400" : "text-red-400";
  return (
    <span className={cn("font-bold font-mono tabular-nums text-sm", color)}>
      {score.toFixed(1)}
    </span>
  );
}

async function fetchCompetitors(ticker: string): Promise<CompetitorsResponse> {
  const res = await fetch(`/api/stocks/competitors/${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function CompetitorsSection({ ticker }: { ticker: string }) {
  const queryClient = useQueryClient();
  const { addEntryIfMissing } = useWatchlist();
  const backfillSent = useRef(false);

  useEffect(() => {
    backfillSent.current = false;
  }, [ticker]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["competitors", ticker],
    queryFn: () => fetchCompetitors(ticker),
    staleTime: 5 * 60 * 1000,
    enabled: !!ticker,
  });

  useEffect(() => {
    if (!data || backfillSent.current) return;
    const needBackfill = data.competitors.filter(c => c.pendingBackfill);
    if (needBackfill.length === 0) return;
    backfillSent.current = true;

    for (const c of needBackfill) {
      addEntryIfMissing(c.ticker);
    }

    fetch("/api/stocks/competitors/backfill", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers: needBackfill.map(c => c.ticker) }),
    })
      .then(() => {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["competitors", ticker] });
        }, 30_000);
      })
      .catch(() => {});
  }, [data, ticker, addEntryIfMissing, queryClient]);

  if (isLoading) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4 flex items-center gap-2 text-sm text-foreground/60">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading competitors…
      </div>
    );
  }

  if (error || !data) return null;

  const subtitle = [data.industry, data.sector].filter(Boolean).join(" · ");

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
      {subtitle && (
        <p className="text-xs text-foreground/55 mt-0.5 mb-3">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}

      {data.competitors.length === 0 ? (
        <p className="text-sm text-foreground/55">No peer data available yet.</p>
      ) : (
        <div className="space-y-2">
          {data.competitors.map(row => (
            <div
              key={row.ticker}
              className="flex items-center justify-between gap-3 py-1.5 border-b border-border/20 last:border-0"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs text-foreground/45 font-mono w-6 shrink-0">#{row.rank}</span>
                <span className="text-sm font-semibold text-foreground font-mono">{row.ticker}</span>
                {row.pendingBackfill && row.combinedScore == null && (
                  <span className="text-[10px] text-foreground/45">Scoring…</span>
                )}
              </div>
              <CombinedScore score={row.combinedScore} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
