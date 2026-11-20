/**
 * Trade ticket — multi-leg, multi-stock payoff math (pure; UI store in trade-ticket-store.ts).
 * X axis = market move m (fraction). Each ticker moves beta × m from its spot (beta = 1 → same % move).
 * Options valued at intrinsic on/after their expiry, Black-Scholes (leg IV, r = 0) before it.
 * Leg price = what you pay (ask, long) or receive (bid, short) — the fill, not mid.
 */
import { normCdf } from "./prob-cone.ts";

export type LegKind = "call" | "put" | "stock";
export type LegSide = "long" | "short";

export interface TicketLeg {
  id: string;
  ticker: string;
  kind: LegKind;
  side: LegSide;
  qty: number;
  strike?: number;
  expiry?: string; // YYYY-MM-DD
  /** Fill per share (option premium or stock price). */
  price: number;
  /** Annual IV as a fraction (options only). */
  iv?: number;
  /** Underlying price when the leg was added. */
  spot: number;
  addedAt: number;
}

const DAY_MS = 86_400_000;
export const mult = (l: Pick<TicketLeg, "kind">) => (l.kind === "stock" ? 1 : 100);
const sign = (l: Pick<TicketLeg, "side">) => (l.side === "long" ? 1 : -1);

/** Expiry close (16:00 ET ≈ 21:00 UTC) in ms. */
export function expiryMs(expiry: string): number {
  return Date.parse(`${expiry}T21:00:00Z`);
}

export function bsPrice(kind: "call" | "put", S: number, K: number, iv: number, tYears: number): number {
  if (tYears <= 0 || iv <= 0 || S <= 0) return kind === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sd = iv * Math.sqrt(tYears);
  const d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return kind === "call" ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

/** Per-share value of one leg at underlying S on date atMs. */
export function legValue(leg: TicketLeg, S: number, atMs: number): number {
  if (leg.kind === "stock") return S;
  const K = leg.strike ?? 0;
  const t = leg.expiry ? (expiryMs(leg.expiry) - atMs) / (365 * DAY_MS) : 0;
  return bsPrice(leg.kind, S, K, leg.iv ?? 0, t);
}

/** $ P&L of one leg (all contracts) at S on atMs. */
export function legPnl(leg: TicketLeg, S: number, atMs: number): number {
  return sign(leg) * (legValue(leg, S, atMs) - leg.price) * mult(leg) * leg.qty;
}

/** Net $ paid to open (debit > 0, credit < 0). */
export function netCost(legs: TicketLeg[]): number {
  return legs.reduce((s, l) => s + sign(l) * l.price * mult(l) * l.qty, 0);
}

/** First option expiry among the legs (the "at expiry" date); null for stock-only. */
export function firstExpiryMs(legs: TicketLeg[]): number | null {
  const xs = legs.filter((l) => l.kind !== "stock" && l.expiry).map((l) => expiryMs(l.expiry!));
  return xs.length ? Math.min(...xs) : null;
}

export const tickersOf = (legs: TicketLeg[]) => [...new Set(legs.map((l) => l.ticker))];

/** Underlying price at market move m. */
export function spotAt(leg: Pick<TicketLeg, "spot">, m: number, beta = 1): number {
  return Math.max(0.01, leg.spot * (1 + beta * m));
}

export interface CurvePoint {
  move: number;
  total: number;
  byTicker: Record<string, number>;
}

/** P&L by market move at date atMs. betas missing → 1. */
export function ticketCurve(
  legs: TicketLeg[], moves: number[], atMs: number, betas: Record<string, number> = {},
): CurvePoint[] {
  return moves.map((m) => {
    const byTicker: Record<string, number> = {};
    let total = 0;
    for (const l of legs) {
      const p = legPnl(l, spotAt(l, m, betas[l.ticker] ?? 1), atMs);
      byTicker[l.ticker] = (byTicker[l.ticker] ?? 0) + p;
      total += p;
    }
    return { move: m, total, byTicker };
  });
}

export function moveGrid(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

export interface TicketSummary {
  cost: number;
  /** null = unbounded (keeps growing / falling past +300 %). */
  maxGain: number | null;
  maxLoss: number | null;
  /** Market moves (fractions) where expiry P&L crosses 0. */
  breakevens: number[];
  atMs: number;
}

/** Summary at the first expiry (later legs still carry time value). */
export function ticketSummary(legs: TicketLeg[], betas: Record<string, number> = {}, nowMs = Date.now()): TicketSummary {
  const atMs = firstExpiryMs(legs) ?? nowMs;
  // Down far enough that the lowest-beta name reaches ~0 (spot floors at $0.01); up to +300 % of the market.
  const minBeta = Math.min(1, ...tickersOf(legs).map((t) => betas[t] ?? 1));
  const lo = -1 / Math.max(0.25, minBeta), hi = 3;
  const grid = moveGrid(lo, hi, 801);
  const curve = ticketCurve(legs, grid, atMs, betas).map((p) => p.total);
  const tail = ticketCurve(legs, [hi * 2], atMs, betas)[0].total;
  const top = Math.max(...curve), bot = Math.min(...curve);
  const last = curve[curve.length - 1];
  const rising = tail - last > Math.max(1, Math.abs(last) * 0.01);
  const falling = last - tail > Math.max(1, Math.abs(last) * 0.01);
  const breakevens: number[] = [];
  for (let i = 1; i < grid.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (a === 0 && i === 1) breakevens.push(grid[0]);
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      breakevens.push(grid[i - 1] + ((grid[i] - grid[i - 1]) * -a) / (b - a));
    }
  }
  return {
    cost: netCost(legs),
    maxGain: rising ? null : Math.max(top, tail),
    maxLoss: falling ? null : Math.min(bot, tail),
    breakevens,
    atMs,
  };
}

/** Net delta in $ per 1 % market move (beta-weighted), today. */
export function dollarDeltaPer1Pct(legs: TicketLeg[], betas: Record<string, number> = {}, nowMs = Date.now()): number {
  const h = 0.005;
  const [dn, up] = ticketCurve(legs, [-h, h], nowMs, betas);
  return ((up.total - dn.total) / (2 * h)) * 0.01;
}
