import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

// ── Data Health types ─────────────────────────────────────────────────────────

interface DataHealthResponse {
  totalActive: number;
  fresh: number;
  stale: number;
  neverFetched: number;
  staleDaysThreshold: number;
  divergentCount: number;
  topNullFields: { field: string; nullCount: number }[];
  lastEnrichmentRun: string | null;
  enrichmentRunning: boolean;
  bronze: { polygonRows: number; avRows: number };
}

// ── Rate limit metadata (hardcoded — doesn't change) ──────────────────────────

type LimitKind = "daily" | "per-min" | "per-sec" | "none";

interface SourceMeta {
  label: string;
  limitKind: LimitKind;
  dailyLimit?: number;     // only for "daily"
  rateNote?: string;       // displayed for non-daily sources
}

const SOURCE_META: Record<string, SourceMeta> = {
  factset:{ label: "FactSet",      limitKind: "daily",   dailyLimit: 500, rateNote: "500/day (referee)" },
  fmp:    { label: "FMP",          limitKind: "daily",   dailyLimit: 250, rateNote: "250/day" },
  av:     { label: "Alpha Vantage",limitKind: "daily",   dailyLimit: 25,  rateNote: "25/day"  },
  polygon:{ label: "Polygon",      limitKind: "per-min", rateNote: "5 req/min" },
  finnhub:{ label: "Finnhub",      limitKind: "per-min", rateNote: "60 req/min" },
  yahoo:  { label: "Yahoo",        limitKind: "none",    rateNote: "no hard limit" },
  edgar:  { label: "SEC EDGAR",    limitKind: "per-sec", rateNote: "10 req/sec" },
  fred:   { label: "FRED",         limitKind: "none",    rateNote: "no hard limit" },
  cnn:    { label: "CNN",          limitKind: "none",    rateNote: "no hard limit" },
  nyfed:  { label: "NY Fed",       limitKind: "none",    rateNote: "no hard limit" },
  anthropic: { label: "Anthropic (Haiku)", limitKind: "none", rateNote: "30 req/15min per user" },
};

// Show these sources always (even with 0 calls); others shown only if they have data.
const PRIMARY_SOURCES = ["factset", "fmp", "av", "polygon", "finnhub", "yahoo", "edgar", "anthropic"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function localIsoDate(d: Date): string {
  // Local calendar day — NOT toISOString() (UTC), which flips "Today" after 5pm PT.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildDateLabels(days: number): { iso: string; label: string }[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0); // noon avoids DST edge weirdness
    d.setDate(d.getDate() - i);
    const iso = localIsoDate(d);
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
    staleTime: 0,
    gcTime: 60 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  const { data: health } = useQuery<DataHealthResponse>({
    queryKey: ["data-health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/data-health", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load data health");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

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
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 max-w-4xl">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">API Monitor</h2>
          <p className="text-[10px] text-amber-200/40 mt-0.5">Daily call counts per data source · auto-refreshes every 5 min</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[10px] text-amber-200/40">as of {lastUpdated}</span>}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-amber-200/50 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
        <table className="w-full text-xs">
          <thead className="bg-black text-[#d4af37]">
            <tr className="border-b border-[#d4af37]/25">
              <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 w-32">Source</th>
              <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Limit</th>
              {dates.map(d => (
                <th key={d.iso} className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 whitespace-nowrap">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {sources.map(source => {
              const meta = SOURCE_META[source] ?? { label: source, limitKind: "none" as LimitKind };
              const byDate = pivot.get(source) ?? new Map<string, number>();

              return (
                <tr key={source} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">{meta.label}</td>
                  <td className="px-2.5 py-1 text-amber-200/40">
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
                        <td key={d.iso} className="px-2.5 py-1 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className={cn("tabular-nums font-semibold", calls > 0 ? usageTextColor(pct) : "text-amber-200/40")}>
                              {calls}/{limit}
                            </span>
                            <div className="w-16 h-1 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={cn("h-full rounded-full transition-all", calls > 0 ? usageColor(pct) : "bg-zinc-800")}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td key={d.iso} className={cn("px-2.5 py-1 text-right tabular-nums", calls === 0 ? "text-amber-200/40" : "text-amber-200/40")}>
                        {calls === 0 ? "—" : calls}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-amber-200/40 mt-2">
        FMP and AV enforce daily limits; progress bars show consumption. Polygon, Finnhub, Yahoo, and EDGAR are rate-limited per minute/second but have no enforced daily cap.
      </p>

      {/* ── Data Health ─────────────────────────────────────── */}
      {health && (
        <div className="mt-4 pt-3 border-t border-[#d4af37]/25">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Data Health</h2>
            {health.enrichmentRunning && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30 animate-pulse">
                Enrichment running…
              </span>
            )}
          </div>

          <span className="block text-[11px] font-mono text-sky-300/60 mb-2">
            <span className="text-green-400">Fresh</span>{` ${health.fresh}`}
            {" · "}
            <span className="text-yellow-400">Stale</span>{` ${health.stale}`}
            {" · "}
            <span className="text-red-400">Never fetched</span>{` ${health.neverFetched}`}
            {" · "}
            <span className="text-amber-200/60">Tracked</span>{` ${health.totalActive}`}
          </span>

          <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
            <table className="w-full text-xs">
              <thead className="bg-black text-[#d4af37]">
                <tr className="border-b border-[#d4af37]/25">
                  <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Field</th>
                  <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Null Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {health.topNullFields.map(({ field, nullCount }) => (
                  <tr key={field} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                    <td className="px-2.5 py-1 font-mono text-white">{field}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-amber-200/40">{nullCount}</td>
                  </tr>
                ))}
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">Divergent fields (sources disagree &gt;20%)</td>
                  <td className="px-2.5 py-1 text-right tabular-nums">
                    <span className={cn(health.divergentCount > 50 ? "text-orange-400" : "text-amber-200/40")}>
                      {health.divergentCount}
                    </span>
                  </td>
                </tr>
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">
                    Polygon bronze rows
                    {health.bronze.polygonRows === 0 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-red-500/15 text-red-400 border-red-500/30 ml-2">empty</span>
                    )}
                  </td>
                  <td className={cn("px-2.5 py-1 text-right tabular-nums", health.bronze.polygonRows === 0 ? "text-red-400" : "text-amber-200/40")}>
                    {health.bronze.polygonRows}
                  </td>
                </tr>
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">
                    AV bronze rows
                    {health.bronze.avRows === 0 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-red-500/15 text-red-400 border-red-500/30 ml-2">empty</span>
                    )}
                  </td>
                  <td className={cn("px-2.5 py-1 text-right tabular-nums", health.bronze.avRows === 0 ? "text-red-400" : "text-amber-200/40")}>
                    {health.bronze.avRows}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-amber-200/40 mt-2">
            Last enrichment: {health.lastEnrichmentRun ? new Date(health.lastEnrichmentRun).toLocaleString() : "not yet run this session"}
            {" · "}Runs Sun &amp; Thu at 02:00 UTC
          </p>
        </div>
      )}
    </div>
  );
}
