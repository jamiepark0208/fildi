interface CompetitorsSectionProps {
  peers: string[];
  industry?: string | null;
  sector?: string | null;
}

/** Peer tickers from breakdown payload — no separate API call. */
export function CompetitorsSection({ peers, industry, sector }: CompetitorsSectionProps) {
  const subtitle = [industry, sector].filter(Boolean).join(" · ");

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block">Competitors</span>
      {subtitle && (
        <p className="text-xs text-foreground/55 mt-0.5 mb-3">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}

      {peers.length === 0 ? (
        <p className="text-sm text-foreground/55">No peers found for this ticker yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {peers.map(peer => (
            <li key={peer} className="text-sm font-mono text-foreground">
              {peer}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
