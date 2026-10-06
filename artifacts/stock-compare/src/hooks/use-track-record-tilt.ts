// Shared fetch for the model's auto-tilt / multi-knob policy state — server already
// applies the bounded policy to full default strike-weight sets.
import { useQuery } from "@tanstack/react-query";
import type { CalibrationTable } from "@workspace/option-scoring";

export interface TiltSideResult {
  factor: number;
  weights: Record<string, number>;
  sqFloor: number;
  earningsHaircut: number;
  version: number;
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
  /** Full table from getCalibrationTable() — pickBestStrike reads side `n` for its min-sample guard. */
  calibration: CalibrationTable | null;
  minN: number;
  sqFloorBase: number;
  // Driven by avgPnlPct (signed), NOT winRate — winRate is display-only.
  anchorPnlPct: number;
  spanPnlPct: number;
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
