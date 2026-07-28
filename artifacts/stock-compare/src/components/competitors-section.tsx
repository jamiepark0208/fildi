import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface FundMetricBreakdown {
  label: string;
  value: number;
  zScore: number;
}

interface CompetitorRanked {
  rank: number;
  ticker: string;
  combinedScore: number | null;
  techScore: number | null;
  fundScore: number | null;
  pendingBackfill: boolean;
  breakdown: FundMetricBreakdown[];
}

interface CompetitorsResponse {
  ticker: string;
  groupId: string | null;
  groupName: string | null;
  sector: string | null;
  industry: string | null;
  source: "taxonomy" | "legacy";
  ranked: CompetitorRanked[];
}

interface CompetitorsSectionProps {
  ticker: string;
}

function useCompetitors(ticker: string) {
  return useQuery<CompetitorsResponse>({
    queryKey: ["stocks", "competitors", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/competitors/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error(`Failed to fetch competitors: ${res.status}`);
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 5 * 60 * 1000,
  });
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-white/40";
  if (score >= 65) return "text-green-400";
  if (score >= 45) return "text-yellow-400";
  return "text-red-400";
}

function zScoreColor(z: number): string {
  if (z >= 1.5) return "text-emerald-400";
  if (z >= 0.5) return "text-emerald-300/80";
  if (z <= -1.5) return "text-red-400";
  if (z <= -0.5) return "text-red-300/80";
  return "text-white/50";
}

function metricValueStr(val: number): string {
  if (Math.abs(val) >= 1000) return val.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(val) >= 10) return val.toFixed(1);
  return val.toFixed(2);
}

function CompetitorRow({ row }: { row: CompetitorRanked }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="grid grid-cols-[1fr_56px_56px_56px] items-center gap-2 py-1.5 px-1 rounded-md hover:bg-white/5 transition-colors cursor-default">
          <span className="font-mono font-semibold text-sm text-foreground">{row.ticker}</span>
          <span className={cn("text-right font-mono text-xs font-bold", scoreColor(row.combinedScore))}>
            {row.combinedScore != null ? row.combinedScore.toFixed(0) : "—"}
          </span>
          <span className={cn("text-right font-mono text-xs", scoreColor(row.fundScore))}>
            {row.fundScore != null ? row.fundScore.toFixed(0) : "—"}
          </span>
          <span className={cn("text-right font-mono text-xs", scoreColor(row.techScore))}>
            {row.techScore != null ? row.techScore.toFixed(0) : "—"}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[240px]">
        {row.breakdown.length === 0 ? (
          <p className="text-xs">No fundamental breakdown available.</p>
        ) : (
          <table className="text-[11px] border-collapse">
            <tbody>
              {row.breakdown.map((m, i) => (
                <tr key={i}>
                  <td className="pr-3 py-0.5 text-white/70">{m.label}</td>
                  <td className="pr-2 py-0.5 text-right font-mono text-white/60">{metricValueStr(m.value)}</td>
                  <td className={cn("py-0.5 text-right font-mono font-semibold", zScoreColor(m.zScore))}>
                    {m.zScore >= 0 ? "+" : ""}{m.zScore.toFixed(1)}σ
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {row.pendingBackfill && (
          <p className="text-[10px] text-white/40 mt-1">Some data is stale — score may update soon.</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Fundamental/technical peer scoring — read-only, DB-persisted (no navigation). */
export function CompetitorsSection({ ticker }: CompetitorsSectionProps) {
  const { data, isLoading } = useCompetitors(ticker);
  const subtitle = data?.groupName ?? [data?.industry, data?.sector].filter(Boolean).join(" · ");

  return (
    <div>
      {subtitle && <p className="text-xs text-foreground mb-3">{subtitle}</p>}

      {isLoading ? (
        <p className="text-sm text-foreground">Loading…</p>
      ) : !data || data.ranked.length === 0 ? (
        <p className="text-sm text-foreground">No peers found for this ticker yet.</p>
      ) : (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[1fr_56px_56px_56px] gap-2 px-1 pb-1 border-b border-border/40">
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wide">Ticker</span>
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wide text-right">Total</span>
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wide text-right">Fund</span>
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wide text-right">Tech</span>
          </div>
          {data.ranked.map(row => (
            <CompetitorRow key={row.ticker} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
