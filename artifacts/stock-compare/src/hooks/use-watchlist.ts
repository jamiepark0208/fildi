import { useState, useEffect, useCallback } from "react";

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

const STORAGE_KEY = "fildi_watchlist";

export function useWatchlist() {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setEntries(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Failed to load watchlist from localStorage", e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const addEntry = useCallback((ticker: string, colorTag: string = "") => {
    setEntries(prev => {
      if (prev.some(e => e.ticker === ticker)) return prev;
      const newEntries = [...prev, { ticker, colorTag, addedAt: Date.now() }];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newEntries));
      return newEntries;
    });
  }, []);

  const removeEntry = useCallback((ticker: string) => {
    setEntries(prev => {
      const newEntries = prev.filter(e => e.ticker !== ticker);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newEntries));
      return newEntries;
    });
  }, []);

  const updateColorTag = useCallback((ticker: string, colorTag: string) => {
    setEntries(prev => {
      const newEntries = prev.map(e => e.ticker === ticker ? { ...e, colorTag } : e);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newEntries));
      return newEntries;
    });
  }, []);

  return {
    entries,
    isLoaded,
    addEntry,
    removeEntry,
    updateColorTag
  };
}
