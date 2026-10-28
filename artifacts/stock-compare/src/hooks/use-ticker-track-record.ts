// Cumulative win/loss counts per ticker per side — powers the "3W-1L" accountability
// badge shown next to a ticker in the scanner and live tables.
import { useQuery } from "@tanstack/react-query";

export interface SimRec {
  wins: number;
  losses: number;
  method: string;
}
export interface TickerRecord {
  wins: number;
  losses: number;
  sharpe?: number | null;
  openSpot?: number | null;
  openSnapshotDate?: string | null;
  entryDelta?: number | null;
  entryIv?: number | null;
  /** A186: put base rate when graded n=0 — grey "· sim", not a model grade. */
  simRec?: SimRec;
}
export type ByTickerResponse = Record<string, { put: TickerRecord; call: TickerRecord }>;

export function useTickerTrackRecord() {
  return useQuery({
    queryKey: ["track-record", "by-ticker", "v3"],
    queryFn: async (): Promise<ByTickerResponse> => {
      const res = await fetch("/api/track-record/by-ticker");
      if (!res.ok) throw new Error("track-record by-ticker fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
