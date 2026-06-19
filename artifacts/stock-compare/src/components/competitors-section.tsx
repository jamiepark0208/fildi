import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

interface CompetitorsResponse {
  ticker: string;
  sector: string | null;
  industry: string | null;
  peers: string[];
}

async function fetchCompetitors(ticker: string): Promise<CompetitorsResponse> {
  const res = await fetch(`/api/stocks/competitors/${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Read-only peer list from registry — one GET per stock view. */
export function CompetitorsSection({ ticker }: { ticker: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["competitors", ticker],
    queryFn: () => fetchCompetitors(ticker),
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: !!ticker,
  });

  if (isLoading) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4 flex items-center gap-2 text-sm text-foreground/60">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading competitors…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4">
        <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
        <p className="text-sm text-red-400/90 mt-2">
          {error instanceof Error ? error.message : "Could not load competitors."}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4">
        <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
        <p className="text-sm text-foreground/55 mt-2">No competitor data available.</p>
      </div>
    );
  }

  const subtitle = [data.industry, data.sector].filter(Boolean).join(" · ");

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
      {subtitle && (
        <p className="text-xs text-foreground/55 mt-0.5 mb-3">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}

      {data.peers.length === 0 ? (
        <p className="text-sm text-foreground/55">No peers found for this ticker yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {data.peers.map(peer => (
            <li key={peer} className="text-sm font-mono text-foreground">
              {peer}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
