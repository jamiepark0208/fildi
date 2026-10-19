import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

export type MoverFactRow = {
  ticker: string;
  line: string;
  movePct: number | null;
  driver: string;
  driverDetail: string | null;
};

/** A81 facts for tickers with |day move| ≥ minAbs. Pass movePctByTicker to skip a second live quote. */
export function useMoverFacts(
  tickers: string[],
  minAbs = 5,
  movePctByTicker?: Record<string, number | null>,
) {
  const key = useMemo(
    () => [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))].sort().join(","),
    [tickers],
  );
  const moveKey = useMemo(() => {
    if (!movePctByTicker || !key) return "";
    return key.split(",").map((t) => {
      const v = movePctByTicker[t];
      return v != null && Number.isFinite(v) ? `${t}:${v.toFixed(2)}` : t;
    }).join(",");
  }, [key, movePctByTicker]);

  return useQuery({
    queryKey: ["mover-facts", key, minAbs, moveKey],
    queryFn: async (): Promise<Record<string, MoverFactRow>> => {
      if (!key) return {};
      const qs = new URLSearchParams({ tickers: key, minAbs: String(minAbs) });
      if (moveKey) qs.set("movePct", moveKey);
      const r = await fetch(`/api/options/mover-facts?${qs}`, { credentials: "include" });
      if (!r.ok) throw new Error(`mover-facts ${r.status}`);
      const body = await r.json() as { rows: MoverFactRow[] };
      return Object.fromEntries((body.rows ?? []).map((row) => [row.ticker, row]));
    },
    enabled: key.length > 0,
    staleTime: 2 * 60_000,
  });
}
