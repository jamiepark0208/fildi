/**
 * Trade ticket store — one page-wide list of legs across tickers (bid/ask buttons add, the dock edits).
 * Kept in localStorage so a ticket survives reloads and tab switches. Math: trade-ticket.ts.
 */
import { useSyncExternalStore } from "react";
import type { TicketLeg } from "./trade-ticket";

const STORE_ID = "fildi.trade-ticket.v1";
const MAX_LEGS = 24;

type State = { legs: TicketLeg[]; open: boolean; pricing?: boolean };

function load(): State {
  try {
    const raw = localStorage.getItem(STORE_ID);
    if (raw) {
      const s = JSON.parse(raw) as Partial<State>;
      if (Array.isArray(s.legs)) return { legs: s.legs.slice(0, MAX_LEGS), open: !!s.open };
    }
  } catch { /* private mode / bad json → empty ticket */ }
  return { legs: [], open: false };
}

let state: State = typeof window === "undefined" ? { legs: [], open: false } : load();
const listeners = new Set<() => void>();
let inflight = 0;   // overlapping reprices: "Pricing…" clears only when the last one lands

function set(next: State) {
  state = next;
  try { localStorage.setItem(STORE_ID, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export type ContractSpec = Pick<TicketLeg, "ticker" | "kind" | "side" | "qty" | "strike" | "expiry">;
type QuoteResp = { ticker: string; kind: TicketLeg["kind"]; strike?: number; expiry?: string;
  bid: number | null; ask: number | null; iv: number | null; spot: number | null; quoted: boolean; reason?: string };

/** Fill = ask on a buy, bid on a sell; the side missing → leg stays unquoted (never priced at a fake 0). */
export function applyQuote(l: TicketLeg, q: QuoteResp | undefined, at: number): TicketLeg {
  if (!q || !q.quoted || !(q.spot && q.spot > 0)) return { ...l, unquoted: q?.reason ?? "no quote" };
  const px = l.kind === "stock" ? q.spot : l.side === "long" ? q.ask : q.bid;
  if (px == null || !(px > 0)) return { ...l, spot: q.spot, unquoted: l.side === "long" ? "no ask" : "no bid" };
  return { ...l, price: px, iv: q.iv ?? l.iv, spot: q.spot, quotedAt: at, unquoted: undefined };
}

const sameContract = (a: TicketLeg, b: Pick<TicketLeg, "ticker" | "kind" | "side" | "strike" | "expiry">) =>
  a.ticker === b.ticker && a.kind === b.kind && a.side === b.side && a.strike === b.strike && a.expiry === b.expiry;

export const ticket = {
  /** Same contract + side again → qty + 1 (price = latest fill). */
  add(leg: Omit<TicketLeg, "id" | "addedAt" | "qty"> & { qty?: number }) {
    const hit = state.legs.find((l) => sameContract(l, leg));
    const legs = hit
      ? state.legs.map((l) => (l === hit ? { ...l, qty: l.qty + (leg.qty ?? 1), price: leg.price, iv: leg.iv, spot: leg.spot, quotedAt: Date.now(), unquoted: undefined } : l))
      : [...state.legs, { ...leg, qty: leg.qty ?? 1, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now(), quotedAt: Date.now() }]
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
  /**
   * Add contracts without a live price (recs, past picks, structures) — they come in unpriced and are
   * repriced from the server right away (fill = ask on buys, bid on sells). Same contract + side → qty adds.
   */
  addContracts(specs: ContractSpec[]) {
    const now = Date.now();
    let legs = [...state.legs];
    const touched: string[] = [];
    for (const s of specs) {
      if (s.kind !== "stock" && s.expiry && Date.parse(`${s.expiry}T21:00:00Z`) < now) continue; // expired
      const hit = legs.find((l) => sameContract(l, s));
      if (hit) {
        legs = legs.map((l) => (l === hit ? { ...l, qty: l.qty + s.qty } : l));
        touched.push(hit.id);
      } else {
        const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        legs.push({ ...s, id, addedAt: now, price: 0, spot: 0, unquoted: "pricing…" });
        touched.push(id);
      }
    }
    set({ ...state, legs: legs.slice(-MAX_LEGS), open: true });
    if (touched.length) void ticket.reprice(touched);
    return touched.length;
  },
  /** Live bid/ask/IV/spot for the given legs (all when omitted). */
  async reprice(ids?: string[]) {
    const want = state.legs.filter((l) => !ids || ids.includes(l.id));
    if (!want.length) return;
    inflight++;
    set({ ...state, pricing: true });
    try {
      const r = await fetch("/api/options/ticket-quotes", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs: want.map(({ ticker, kind, strike, expiry }) => ({ ticker, kind, strike, expiry })) }),
      });
      if (!r.ok) throw new Error(`quotes ${r.status}`);
      const { quotes } = (await r.json()) as { quotes: QuoteResp[] };
      const at = Date.now();
      const legs = state.legs.map((l) => {
        if (!want.some((w) => w.id === l.id)) return l;
        const q = quotes.find((x) => x.ticker === l.ticker && x.kind === l.kind && x.strike === l.strike && x.expiry === l.expiry);
        return applyQuote(l, q, at);
      });
      set({ ...state, legs, pricing: --inflight > 0 });
    } catch {
      set({ ...state, pricing: --inflight > 0, legs: state.legs.map((l) => (want.some((w) => w.id === l.id) && l.unquoted ? { ...l, unquoted: "quote failed — retry" } : l)) });
    }
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
