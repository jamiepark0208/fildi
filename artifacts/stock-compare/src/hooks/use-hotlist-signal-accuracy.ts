// Win-rate per (side, signal) bucket for hotlist GO/WATCH picks — powers the
// accuracy chip shown next to the Signal badge in the live hotlist table.
// Reuses /track-record/summary, which already aggregates this server-side.
import { useQuery } from "@tanstack/react-query";

export interface HotlistSignalStat {
  side: string;
  signal: string;
  n: number;
  wins: number;
  winRate: number | null;
  avgFwdReturn5d: number | null;
  pending: number;
}

type SummaryResponse = { hotlist: HotlistSignalStat[] };

export function useHotlistSignalAccuracy() {
  return useQuery({
    queryKey: ["track-record", "summary"],
    queryFn: async (): Promise<SummaryResponse> => {
      const res = await fetch("/api/track-record/summary");
      if (!res.ok) throw new Error("track-record summary fetch failed");
      return res.json();
    },
    select: (data): Map<string, HotlistSignalStat> => {
      const map = new Map<string, HotlistSignalStat>();
      for (const s of data.hotlist) map.set(`${s.side}|${s.signal}`, s);
      return map;
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
