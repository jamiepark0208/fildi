import { useLocation } from "wouter";
import { addToCompareShelf } from "@/lib/ticker-shelf-storage";

interface CompetitorsSectionProps {
  peers: string[];
  industry?: string | null;
  sector?: string | null;
}

/** Peer tickers from breakdown payload — no separate API call. */
export function CompetitorsSection({ peers, industry, sector }: CompetitorsSectionProps) {
  const [, navigate] = useLocation();
  const subtitle = [industry, sector].filter(Boolean).join(" · ");

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
      {subtitle && (
        <p className="text-xs text-foreground mt-0.5 mb-3">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}

      {peers.length === 0 ? (
        <p className="text-sm text-foreground">No peers found for this ticker yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {peers.map(peer => (
            <li key={peer}>
              <button
                type="button"
                onClick={() => { addToCompareShelf(peer); navigate("/"); }}
                className="text-sm font-mono text-foreground hover:text-primary hover:underline transition-colors"
              >
                {peer}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
