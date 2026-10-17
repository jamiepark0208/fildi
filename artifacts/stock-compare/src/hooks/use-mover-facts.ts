import { useQuery } from "@tanstack/react-query";

export type MoverFactRow = {
  ticker: string;
  line: string;
  movePct: number | null;
  driver: string;
  driverDetail: string | null;
};

/** A81 facts for scanner tickers with |day move| ≥ minAbs. */
export function useMoverFacts(tickers: string[], minAbs = 5) {
  const key = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))].sort().join(",");
  return useQuery({
    queryKey: ["mover-facts", key, minAbs],
    queryFn: async (): Promise<Record<string, MoverFactRow>> => {
      if (!key) return {};
      const r = await fetch(
        `/api/options/mover-facts?tickers=${encodeURIComponent(key)}&minAbs=${minAbs}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(`mover-facts ${r.status}`);
      const body = await r.json() as { rows: MoverFactRow[] };
      return Object.fromEntries((body.rows ?? []).map((row) => [row.ticker, row]));
    },
    enabled: key.length > 0,
    staleTime: 2 * 60_000,
  });
}
