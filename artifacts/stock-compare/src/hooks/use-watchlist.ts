import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";

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

/** Distinct slate tag for auto-added competitor tickers */
export const COMPETITOR_TAG_COLOR = "#64748b";

// Scoped per user so multiple users on same browser don't clobber each other's tags
function colorKey(userId: number | undefined): string {
  return userId ? `fildi_watchlist_colors_${userId}` : "fildi_watchlist_colors";
}

function loadColorMap(userId: number | undefined): Record<string, string> {
  try {
    const s = localStorage.getItem(colorKey(userId));
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

function saveColorMap(map: Record<string, string>, userId: number | undefined) {
  try { localStorage.setItem(colorKey(userId), JSON.stringify(map)); } catch {}
}

const QUERY_KEY = ["watchlist"] as const;

async function fetchWatchlist(): Promise<{ ticker: string; addedAt: string }[]> {
  const res = await fetch("/api/watchlist", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

export function useWatchlist() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;

  const { data = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchWatchlist,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const colorMap = loadColorMap(userId);

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
      const map = loadColorMap(userId);
      map[ticker] = colorTag;
      saveColorMap(map, userId);
    }
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient, userId]);

  const tagCompetitorsLocally = useCallback((tickers: string[]) => {
    const map = loadColorMap(userId);
    let changed = false;
    for (const raw of tickers) {
      const upper = raw.trim().toUpperCase();
      if (!upper || map[upper]) continue;
      map[upper] = COMPETITOR_TAG_COLOR;
      changed = true;
    }
    if (changed) {
      saveColorMap(map, userId);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  }, [queryClient, userId]);

  const removeEntry = useCallback(async (ticker: string) => {
    await fetch(`/api/watchlist/${encodeURIComponent(ticker)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const map = loadColorMap(userId);
    delete map[ticker];
    saveColorMap(map, userId);
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient, userId]);

  const updateColorTag = useCallback((ticker: string, colorTag: string) => {
    const map = loadColorMap(userId);
    if (colorTag) {
      map[ticker] = colorTag;
    } else {
      delete map[ticker];
    }
    saveColorMap(map, userId);
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient, userId]);

  return {
    entries,
    tickers: entries.map(e => e.ticker),
    isLoaded: !isLoading,
    addEntry,
    tagCompetitorsLocally,
    removeEntry,
    updateColorTag,
  };
}
