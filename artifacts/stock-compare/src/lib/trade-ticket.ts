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
  /** When price/iv/spot last came from a live quote (addedAt if added from a quoted row). */
  quotedAt?: number;
  /** Set while the leg has no usable quote (reason); such legs are left out of the payoff. */
  unquoted?: string;
}

/** Legs the payoff can use: quoted, with a spot. */
export const pricedLegs = (legs: TicketLeg[]) => legs.filter((l) => !l.unquoted && l.spot > 0 && l.price >= 0);

/**
 * One spot per name: every leg takes the spot of that name's most recently quoted leg, so legs added at
 * different times share one X axis (fills stay as paid — the gap shows up as today's P&L).
 */
export function alignSpots(legs: TicketLeg[]): TicketLeg[] {
  const ref = new Map<string, { at: number; spot: number }>();
  for (const l of legs) {
    const at = l.quotedAt ?? l.addedAt;
    const cur = ref.get(l.ticker);
    if (!cur || at > cur.at) ref.set(l.ticker, { at, spot: l.spot });
  }
  return legs.map((l) => (ref.get(l.ticker)!.spot === l.spot ? l : { ...l, spot: ref.get(l.ticker)!.spot }));
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

// ── Chance of profit (Monte Carlo, one-factor) ─────────────────────────────────
/** mulberry32 — seeded so the number doesn't flicker between renders. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface PopResult { pop: number; ev: number; paths: number; horizonDays: number }

/**
 * P(total P&L > 0) at the first expiry. Each name: ln return = β·σm·√T·Zm + σe·√T·Zi − ½σ²T (zero drift),
 * σ = mean IV of its option legs (stock-only name → |β|·σm), σe² = max(0, σ² − β²σm²). Shared factor ⇒ names
 * move together by beta; the rest is their own noise. Not a forecast: options-implied spread, no drift.
 */
export function popMonteCarlo(
  legs: TicketLeg[], betas: Record<string, number>, marketVol: number, nowMs = Date.now(), paths = 4000, seed = 7,
): PopResult | null {
  const L = pricedLegs(legs);
  const exp = firstExpiryMs(L);
  if (!L.length || exp == null || exp <= nowMs) return null;
  const T = (exp - nowMs) / (365 * DAY_MS);
  const names = tickersOf(L).map((t) => {
    const ivs = L.filter((l) => l.ticker === t && l.kind !== "stock" && (l.iv ?? 0) > 0).map((l) => l.iv!);
    const beta = betas[t] ?? 1;
    const sigma = ivs.length ? ivs.reduce((s, x) => s + x, 0) / ivs.length : Math.abs(beta) * marketVol;
    const sysV = Math.min((beta * marketVol) ** 2, sigma * sigma);
    return {
      t, sigma, spot: L.find((l) => l.ticker === t)!.spot,
      sigSys: Math.sqrt(sysV) * (beta < 0 ? -1 : 1), sigE: Math.sqrt(sigma * sigma - sysV),
    };
  });
  const r = rng(seed);
  const sq = Math.sqrt(T);
  let wins = 0, sum = 0;
  const S: Record<string, number> = {};
  for (let p = 0; p < paths; p++) {
    const zm = gauss(r);
    for (const n of names) {
      S[n.t] = n.spot * Math.exp(n.sigSys * sq * zm + n.sigE * sq * gauss(r) - 0.5 * n.sigma * n.sigma * T);
    }
    let pnl = 0;
    for (const l of L) pnl += legPnl(l, S[l.ticker], exp);
    if (pnl > 0) wins++;
    sum += pnl;
  }
  return { pop: wins / paths, ev: sum / paths, paths, horizonDays: T * 365 };
}

// ── Robinhood order text ───────────────────────────────────────────────────────
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const RH_MAX_LEGS = 4;

export interface OrderTicket {
  ticker: string;
  kind: "options" | "stock";
  /** Number of spreads (or shares). */
  quantity: number;
  /** Per spread, per share: debit > 0, credit < 0. */
  limit: number;
  lines: string[];
}

/** One order per name; shares separate (RH won't combine shares + options); ≤ 4 option legs per order. */
export function orderTickets(legs: TicketLeg[]): OrderTicket[] {
  const out: OrderTicket[] = [];
  for (const t of tickersOf(legs)) {
    const mine = legs.filter((l) => l.ticker === t);
    const stock = mine.filter((l) => l.kind === "stock");
    const net = stock.reduce((s, l) => s + sign(l) * l.qty, 0);
    if (net !== 0) {
      const px = stock[stock.length - 1].price;
      out.push({ ticker: t, kind: "stock", quantity: Math.abs(net), limit: px,
        lines: [`${net > 0 ? "Buy" : "Sell"} ${Math.abs(net)} ${t} shares · limit $${px.toFixed(2)}`] });
    }
    const opts = mine.filter((l) => l.kind !== "stock");
    for (let i = 0; i < opts.length; i += RH_MAX_LEGS) {
      const chunk = opts.slice(i, i + RH_MAX_LEGS);
      const g = chunk.reduce((a, l) => gcd(a, l.qty), 0) || 1;
      const limit = chunk.reduce((s, l) => s + sign(l) * l.price * (l.qty / g), 0);
      out.push({
        ticker: t, kind: "options", quantity: g, limit,
        lines: chunk.map((l) => `${l.side === "long" ? "Buy" : "Sell"} ${l.qty / g > 1 ? `${l.qty / g}× ` : ""}${t} ${l.expiry} $${l.strike} ${l.kind === "call" ? "Call" : "Put"} @ $${l.price.toFixed(2)}`),
      });
    }
  }
  return out;
}

export function orderText(o: OrderTicket): string {
  if (o.kind === "stock") return o.lines.join("\n");
  const head = `${o.ticker} · ${o.quantity}× · limit $${Math.abs(o.limit).toFixed(2)} ${o.limit >= 0 ? "debit" : "credit"}`;
  return [head, ...o.lines.map((l) => `  ${l}`)].join("\n");
}
