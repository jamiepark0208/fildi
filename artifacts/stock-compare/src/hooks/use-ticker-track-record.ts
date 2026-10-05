// Cumulative win/loss counts per ticker per side — powers the "3W-1L" accountability
// badge shown next to a ticker in the scanner and live tables.
import { useQuery } from "@tanstack/react-query";

export interface TickerRecord {
  wins: number;
  losses: number;
  sharpe?: number | null;
  openSpot?: number | null;
  openSnapshotDate?: string | null;
  entryDelta?: number | null;
  entryIv?: number | null;
}
export type ByTickerResponse = Record<string, { put: TickerRecord; call: TickerRecord }>;

export function useTickerTrackRecord() {
  return useQuery({
    queryKey: ["track-record", "by-ticker", "v2"],
    queryFn: async (): Promise<ByTickerResponse> => {
      const res = await fetch("/api/track-record/by-ticker");
      if (!res.ok) throw new Error("track-record by-ticker fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
