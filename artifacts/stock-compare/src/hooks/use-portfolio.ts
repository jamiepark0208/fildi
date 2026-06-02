import { useState, useEffect, useCallback } from "react";

export type PositionType = "stock" | "short_put" | "short_call" | "long_put" | "long_call";

export interface PortfolioEntry {
  id: string;
  ticker: string;
  positionType: PositionType;
  qty: number;
  avgPrice: number;    // per share (stock) or premium per contract (options)
  strike?: number;     // options only
  expiry?: string;     // options only, "YYYY-MM-DD"
  openedAt: string;    // "YYYY-MM-DD"
  notes?: string;
}

const STORAGE_KEY = "fildi_portfolio_v1";

function load(): PortfolioEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(entries: PortfolioEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function usePortfolio() {
  const [entries, setEntries] = useState<PortfolioEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setEntries(load());
    setIsLoaded(true);
  }, []);

  const addEntry = useCallback((entry: Omit<PortfolioEntry, "id" | "openedAt">) => {
    const newEntry: PortfolioEntry = {
      ...entry,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      openedAt: new Date().toISOString().slice(0, 10),
    };
    setEntries(prev => {
      const next = [...prev, newEntry];
      save(next);
      return next;
    });
  }, []);

  const removeEntry = useCallback((id: string) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== id);
      save(next);
      return next;
    });
  }, []);

  const updateEntry = useCallback((id: string, patch: Partial<Omit<PortfolioEntry, "id">>) => {
    setEntries(prev => {
      const next = prev.map(e => e.id === id ? { ...e, ...patch } : e);
      save(next);
      return next;
    });
  }, []);

  return { entries, isLoaded, addEntry, removeEntry, updateEntry };
}

// ── Derived helpers ───────────────────────────────────────────────────────────

export function isOptionsPosition(type: PositionType): boolean {
  return type !== "stock";
}

export function isShortPosition(type: PositionType): boolean {
  return type === "short_put" || type === "short_call";
}

export function positionLabel(type: PositionType): string {
  return {
    stock: "Stock",
    short_put: "Short Put",
    short_call: "Short Call",
    long_put: "Long Put",
    long_call: "Long Call",
  }[type];
}

export function notionalValue(entry: PortfolioEntry): number {
  if (entry.positionType === "stock") return entry.qty * entry.avgPrice;
  // options: strike × 100 × contracts = max notional exposure
  return (entry.strike ?? 0) * 100 * entry.qty;
}

export function premiumReceived(entry: PortfolioEntry): number {
  if (!isShortPosition(entry.positionType)) return 0;
  return entry.avgPrice * 100 * entry.qty;
}

export function daysToExpiry(expiry: string | undefined): number | null {
  if (!expiry) return null;
  const ms = new Date(expiry + "T16:00:00").getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}
