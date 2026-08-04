// Shared fetch for the model's auto-tilt state — server already applies the
// bounded tilt to full default strike-weight sets, so callers just pick
// put/call weights straight off the response (no client-side applyTilt needed).
import { useQuery } from "@tanstack/react-query";

export interface TiltSideResult {
  factor: number;
  weights: Record<string, number>;
}

export interface TiltSideStats {
  winRate: number | null;
  avgPnlPct: number | null;
  n: number;
  updatedAt: string | null;
}

export interface TrackRecordTiltResponse {
  state: { put: TiltSideStats; call: TiltSideStats };
  put: TiltSideResult;
  call: TiltSideResult;
  minN: number;
  anchorWinRate: number;
}

export function useTrackRecordTilt() {
  return useQuery({
    queryKey: ["track-record", "tilt"],
    queryFn: async (): Promise<TrackRecordTiltResponse> => {
      const res = await fetch("/api/track-record/tilt");
      if (!res.ok) throw new Error("track-record tilt fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
