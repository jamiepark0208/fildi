/**
 * A264 — Settings › Data Sources: every vendor, what it feeds, 30d calls vs limit, unused.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface SourceRow {
  id: string;
  usageKey: string | null;
  name: string;
  plan: string;
  feeds: string;
  tables: string;
  unusedAvailable: string;
  dailyLimit: number | null;
  calls30d: number;
  lastCallDate: string | null;
  avgDailyCalls: number;
  pctOfDailyLimit: number | null;
  nearLimit: boolean;
}

interface Payload {
  asOf: string;
  inventoryRef: string;
  sources: SourceRow[];
  researchSync: { dataset: string; last_ok: string | null; rows: number | null; notes: string | null }[];
}

export function DataSourcesTab() {
  const { data, isFetching, error, refetch } = useQuery<Payload>({
    queryKey: ["admin", "data-sources"],
    queryFn: async () => {
      const res = await fetch("/api/admin/data-sources", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load data sources");
      return res.json();
    },
    staleTime: 60_000,
  });

  return (
    <div className="space-y-3 max-w-6xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-[#d4af37]">Data Sources</h2>
          <p className="text-[11px] text-white/55 mt-0.5">
            What each vendor gives Fildi · 30-day calls · unused-but-available (from A263 inventory).
            {data?.asOf ? ` · as of ${new Date(data.asOf).toLocaleString()}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-[10px] px-2 py-1 rounded border border-[#d4af37]/40 text-[#d4af37] hover:bg-[#d4af37]/10"
        >
          {isFetching ? "…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400">{(error as Error).message}</p>
      )}

      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full text-[11px] border-collapse min-w-[640px]">
          <thead>
            <tr className="bg-zinc-950 text-white/60 border-b border-zinc-800">
              <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-zinc-950">Source</th>
              <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">30d calls</th>
              <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">vs limit</th>
              <th className="text-left font-medium px-2 py-1.5">Feeds</th>
              <th className="text-left font-medium px-2 py-1.5 hidden md:table-cell">Unused available</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sources ?? []).map((s, i) => (
              <tr
                key={s.id}
                className={cn(
                  "border-b border-zinc-800/80 align-top",
                  i % 2 === 0 ? "bg-zinc-900/50" : "bg-zinc-900/20",
                  s.nearLimit && "bg-amber-500/10",
                )}
              >
                <td className="px-2 py-1.5 sticky left-0 bg-inherit">
                  <div className="font-semibold text-white">{s.name}</div>
                  <div className="text-white/45 text-[10px] mt-0.5">{s.plan}</div>
                  {s.lastCallDate && (
                    <div className="text-white/35 text-[10px]">last {s.lastCallDate}</div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/90">
                  {s.usageKey == null ? "—" : s.calls30d.toLocaleString()}
                  {s.usageKey != null && (
                    <div className="text-white/40 text-[10px]">~{s.avgDailyCalls}/d</div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {s.dailyLimit == null ? (
                    <span className="text-white/40">—</span>
                  ) : (
                    <span className={s.nearLimit ? "text-amber-300 font-semibold" : "text-white/80"}>
                      {s.pctOfDailyLimit ?? 0}%
                      <div className="text-white/40 text-[10px]">of {s.dailyLimit}/d</div>
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-white/75 max-w-[220px]">
                  <div>{s.feeds}</div>
                  <div className="text-white/40 text-[10px] mt-0.5">{s.tables}</div>
                </td>
                <td className="px-2 py-1.5 text-violet-200/80 max-w-[240px] hidden md:table-cell">
                  {s.unusedAvailable}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: unused column as stacked cards under table */}
      <div className="md:hidden space-y-2">
        {(data?.sources ?? []).filter((s) => s.unusedAvailable && s.unusedAvailable !== "—").map((s) => (
          <div key={`u-${s.id}`} className="rounded border border-zinc-800 px-2 py-1.5 text-[11px]">
            <span className="font-semibold text-white">{s.name}</span>
            <span className="text-violet-200/80"> — {s.unusedAvailable}</span>
          </div>
        ))}
      </div>

      {data?.researchSync && data.researchSync.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[11px] font-semibold text-white/70 uppercase tracking-wide">Research sync</h3>
          <div className="grid gap-1 sm:grid-cols-2 text-[10px] text-white/55">
            {data.researchSync.slice(0, 24).map((r) => (
              <div key={r.dataset} className="truncate" title={r.notes ?? undefined}>
                <span className="text-white/80 font-mono">{r.dataset}</span>
                {" · "}
                {r.last_ok ? r.last_ok.slice(0, 10) : "never"}
                {r.rows != null ? ` · ${r.rows} rows` : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-white/40">
        Catalog from {data?.inventoryRef ?? "data-inventory.md"}. Calls from api_usage (Schwab metered as of A264).
        Amber row ≈ ≥70% of daily limit on a 30-day average.
      </p>
    </div>
  );
}
