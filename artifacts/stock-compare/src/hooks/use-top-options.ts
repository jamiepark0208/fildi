// Top-N ranked sell-put / sell-call candidates for the Live tab.
// DB-only: nightly /api/options/rankings?livePrices=0 (no Schwab/Yahoo quote fan-out,
// no options/batch chain scan). Prefer watchlist hits, pad from Overall.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useAuth } from "@/context/AuthContext";
import { queryKeys } from "@/lib/query-keys";

interface RankingRow {
  ticker: string;
  strike: number;
  expiry: string;
  spot: number;
  premium: number;
  weeklyIncomePct: number | null;
  otmPct: number | null;
  delta: number | null;
  strikeIv: number | null;
  dte: number | null;
  optionScore: number;
  bidIsLive: boolean;
  /** A256: watchlist second-pass fallback. */
  relaxed?: boolean;
}

const RED_TAG = "#ef4444";

function scannerHiddenKey(userId: number | undefined): string {
  return userId ? `fildi_scanner_hidden_${userId}` : "fildi_scanner_hidden";
}

export interface TopOptionRow {
  ticker: string;
  spot: number;
  strike: number;
  expiry: string;
  dte: number;
  weeklyIncomePct: number;
  otmPct: number;
  delta: number | null;
  bufferSigmas: number | null;
  optionScore: number;
  bid: number;
  bidIsLive: boolean;
  relaxed?: boolean;
}

function toRow(r: RankingRow): TopOptionRow {
  // Snapshots store otmPct as a fraction (0.08 = 8%); UI shows percent points.
  const otmFrac = r.otmPct ?? 0;
  const otmPct = otmFrac > 0 && otmFrac < 1.5 ? otmFrac * 100 : otmFrac;
  const dte = r.dte ?? 0;
  const iv = r.strikeIv ?? 0;
  const bufferSigmas =
    otmFrac > 0 && iv > 0 && dte > 0
      ? (otmFrac > 1.5 ? otmFrac / 100 : otmFrac) / (iv * Math.sqrt(dte / 365))
      : null;
  return {
    ticker: r.ticker,
    spot: r.spot,
    strike: r.strike,
    expiry: r.expiry,
    dte,
    weeklyIncomePct: r.weeklyIncomePct ?? 0,
    otmPct,
    delta: r.delta,
    bufferSigmas,
    optionScore: r.optionScore,
    bid: r.premium,
    bidIsLive: r.bidIsLive,
    relaxed: r.relaxed === true,
  };
}

export function useTopOptions(side: "put" | "call", n = 7): { rows: TopOptionRow[]; isFetching: boolean } {
  const { user } = useAuth();
  const { entries } = useWatchlist();

  const displayTickers = useMemo(() => {
    let hidden = new Set<string>();
    try {
      const s = localStorage.getItem(scannerHiddenKey(user?.id));
      if (s) hidden = new Set(JSON.parse(s));
    } catch { /* corrupt localStorage */ }
    return entries.filter(e => e.colorTag !== RED_TAG && !hidden.has(e.ticker)).map(e => e.ticker);
  }, [entries, user?.id]);

  const watchlistSet = useMemo(() => new Set(displayTickers), [displayTickers]);

  // Lite rankings — skip livePrices (Live table doesn't paint day-%; Rankings page keeps the full key).
  const { data: snapRankings, isFetching } = useQuery({
    queryKey: queryKeys.optionsRankingsLite(side),
    queryFn: async (): Promise<{ rankings: RankingRow[] }> => {
      const res = await fetch(`/api/options/rankings?side=${side}&livePrices=0`);
      if (!res.ok) throw new Error("options rankings fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo((): TopOptionRow[] => {
    const all = snapRankings?.rankings ?? [];
    if (!all.length) return [];
    // Watchlist names first (desk context), then pad from Overall — never chain-fetch.
    const wl = all.filter((r) => watchlistSet.has(r.ticker));
    const rest = all.filter((r) => !watchlistSet.has(r.ticker));
    return [...wl, ...rest].slice(0, n).map(toRow);
  }, [snapRankings, watchlistSet, n]);

  return { rows, isFetching };
}
