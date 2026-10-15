/**
 * Live › Portfolio Alerts — concise book-risk bullets from scripts/watchlist_sync/pm_alerts.py (Claude, PM role).
 * Odds = market-implied (each put's IV) + the trader's own expiry clustering (S015); thresholds are defaults the user tunes.
 * Display only: no trading actions.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type Bullet = { key: string; level: "red" | "amber" | "green"; text: string; change: "new" | "worse" | "better" | null };
type Run = {
  generatedAt: string;
  priced_at: string;
  prices: string;
  bullets: Bullet[];
  cleared: string[];
  accounts: Record<string, { status: "red" | "amber" | "green"; risk?: number; expiry?: string }>;
};

const DOT: Record<Bullet["level"], string> = { red: "bg-red-500", amber: "bg-amber-400", green: "bg-emerald-500" };
const CHIP: Record<Bullet["level"], string> = {
  red: "border-red-500/40 text-red-300",
  amber: "border-amber-400/40 text-amber-200",
  green: "border-emerald-500/40 text-emerald-300",
};

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function PortfolioAlertsPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["pm-alerts"],
    queryFn: async (): Promise<Run | null> => {
      const r = await fetch("/api/pm/alerts", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).run;
    },
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) return <div className="text-[11px] text-amber-200/40 p-3">Loading…</div>;
  if (error) return <div className="text-[11px] text-red-300/80 p-3">Portfolio Alerts unavailable ({String((error as Error).message)}).</div>;
  if (!data) return <div className="text-[11px] text-amber-200/50 p-3">Not run yet — the PM job writes here every 15 min in market hours.</div>;

  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(data.accounts).map(([name, a]) => (
          <span key={name} className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase", CHIP[a.status])}>
            {name} {a.status}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-amber-200/40 tabular-nums" title={`Checked ${data.generatedAt}`}>
          {data.prices} · {ago(data.priced_at)}
        </span>
      </div>
      {data.bullets.length === 0 ? (
        <p className="text-[12px] text-emerald-300/80">All clear — no account crosses a risk line.</p>
      ) : (
        <ul className="space-y-1.5">
          {data.bullets.map((b) => (
            <li key={b.key} className="flex gap-2 text-[12px] leading-snug text-amber-100/85">
              <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", DOT[b.level])} />
              <span>
                {b.text}
                {b.change && (
                  <span className={cn("ml-1.5 text-[10px] font-semibold uppercase", b.change === "better" ? "text-emerald-400" : "text-red-400")}>
                    {b.change}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.cleared.length > 0 && (
        <p className="text-[10px] text-emerald-400/70">Cleared since last check: {data.cleared.join(", ")}</p>
      )}
      <p className="text-[10px] text-amber-200/30">
        Odds come from each option's own price (market-implied, not a forecast), with your past expiries' tendency to breach together.
        You decide; closing is shown only as what it would change.
      </p>
    </div>
  );
}
