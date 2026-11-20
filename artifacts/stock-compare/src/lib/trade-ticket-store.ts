/**
 * Trade ticket store — one page-wide list of legs across tickers (bid/ask buttons add, the dock edits).
 * Kept in localStorage so a ticket survives reloads and tab switches. Math: trade-ticket.ts.
 */
import { useSyncExternalStore } from "react";
import type { TicketLeg } from "./trade-ticket";

const KEY = "fildi.trade-ticket.v1";
const MAX_LEGS = 24;

type State = { legs: TicketLeg[]; open: boolean };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<State>;
      if (Array.isArray(s.legs)) return { legs: s.legs.slice(0, MAX_LEGS), open: !!s.open };
    }
  } catch { /* private mode / bad json → empty ticket */ }
  return { legs: [], open: false };
}

let state: State = typeof window === "undefined" ? { legs: [], open: false } : load();
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

const sameContract = (a: TicketLeg, b: Omit<TicketLeg, "id" | "addedAt" | "qty">) =>
  a.ticker === b.ticker && a.kind === b.kind && a.side === b.side && a.strike === b.strike && a.expiry === b.expiry;

export const ticket = {
  /** Same contract + side again → qty + 1 (price = latest fill). */
  add(leg: Omit<TicketLeg, "id" | "addedAt" | "qty"> & { qty?: number }) {
    const hit = state.legs.find((l) => sameContract(l, leg));
    const legs = hit
      ? state.legs.map((l) => (l === hit ? { ...l, qty: l.qty + (leg.qty ?? 1), price: leg.price, iv: leg.iv, spot: leg.spot } : l))
      : [...state.legs, { ...leg, qty: leg.qty ?? 1, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now() }]
          .slice(-MAX_LEGS);
    set({ legs, open: true });
  },
  update(id: string, patch: Partial<TicketLeg>) {
    set({ ...state, legs: state.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  },
  remove(id: string) {
    const legs = state.legs.filter((l) => l.id !== id);
    set({ legs, open: legs.length > 0 && state.open });
  },
  clear() { set({ legs: [], open: false }); },
  setOpen(open: boolean) { set({ ...state, open }); },
};

export function useTicket(): State {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
}
