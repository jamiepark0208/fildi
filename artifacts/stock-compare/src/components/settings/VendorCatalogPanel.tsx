/**
 * Compact vendor catalog (was Settings › Data Sources).
 * Lives under API Monitor — same ops home, less text.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface SourceRow {
  id: string;
  usageKey: string | null;
  name: string;
  plan: string;
  feeds: string;
  unusedAvailable: string;
  dailyLimit: number | null;
  calls30d: number;
  avgDailyCalls: number;
  pctOfDailyLimit: number | null;
  nearLimit: boolean;
}

interface Payload {
  asOf: string;
  sources: SourceRow[];
}

function pctLabel(p: number | null): string {
  if (p == null) return "—";
  return `${Math.round(p)}%`;
}

export function VendorCatalogPanel() {
  const { data, isFetching, error, refetch } = useQuery<Payload>({
    queryKey: ["admin", "data-sources"],
    queryFn: async () => {
      const res = await fetch("/api/admin/data-sources", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vendor catalog");
      return res.json();
    },
    staleTime: 60_000,
  });

  return (
    <div className="mt-4 pt-3 border-t border-[#d4af37]/25 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
            Vendor catalog
          </h2>
          <p className="text-[10px] text-amber-100/80 mt-0.5">
            What we use · 30d volume · unused endpoints
            {data?.asOf ? ` · ${new Date(data.asOf).toLocaleString()}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-[10px] px-2 py-1 rounded border border-[#d4af37]/30 text-[#d4af37]/90 hover:bg-[#d4af37]/10 disabled:opacity-50"
        >
          {isFetching ? "…" : "Refresh"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{(error as Error).message}</p>}

      <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
        <table className="w-full text-[11px]">
          <thead className="bg-black text-[#d4af37]">
            <tr className="border-b border-[#d4af37]/25">
              <th className="text-left font-semibold px-2.5 py-1">Source</th>
              <th className="text-right font-semibold px-2.5 py-1 whitespace-nowrap">30d</th>
              <th className="text-right font-semibold px-2.5 py-1 whitespace-nowrap">vs lim</th>
              <th className="text-left font-semibold px-2.5 py-1">Feeds</th>
              <th className="text-left font-semibold px-2.5 py-1 hidden lg:table-cell">Unused</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {(data?.sources ?? []).map((s) => (
              <tr
                key={s.id}
                className={cn(
                  "bg-zinc-900/70 even:bg-zinc-800/60 align-top",
                  s.nearLimit && "bg-amber-500/10",
                )}
              >
                <td className="px-2.5 py-1.5">
                  <div className="font-medium text-white">{s.name}</div>
                  <div className="text-[10px] text-white/45">{s.plan}</div>
                </td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-white/90">
                  {s.usageKey == null ? "—" : s.calls30d.toLocaleString()}
                  {s.usageKey != null && (
                    <div className="text-[10px] text-amber-100/70">~{Math.round(s.avgDailyCalls)}/d</div>
                  )}
                </td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                  {s.dailyLimit == null ? (
                    <span className="text-amber-100/70">—</span>
                  ) : (
                    <span className={s.nearLimit ? "text-amber-300 font-semibold" : "text-white/80"}>
                      {pctLabel(s.pctOfDailyLimit)}
                      <div className="text-[10px] text-amber-100/70">{s.dailyLimit}/d</div>
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-1.5 text-white/75 max-w-[200px]">{s.feeds}</td>
                <td className="px-2.5 py-1.5 text-violet-200/70 max-w-[220px] hidden lg:table-cell text-[10px]">
                  {s.unusedAvailable === "—" ? "—" : s.unusedAvailable}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
