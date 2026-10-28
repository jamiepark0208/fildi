// Small trust signal surfaced next to model-driven picks — pulls the same
// ["track-record","summary"] data as the Track Record page so every surface
// agrees on one number. Below n=5 the win rate is suppressed (small-sample
// noise); we still show n so the badge communicates "too early to tell".
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GRADED_REC_WIN_RATE, MIN_N_FOR_WIN_RATE } from "@/lib/track-record-labels";

interface SideSummary {
  n: number;
  wins: number;
  winRate: number | null;
}

interface SummaryResponse {
  put: SideSummary;
  call: SideSummary;
}

export function CredibilityBadge({ side, className }: { side: "put" | "call"; className?: string }) {
  const { data } = useQuery({
    queryKey: ["track-record", "summary"],
    queryFn: async (): Promise<SummaryResponse> => {
      const res = await fetch("/api/track-record/summary");
      if (!res.ok) throw new Error("track-record summary fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (!data) return null;
  const summary = data[side];
  if (summary.n === 0) return null;

  const showWinRate = summary.n >= MIN_N_FOR_WIN_RATE;
  const label = showWinRate
    ? `${side}s ${Math.round((summary.winRate ?? 0) * 100)}% win · n=${summary.n}`
    : `${side}s n=${summary.n}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href="/track-record">
          <Badge
            variant="outline"
            className={cn("text-[10px] font-normal border-white/15 text-muted-foreground cursor-pointer hover:bg-white/5", className)}
          >
            {label}
          </Badge>
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        {showWinRate
          ? `${summary.wins}/${summary.n} · ${GRADED_REC_WIN_RATE}`
          : `Only ${summary.n} graded ${side} rec${summary.n === 1 ? "" : "s"} so far — too early for a reliable win rate`}
      </TooltipContent>
    </Tooltip>
  );
}
