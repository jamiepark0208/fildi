/**
 * A192 Part L — any mix of stock + option legs: contract fills, payoff, risk metrics.
 */
import type { OptionRow, OptionsChainResult } from "../options.js";
import { bsGreeks, normCDF } from "../options-greeks.js";

export const OPTION_MULT = 100;
export const FILL_SPREAD_FRAC = 0.23;
export const DEFAULT_RISK_FREE = 0.045;

export type LegKind = "stock" | "call" | "put";
export type LegSide = "long" | "short";

export interface Leg {
  kind: LegKind;
  side: LegSide;
  qty: number;
  strike?: number;
  expiry?: string;
}

export interface LegFill {
  leg: Leg;
  fill: number;
  mid: number;
  iv: number | null;
}

export interface ChainContext {
  spot: number;
  chains: OptionsChainResult[];
  riskFree?: number;
  asOf?: number;
}

export function bsOptionPrice(
  kind: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0 || S <= 0) {
    return kind === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);
  return kind === "call"
    ? S * normCDF(d1) - K * df * normCDF(d2)
    : K * df * normCDF(-d2) - S * normCDF(-d1);
}

function contractFill(row: OptionRow, side: LegSide): { fill: number; mid: number } {
  const px = row.lastPrice > 0 ? row.lastPrice : Math.max(row.bid, row.ask);
  const bid = row.bid > 0 ? row.bid : px;
  const ask = row.ask > 0 ? row.ask : px;
  const mid = (bid + ask) / 2;
  const spread = Math.max(ask - bid, 0);
  const fill =
    side === "short" ? bid + FILL_SPREAD_FRAC * spread : ask - FILL_SPREAD_FRAC * spread;
  return { fill, mid };
}

function stockFill(spot: number, side: LegSide): { fill: number; mid: number } {
  const bid = spot * 0.9995;
  const ask = spot;
  const mid = spot;
  return { fill: side === "long" ? ask : bid, mid };
}

export function findChain(chains: OptionsChainResult[], expiry: string): OptionsChainResult | null {
  return chains.find((c) => c.expiry === expiry) ?? null;
}

/** Nearest expiry to target; only expiries with DTE ≥ target − 7 (A192 review 29a95eb9). */
export function pickExpiry(chains: OptionsChainResult[], targetDte: number): OptionsChainResult | null {
  const minDte = Math.max(0, targetDte - 7);
  const eligible = chains.filter((c) => c.daysToExpiry >= minDte);
  const pool = eligible.length ? eligible : chains;
  if (!pool.length) return null;
  let best = pool[0];
  let bestDiff = Math.abs(best.daysToExpiry - targetDte);
  for (const c of pool) {
    const d = Math.abs(c.daysToExpiry - targetDte);
    if (d < bestDiff) {
      best = c;
      bestDiff = d;
    }
  }
  return best;
}

function findStrikeRow(chain: OptionsChainResult, kind: LegKind, strike: number): OptionRow | null {
  const rows = kind === "call" ? chain.calls : chain.puts;
  return rows.find((r) => Math.abs(r.strike - strike) < 1e-6) ?? null;
}

function yearsToExpiry(expiry: string, asOfMs = Date.now()): number {
  const end = new Date(`${expiry}T16:00:00`).getTime();
  return Math.max((end - asOfMs) / (365 * 24 * 3600 * 1000), 0);
}

export function priceLegs(legs: Leg[], ctx: ChainContext): { fills: LegFill[]; netFill: number; netMid: number } {
  const fills: LegFill[] = [];
  let netFill = 0;
  let netMid = 0;
  for (const leg of legs) {
    if (leg.kind === "stock") {
      const { fill, mid } = stockFill(ctx.spot, leg.side);
      const cash = fill * leg.qty * (leg.side === "long" ? -1 : 1);
      const cashMid = mid * leg.qty * (leg.side === "long" ? -1 : 1);
      netFill += cash;
      netMid += cashMid;
      fills.push({ leg, fill, mid, iv: null });
      continue;
    }
    const chain = leg.expiry ? findChain(ctx.chains, leg.expiry) : pickExpiry(ctx.chains, 30);
    if (!chain || leg.strike == null) {
      fills.push({ leg, fill: 0, mid: 0, iv: null });
      continue;
    }
    const row = findStrikeRow(chain, leg.kind, leg.strike);
    if (!row) {
      fills.push({ leg, fill: 0, mid: 0, iv: null });
      continue;
    }
    const { fill, mid } = contractFill(row, leg.side);
    const mult = OPTION_MULT * leg.qty;
    const sign = leg.side === "short" ? 1 : -1;
    netFill += sign * fill * mult;
    netMid += sign * mid * mult;
    fills.push({ leg, fill, mid, iv: row.iv > 0 ? row.iv : null });
  }
  return { fills, netFill, netMid };
}

function legIntrinsic(leg: Leg, S: number): number {
  if (leg.kind === "stock") {
    const sign = leg.side === "long" ? 1 : -1;
    return sign * leg.qty * S;
  }
  if (leg.strike == null) return 0;
  const intrinsic =
    leg.kind === "call" ? Math.max(S - leg.strike, 0) : Math.max(leg.strike - S, 0);
  const sign = leg.side === "long" ? 1 : -1;
  return sign * intrinsic * OPTION_MULT * leg.qty;
}

function legMark(leg: Leg, S: number, ctx: ChainContext, atMs: number): number {
  const r = ctx.riskFree ?? DEFAULT_RISK_FREE;
  if (leg.kind === "stock") {
    const sign = leg.side === "long" ? 1 : -1;
    return sign * leg.qty * S;
  }
  if (leg.strike == null || !leg.expiry) return 0;
  const chain = findChain(ctx.chains, leg.expiry);
  const row = chain ? findStrikeRow(chain, leg.kind, leg.strike) : null;
  const sigma = row && row.iv > 0 ? row.iv : 0.25;
  const T = yearsToExpiry(leg.expiry, atMs);
  const px = bsOptionPrice(leg.kind, S, leg.strike, T, r, sigma);
  const sign = leg.side === "long" ? 1 : -1;
  return sign * px * OPTION_MULT * leg.qty;
}

/** P&L at spot S (netFill = cash at open; positive = credit). */
export function payoffAtSpot(legs: Leg[], ctx: ChainContext, S: number, netFill: number, atExpiry = true): number {
  if (atExpiry) {
    let intrinsic = 0;
    for (const leg of legs) intrinsic += legIntrinsic(leg, S);
    return netFill + intrinsic;
  }
  let marks = 0;
  for (const leg of legs) marks += legMark(leg, S, ctx, Date.now());
  return netFill + marks;
}

export function payoffCurve(
  legs: Leg[],
  ctx: ChainContext,
  netFill: number,
  lo?: number,
  hi?: number,
  n = 80,
): { spot: number; pnl: number }[] {
  const spot = ctx.spot;
  const low = lo ?? spot * 0.75;
  const high = hi ?? spot * 1.25;
  const out: { spot: number; pnl: number }[] = [];
  for (let i = 0; i < n; i++) {
    const S = low + ((high - low) * i) / (n - 1);
    out.push({ spot: S, pnl: payoffAtSpot(legs, ctx, S, netFill, true) });
  }
  return out;
}

function expiryPayoffSlopeAtInfinity(legs: Leg[]): number {
  let slope = 0;
  for (const leg of legs) {
    if (leg.kind === "stock") {
      slope += leg.side === "long" ? leg.qty : -leg.qty;
      continue;
    }
    if (leg.kind === "call") {
      const mult = OPTION_MULT * leg.qty;
      slope += leg.side === "long" ? mult : -mult;
    }
  }
  return slope;
}

export function maxLossGain(
  legs: Leg[],
  ctx: ChainContext,
  netFill: number,
): { maxLoss: number; maxGain: number } {
  const slopeInf = expiryPayoffSlopeAtInfinity(legs);
  const spots = new Set<number>([0]);
  for (const leg of legs) {
    if (leg.strike != null) spots.add(leg.strike);
  }
  let minP = payoffAtSpot(legs, ctx, 0, netFill, true);
  let maxP = minP;
  for (const S of spots) {
    if (S === 0) continue;
    const p = payoffAtSpot(legs, ctx, S, netFill, true);
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);
  }
  const UNBOUNDED = 1e15;
  let maxLoss = minP < 0 ? -minP : 0;
  let maxGain = maxP > 0 ? maxP : 0;
  if (slopeInf < 0) maxLoss = UNBOUNDED;
  if (slopeInf > 0) maxGain = UNBOUNDED;
  return { maxLoss, maxGain };
}

export function breakevens(legs: Leg[], ctx: ChainContext, netFill: number): number[] {
  const curve = payoffCurve(legs, ctx, netFill, ctx.spot * 0.5, ctx.spot * 1.5, 200);
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if ((a.pnl <= 0 && b.pnl >= 0) || (a.pnl >= 0 && b.pnl <= 0)) {
      const t = a.pnl / (a.pnl - b.pnl);
      out.push(a.spot + t * (b.spot - a.spot));
    }
  }
  return out;
}

function legIvAtStrike(ctx: ChainContext, leg: Leg): number {
  if (leg.kind === "stock" || leg.strike == null) return 0.25;
  const chain = leg.expiry ? findChain(ctx.chains, leg.expiry) : ctx.chains[0];
  const row = chain ? findStrikeRow(chain, leg.kind, leg.strike) : null;
  if (row && row.iv > 0) return row.iv;
  const atm = ctx.chains[0];
  const putIv = atm?.puts.find((p) => p.strike <= ctx.spot)?.iv ?? 0.25;
  const callIv = atm?.calls.find((c) => c.strike >= ctx.spot)?.iv ?? putIv;
  return (putIv + callIv) / 2;
}

function blendedHorizonIv(legs: Leg[], ctx: ChainContext): number {
  const ivs = legs
    .filter((l) => l.kind !== "stock")
    .map((l) => legIvAtStrike(ctx, l))
    .filter((v) => v > 0);
  if (!ivs.length) return 0.25;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/** Shortest option-leg DTE (front expiry for calendars/diagonals); stock-only → 30. */
export function popExpiryDays(legs: Leg[], ctx: ChainContext): number {
  const optionLegs = legs.filter((l) => l.kind !== "stock" && l.expiry);
  if (!optionLegs.length) return 30;
  let minDays = Infinity;
  const asOf = ctx.asOf ?? Date.now();
  for (const leg of optionLegs) {
    const chain = findChain(ctx.chains, leg.expiry!);
    const days =
      chain != null
        ? chain.daysToExpiry
        : Math.max(Math.round(yearsToExpiry(leg.expiry!, asOf) * 365), 0);
    if (days < minDays) minDays = days;
  }
  return minDays === Infinity ? 30 : minDays;
}

/** POP at leg expiry: P(payoff > 0) under lognormal S_T (drift r, IV from legs). */
export function popAtHorizon(
  legs: Leg[],
  ctx: ChainContext,
  netFill: number,
  horizonDays: number,
): number {
  const spot = ctx.spot;
  const sigma = blendedHorizonIv(legs, ctx);
  const expiryDays = popExpiryDays(legs, ctx);
  const T = expiryDays / 365;
  const r = ctx.riskFree ?? DEFAULT_RISK_FREE;
  if (T <= 0) {
    return payoffAtSpot(legs, ctx, spot, netFill, true) > 0 ? 1 : 0;
  }
  const bes = breakevens(legs, ctx, netFill);
  if (bes.length === 1) {
    const BE = bes[0];
    const sqrtT = Math.sqrt(T);
    const d =
      (Math.log(BE / spot) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const stockHeavy = legs.some((l) => l.kind === "stock" && l.side === "long");
    if (stockHeavy && legs.some((l) => l.kind === "call" && l.side === "short")) {
      return 1 - normCDF(d); // P(S_T > BE): covered call profits above breakeven
    }
  }
  let w = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const z = rationalApproxInvNorm(u);
    const ST = spot * Math.exp((r - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z);
    if (payoffAtSpot(legs, ctx, ST, netFill, true) > 0) w++;
  }
  return w / n;
}

/** Acklam inverse normal approximation */
function rationalApproxInvNorm(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411952e-1, -2.400758277161838e0, -2.549732539343734e0,
    4.374664567504938e0, 2.938163982698852e0,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function buyingPower(legs: Leg[], ctx: ChainContext, priced: ReturnType<typeof priceLegs>): number {
  let bp = 0;
  const spot = ctx.spot;
  for (const { leg, fill } of priced.fills) {
    if (leg.kind === "stock" && leg.side === "long") bp += spot * leg.qty;
    if (leg.kind === "stock" && leg.side === "short") bp += spot * leg.qty * 0.5;
    if (leg.kind === "put" && leg.side === "short" && leg.strike != null) {
      bp = Math.max(bp, leg.strike * OPTION_MULT * leg.qty - fill * OPTION_MULT * leg.qty);
    }
  }
  const shorts = legs.filter((l) => l.kind !== "stock" && l.side === "short");
  const longs = legs.filter((l) => l.kind !== "stock" && l.side === "long");
  if (shorts.length && longs.length) {
    const strikes = [...shorts, ...longs].map((l) => l.strike ?? 0);
    const width = (Math.max(...strikes) - Math.min(...strikes)) * OPTION_MULT;
    bp = Math.max(bp, width - Math.max(priced.netFill, 0));
  }
  if (bp <= 0) {
    bp = Math.abs(priced.netFill) + spot * 0.1;
  }
  return bp;
}

export function netGreeks(legs: Leg[], ctx: ChainContext): { delta: number; gamma: number; theta: number } {
  const r = ctx.riskFree ?? DEFAULT_RISK_FREE;
  const S = ctx.spot;
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  for (const leg of legs) {
    if (leg.kind === "stock") {
      const sign = leg.side === "long" ? 1 : -1;
      delta += sign * leg.qty;
      continue;
    }
    if (leg.strike == null || !leg.expiry) continue;
    const chain = findChain(ctx.chains, leg.expiry);
    const row = chain ? findStrikeRow(chain, leg.kind, leg.strike) : null;
    const sigma = row && row.iv > 0 ? row.iv : 0.25;
    const T = yearsToExpiry(leg.expiry);
    const g = bsGreeks(S, leg.strike, T, r, sigma, leg.kind === "call");
    const sign = leg.side === "long" ? 1 : -1;
    const mult = OPTION_MULT * leg.qty * sign;
    delta += g.delta * mult;
    gamma += g.gamma * mult;
    theta += g.theta * mult;
  }
  return { delta, gamma, theta };
}

export interface PricedStructure {
  fills: LegFill[];
  netFill: number;
  netMid: number;
  maxLoss: number;
  maxGain: number;
  breakevens: number[];
  pop: number;
  buyingPower: number;
  greeks: { delta: number; gamma: number; theta: number };
  payoff: { spot: number; pnl: number }[];
}

export function priceStructure(legs: Leg[], ctx: ChainContext, horizonDays = 30): PricedStructure {
  const priced = priceLegs(legs, ctx);
  const { maxLoss, maxGain } = maxLossGain(legs, ctx, priced.netFill);
  return {
    ...priced,
    maxLoss,
    maxGain,
    breakevens: breakevens(legs, ctx, priced.netFill),
    pop: popAtHorizon(legs, ctx, priced.netFill, popExpiryDays(legs, ctx)),
    buyingPower: buyingPower(legs, ctx, priced),
    greeks: netGreeks(legs, ctx),
    payoff: payoffCurve(legs, ctx, priced.netFill),
  };
}

/** Put-call parity check on synthetic mids */
export function putCallParityError(S: number, K: number, T: number, r: number, sigma: number): number {
  const c = bsOptionPrice("call", S, K, T, r, sigma);
  const p = bsOptionPrice("put", S, K, T, r, sigma);
  return c - p - (S - K * Math.exp(-r * T));
}
