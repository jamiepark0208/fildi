/**
 * A189 — live Strategy Library signals (panic-puts-hiv etc).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

export interface StrategySignalDetails {
  z?: number;
  iv30?: number;
  iv_jump_5d?: number;
  peer_group?: string | null;
  same_group_today?: number;
}

export interface StrategySignal {
  strategyId: string;
  asOf: string;
  ticker: string;
  trigger: string;
  details: StrategySignalDetails | null;
  occ: string | null;
  expiry: string | null;
  strike: number | null;
  entryMid: number | null;
  entryDate: string | null;
  status: string;
  settle: number | null;
  ret: number | null;
  itm: boolean | null;
  gradedAt: string | null;
}

export interface StrategySignalsLive {
  since: string;
  graded: number;
  hitRate: number | null;
  meanRet: number | null;
  backtestMeanRet: number;
}

export interface StrategySignalsResponse {
  strategyId: string;
  days: number;
  count: number;
  signals: StrategySignal[];
  live: StrategySignalsLive;
}

export function useStrategySignals(strategyId: string | null, days = 30) {
  return useQuery({
    queryKey: ["strategy-signals", strategyId, days],
    enabled: Boolean(strategyId),
    queryFn: async (): Promise<StrategySignalsResponse> => {
      const res = await fetch(
        `/api/strategies/${encodeURIComponent(strategyId!)}/signals?days=${days}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("strategy signals failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
}

/** Open/priced signals from the last `sessions` distinct as_of dates — Options board badge. */
export function useActivePanicPutBadges(sessions = 3) {
  const q = useStrategySignals("panic-puts-hiv", 14);
  const byTicker = useMemo(() => {
    const map = new Map<string, StrategySignal>();
    const rows = q.data?.signals ?? [];
    const dates = [...new Set(rows.map((r) => r.asOf))].sort().reverse().slice(0, sessions);
    const dateSet = new Set(dates);
    for (const s of rows) {
      if (!dateSet.has(s.asOf)) continue;
      if (s.status !== "open" && s.status !== "priced") continue;
      const prev = map.get(s.ticker);
      if (!prev || s.asOf > prev.asOf) map.set(s.ticker, s);
    }
    return map;
  }, [q.data?.signals, sessions]);
  return { ...q, byTicker };
}
