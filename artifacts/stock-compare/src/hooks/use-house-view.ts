/**
 * A190 — daily house view (odds + coherence warnings). Display only.
 */
import { useQuery } from "@tanstack/react-query";

export type HouseViewOdds = {
  as_of?: string;
  vix?: number;
  up?: { base_rate?: number; s057_logit?: number };
  tail?: { base_rate?: number; s057_logit?: number; market_vix?: number };
};

export type HouseViewPayload = {
  odds?: HouseViewOdds;
  lists?: { plan?: number; puts_live?: number; trim?: string[] };
  context?: Record<string, unknown>;
};

export type HouseView = {
  viewDate: string;
  createdAt: string | null;
  memo: string;
  stance: string | null;
  warnings: string[];
  payload: HouseViewPayload;
};

export function useHouseView() {
  return useQuery({
    queryKey: ["pm-house-view"],
    queryFn: async (): Promise<HouseView | null> => {
      const r = await fetch("/api/pm/house-view", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).view;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}

export function pct01(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
