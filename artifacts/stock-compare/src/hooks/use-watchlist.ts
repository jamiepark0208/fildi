import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { toast } from "@/hooks/use-toast";

export type WatchlistEntry = {
  ticker: string;
  colorTag: string;
  addedAt: number;
};

export const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
];

/** CSP-workflow meaning of each preset tag color, for legend / tooltip copy. */
export const COLOR_LABELS: Record<string, string> = {
  "#ef4444": "Short",
  "#eab308": "Option income / watching to go long if it drops",
  "#22c55e": "Long",
  "#3b82f6": "My holdings",
  "#a855f7": "Neutral — monitoring",
};

/** Distinct slate tag for auto-added competitor tickers */
export const COMPETITOR_TAG_COLOR = "#64748b";

const WATCHLIST_QUERY_BASE = "watchlist" as const;

type WatchlistRow = { ticker: string; addedAt: string; colorTag: string };

async function fetchWatchlist(): Promise<WatchlistRow[]> {
  const res = await fetch("/api/watchlist", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

/** Another user's tagged watchlist, for profile viewing. colorTag is server-persisted (not localStorage). */
export async function fetchWatchlistFor(username: string): Promise<WatchlistRow[]> {
  const res = await fetch(`/api/watchlist/user/${encodeURIComponent(username)}`, { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

export function useWatchlist() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;
  const QUERY_KEY = [WATCHLIST_QUERY_BASE, userId] as const;

  const { data = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchWatchlist,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !!userId,
  });

  const entries: WatchlistEntry[] = data.map(row => ({
    ticker: row.ticker,
    colorTag: row.colorTag ?? "",
    addedAt: new Date(row.addedAt).getTime(),
  }));

  const addEntry = useCallback(async (ticker: string, colorTag: string = "") => {
    const res = await fetch("/api/watchlist", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, colorTag }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast({
        title: "Couldn't add ticker",
        description: body.error ?? "Unknown error",
        variant: "destructive",
      });
      return;
    }
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const removeEntry = useCallback(async (ticker: string) => {
    await fetch(`/api/watchlist/${encodeURIComponent(ticker)}`, {
      method: "DELETE",
      credentials: "include",
    });
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const updateColorTag = useCallback(async (ticker: string, colorTag: string) => {
    await fetch(`/api/watchlist/${encodeURIComponent(ticker)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colorTag }),
    });
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  return {
    entries,
    tickers: entries.map(e => e.ticker),
    isLoaded: !isLoading,
    addEntry,
    removeEntry,
    updateColorTag,
  };
}
