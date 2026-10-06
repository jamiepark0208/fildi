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
  isSubject?: boolean;
  combinedScore: number | null;
  techScore: number | null;
  fundScore: number | null;
  fundValue?: number | null;
  fundGrowth?: number | null;
  fundQuality?: number | null;
  fundSafety?: number | null;
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
  /** Click peer → navigate / select */
  onSelectTicker?: (t: string) => void;
  /** Dense table without outer chrome (Breakdown embeds its own panel). */
  compact?: boolean;
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

function scoreColor(score: number | null | undefined): string {
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

function fmt(score: number | null | undefined): string {
  return score != null ? score.toFixed(0) : "—";
}

const COLS = "grid-cols-[minmax(0,1.2fr)_28px_28px_22px_22px_22px_22px_28px]";

function CompetitorRow({
  row,
  onSelectTicker,
}: {
  row: CompetitorRanked;
  onSelectTicker?: (t: string) => void;
}) {
  const clickable = !!onSelectTicker && !row.isSubject;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={!clickable}
          onClick={() => clickable && onSelectTicker?.(row.ticker)}
          className={cn(
            "grid w-full items-center gap-0.5 py-0.5 px-1 rounded text-left transition-colors",
            COLS,
            row.isSubject
              ? "bg-[#d4af37]/10 border border-[#d4af37]/25"
              : "hover:bg-white/5",
            clickable ? "cursor-pointer" : "cursor-default",
          )}
        >
          <span
            className={cn(
              "font-mono font-semibold text-[11px] truncate",
              row.isSubject ? "text-[#d4af37]" : "text-foreground",
            )}
          >
            {row.ticker}
            {row.isSubject ? " · you" : ""}
          </span>
          <span className={cn("text-right font-mono text-[10px] font-bold", scoreColor(row.combinedScore))}>
            {fmt(row.combinedScore)}
          </span>
          <span className={cn("text-right font-mono text-[10px]", scoreColor(row.fundScore))}>
            {fmt(row.fundScore)}
          </span>
          <span className={cn("text-right font-mono text-[9px]", scoreColor(row.fundValue))}>
            {fmt(row.fundValue)}
          </span>
          <span className={cn("text-right font-mono text-[9px]", scoreColor(row.fundGrowth))}>
            {fmt(row.fundGrowth)}
          </span>
          <span className={cn("text-right font-mono text-[9px]", scoreColor(row.fundQuality))}>
            {fmt(row.fundQuality)}
          </span>
          <span className={cn("text-right font-mono text-[9px]", scoreColor(row.fundSafety))}>
            {fmt(row.fundSafety)}
          </span>
          <span className={cn("text-right font-mono text-[10px]", scoreColor(row.techScore))}>
            {fmt(row.techScore)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[260px]">
        {row.breakdown.length === 0 ? (
          <p className="text-xs">No metric breakdown.</p>
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

/** Peer cohort ranked by tech+fund — relative comparison table. */
export function CompetitorsSection({ ticker, onSelectTicker, compact }: CompetitorsSectionProps) {
  const { data, isLoading } = useCompetitors(ticker);
  const subtitle = data?.groupName ?? [data?.industry, data?.sector].filter(Boolean).join(" · ");

  if (isLoading) {
    return <p className="text-[11px] text-amber-200/50">Loading peers…</p>;
  }
  if (!data || data.ranked.length === 0) {
    return <p className="text-[11px] text-amber-200/45 italic">No peers found for this ticker yet.</p>;
  }

  return (
    <div className={cn(!compact && "space-y-1")}>
      {subtitle && (
        <p className="text-[10px] text-zinc-500 truncate mb-1">{subtitle}</p>
      )}
      <div className={cn("grid gap-0.5 px-1 pb-0.5 border-b border-[#d4af37]/20", COLS)}>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide truncate">Ticker</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">Tot</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">Fnd</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">V</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">G</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">Q</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">S</span>
        <span className="text-[9px] font-semibold text-[#d4af37]/70 uppercase tracking-wide text-right">Tch</span>
      </div>
      <div className={cn(!compact && "max-h-[280px] overflow-y-auto")}>
        {data.ranked.map((row) => (
          <CompetitorRow key={row.ticker} row={row} onSelectTicker={onSelectTicker} />
        ))}
      </div>
    </div>
  );
}
