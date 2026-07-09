import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

// ── Rate limit metadata (hardcoded — doesn't change) ──────────────────────────

type LimitKind = "daily" | "per-min" | "per-sec" | "none";

interface SourceMeta {
  label: string;
  limitKind: LimitKind;
  dailyLimit?: number;     // only for "daily"
  rateNote?: string;       // displayed for non-daily sources
}

const SOURCE_META: Record<string, SourceMeta> = {
  fmp:    { label: "FMP",          limitKind: "daily",   dailyLimit: 250, rateNote: "250/day" },
  av:     { label: "Alpha Vantage",limitKind: "daily",   dailyLimit: 25,  rateNote: "25/day"  },
  polygon:{ label: "Polygon",      limitKind: "per-min", rateNote: "5 req/min" },
  finnhub:{ label: "Finnhub",      limitKind: "per-min", rateNote: "60 req/min" },
  yahoo:  { label: "Yahoo",        limitKind: "none",    rateNote: "no hard limit" },
  edgar:  { label: "SEC EDGAR",    limitKind: "per-sec", rateNote: "10 req/sec" },
  fred:   { label: "FRED",         limitKind: "none",    rateNote: "no hard limit" },
  cnn:    { label: "CNN",          limitKind: "none",    rateNote: "no hard limit" },
  nyfed:  { label: "NY Fed",       limitKind: "none",    rateNote: "no hard limit" },
};

// Show these sources always (even with 0 calls); others shown only if they have data.
const PRIMARY_SOURCES = ["fmp", "av", "polygon", "finnhub", "yahoo", "edgar"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDateLabels(days: number): { iso: string; label: string }[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : iso.slice(5); // MM-DD
    return { iso, label };
  });
}

function usageColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 60) return "bg-yellow-500";
  return "bg-green-500";
}

function usageTextColor(pct: number): string {
  if (pct >= 90) return "text-red-400";
  if (pct >= 60) return "text-yellow-400";
  return "text-green-400";
}

// ── Component ─────────────────────────────────────────────────────────────────

interface UsageRow { source: string; date: string; callsMade: number; }

export function ApiMonitorTab() {
  const DAYS = 5;
  const dates = buildDateLabels(DAYS);

  const { data, isFetching, refetch, dataUpdatedAt } = useQuery<UsageRow[]>({
    queryKey: ["api-usage", "history", DAYS],
    queryFn: async () => {
      const res = await fetch(`/api/api-usage/history?days=${DAYS}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load API usage");
      return res.json();
    },
    staleTime: 2 * 60_000,
    gcTime: 60 * 60_000,
    refetchInterval: 2 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  // Pivot: source → date → callsMade
  const pivot = new Map<string, Map<string, number>>();
  for (const row of data ?? []) {
    if (!pivot.has(row.source)) pivot.set(row.source, new Map());
    pivot.get(row.source)!.set(row.date, row.callsMade);
  }

  // Determine which sources to show
  const allSources = new Set([...PRIMARY_SOURCES, ...pivot.keys()]);
  const sources = [...allSources].sort((a, b) => {
    const ai = PRIMARY_SOURCES.indexOf(a), bi = PRIMARY_SOURCES.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold">API Monitor</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Daily call counts per data source · auto-refreshes every 5 min</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[10px] text-muted-foreground/60">as of {lastUpdated}</span>}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 pr-4 font-medium text-muted-foreground w-32">Source</th>
              <th className="text-left py-2 pr-6 font-medium text-muted-foreground">Limit</th>
              {dates.map(d => (
                <th key={d.iso} className="text-right py-2 pl-4 font-medium text-muted-foreground whitespace-nowrap">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map(source => {
              const meta = SOURCE_META[source] ?? { label: source, limitKind: "none" as LimitKind };
              const byDate = pivot.get(source) ?? new Map<string, number>();

              return (
                <tr key={source} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="py-2.5 pr-4 font-medium">{meta.label}</td>
                  <td className="py-2.5 pr-6 text-muted-foreground">
                    {meta.limitKind === "daily" ? (
                      <span>{meta.dailyLimit}/day</span>
                    ) : (
                      <span className="italic">{meta.rateNote}</span>
                    )}
                  </td>
                  {dates.map(d => {
                    const calls = byDate.get(d.iso) ?? 0;
                    const isDaily = meta.limitKind === "daily" && meta.dailyLimit;

                    if (isDaily) {
                      const limit = meta.dailyLimit!;
                      const pct = Math.min((calls / limit) * 100, 100);
                      return (
                        <td key={d.iso} className="py-2.5 pl-4 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className={cn("tabular-nums font-semibold", calls > 0 ? usageTextColor(pct) : "text-muted-foreground")}>
                              {calls}/{limit}
                            </span>
                            <div className="w-16 h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn("h-full rounded-full transition-all", calls > 0 ? usageColor(pct) : "bg-muted")}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td key={d.iso} className={cn("py-2.5 pl-4 text-right tabular-nums", calls === 0 ? "text-muted-foreground" : "")}>
                        {calls === 0 ? "—" : calls}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

      <p className="text-[10px] text-muted-foreground mt-4">
        FMP and AV enforce daily limits; progress bars show consumption. Polygon, Finnhub, Yahoo, and EDGAR are rate-limited per minute/second but have no enforced daily cap.
      </p>
    </div>
  );
}
