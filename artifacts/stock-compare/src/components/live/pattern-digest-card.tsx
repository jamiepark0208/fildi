// Factual aggregate over already-graded intraday history — "how often does the
// market crash-then-recover and does a sweep-reclaim at the open predict it."
// No AI needed here: it's a plain stats rollup, not a narrative.
import { useQuery } from "@tanstack/react-query";

interface PatternDigest {
  sessionsAnalyzed: number;
  reversalUpCount: number;
  reversalUpPct: number | null;
  medianReversalAtMin: number | null;
  sweepAtOpenCount: number;
  reversalUpGivenSweepPct: number | null;
  reversalUpGivenNoSweepPct: number | null;
  summary: string;
}

function usePatternDigest() {
  return useQuery({
    queryKey: ["live", "pattern-digest"],
    queryFn: async (): Promise<PatternDigest> => {
      const res = await fetch("/api/live/pattern-digest");
      if (!res.ok) throw new Error("pattern-digest fetch failed");
      return res.json();
    },
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function PatternDigestCard() {
  const { data, isLoading } = usePatternDigest();
  if (isLoading || !data || data.sessionsAnalyzed === 0) return null;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 px-3 py-2">
      <span className="text-[11px] font-semibold text-[#d4af37] uppercase tracking-wide block mb-1">
        Intraday Pattern (last {data.sessionsAnalyzed} sessions)
      </span>
      <p className="text-[12px] text-sky-200/90 font-mono leading-snug">{data.summary}</p>
    </div>
  );
}
