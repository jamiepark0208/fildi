/**
 * A189 — live Strategy Library signals (panic-puts-hiv etc).
 * A330/A341 — shadow challenger tags on Model List / Options board.
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

/** Shadow strategy chips — tooltip ≤ 12 words with in-sample bp (A341). */
export const SHADOW_STRATEGY_META: Record<string, { label: string; tip: string }> = {
  put_climax_spy_oversold: { label: "Clx", tip: "S151 climax + SPY oversold, shadow" },
  put_climax_low_ivrv: { label: "ClxIV", tip: "S151 climax + low IV÷RV, shadow" },
  put_gap_up_5pct_d20: { label: "Gap5", tip: "Gap-up ≥5%: +21.5 bp/wk in top picks, shadow" },
  put_z50_dip_d20: { label: "Z50", tip: "Z50 dip −2.5σ: +9.3 bp/wk in top picks, shadow" },
};

export const SHADOW_STRATEGY_IDS = Object.keys(SHADOW_STRATEGY_META);

/** Chip label + tip for any strategy id: the hand-written meta when there is one, else the study id + its trigger (Jamie 11-09:
 *  new strategies must show without front-end wiring). */
export function strategyMeta(s: Pick<StrategySignal, "strategyId" | "trigger" | "details">): { label: string; tip: string } {
  const m = SHADOW_STRATEGY_META[s.strategyId];
  if (m) return m;
  const study = (s.details as { study?: string } | null)?.study;
  return { label: study ?? s.strategyId.slice(0, 6), tip: s.trigger };
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

async function fetchStrategySignals(strategyId: string, days: number): Promise<StrategySignalsResponse> {
  const res = await fetch(
    `/api/strategies/${encodeURIComponent(strategyId)}/signals?days=${days}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error("strategy signals failed");
  return res.json();
}

export function useStrategySignals(strategyId: string | null, days = 30) {
  return useQuery({
    queryKey: ["strategy-signals", strategyId, days],
    enabled: Boolean(strategyId),
    queryFn: () => fetchStrategySignals(strategyId!, days),
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

/** Open/priced A330/A341 shadow challenger fires — Model List put rows + Options board. */
export function useActiveShadowStrategyBadges(sessions = 3) {
  const q = useQuery({
    queryKey: ["strategy-signals-active", 14] as const,
    queryFn: async (): Promise<{ signals: StrategySignal[] }> => {
      const res = await fetch("/api/strategy-signals/active?days=14", { credentials: "include" });
      if (!res.ok) throw new Error("active strategy signals failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  const dataStamp = String(q.dataUpdatedAt);
  const byTicker = useMemo(() => {
    const map = new Map<string, StrategySignal[]>();
    const byId = new Map<string, StrategySignal[]>();
    for (const s of q.data?.signals ?? []) byId.set(s.strategyId, [...(byId.get(s.strategyId) ?? []), s]);
    for (const rows of byId.values()) {
      const dates = [...new Set(rows.map((r) => r.asOf))].sort().reverse().slice(0, sessions);
      const dateSet = new Set(dates);
      for (const s of rows) {
        if (!dateSet.has(s.asOf)) continue;
        if (s.status !== "open" && s.status !== "priced" && s.status !== "listed") continue;
        const t = s.ticker.toUpperCase();
        const list = map.get(t) ?? [];
        if (!list.some((x) => x.strategyId === s.strategyId && x.asOf === s.asOf)) {
          list.push(s);
          map.set(t, list);
        }
      }
    }
    return map;
    // dataStamp tracks query result identity; queries array is stable enough per render batch
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataStamp is the intentional dep
  }, [dataStamp, sessions]);
  return { byTicker, isLoading: q.isLoading };
}
