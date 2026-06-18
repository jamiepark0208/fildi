export function CatalystsSection({ catalysts }: { catalysts: string[] }) {
  if (!catalysts || catalysts.length === 0) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4">
        <span className="text-base font-bold tracking-tight text-foreground block">Event Risk / Catalysts</span>
        <p className="text-sm text-foreground/55 mt-2">No upcoming catalysts identified.</p>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block mb-2">Event Risk / Catalysts</span>
      <ul className="space-y-1.5">
        {catalysts.map((line, i) => (
          <li key={i} className="flex gap-2 text-sm text-foreground/85 leading-snug">
            <span className="shrink-0 text-foreground/40 mt-0.5">•</span>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
