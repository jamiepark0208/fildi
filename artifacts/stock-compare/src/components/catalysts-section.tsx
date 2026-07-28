interface CatalystsSectionProps {
  catalysts?: string[];
}

const EARNINGS_LINE = /^(Earnings|Next earnings)/;

export function CatalystsSection({ catalysts }: CatalystsSectionProps) {
  const lines = catalysts ?? [];
  const earningsLine = lines.find(l => EARNINGS_LINE.test(l));
  const rest = lines.filter(l => l !== earningsLine);

  if (!lines.length) {
    return <p className="text-sm text-foreground">No upcoming catalysts identified.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Upcoming</span>
        {earningsLine && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30 whitespace-nowrap">
            {earningsLine}
          </span>
        )}
      </div>
      {rest.length > 0 && (
        <ul className="space-y-1.5">
          {rest.map((line, i) => (
            <li key={i} className="flex gap-2 text-sm text-foreground leading-snug">
              <span className="shrink-0 text-foreground mt-0.5">•</span>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
