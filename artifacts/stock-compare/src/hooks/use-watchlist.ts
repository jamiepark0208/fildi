import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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

const COLOR_KEY = "fildi_watchlist_colors";

function loadColorMap(): Record<string, string> {
  try {
    const s = localStorage.getItem(COLOR_KEY);
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

function saveColorMap(map: Record<string, string>) {
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(map)); } catch {}
}

const QUERY_KEY = ["watchlist"] as const;

async function fetchWatchlist(): Promise<{ ticker: string; addedAt: string }[]> {
  const res = await fetch("/api/watchlist", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

export function useWatchlist() {
  const queryClient = useQueryClient();

  const { data = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchWatchlist,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const colorMap = loadColorMap();

  const entries: WatchlistEntry[] = data.map(row => ({
    ticker: row.ticker,
    colorTag: colorMap[row.ticker] ?? "",
    addedAt: new Date(row.addedAt).getTime(),
  }));

  const addEntry = useCallback(async (ticker: string, colorTag: string = "") => {
    await fetch("/api/watchlist", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    if (colorTag) {
      const map = loadColorMap();
      map[ticker] = colorTag;
      saveColorMap(map);
    }
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const removeEntry = useCallback(async (ticker: string) => {
    await fetch(`/api/watchlist/${encodeURIComponent(ticker)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const map = loadColorMap();
    delete map[ticker];
    saveColorMap(map);
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const updateColorTag = useCallback((ticker: string, colorTag: string) => {
    const map = loadColorMap();
    map[ticker] = colorTag;
    saveColorMap(map);
    // Force re-render by invalidating (entries are derived from data + colorMap)
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
