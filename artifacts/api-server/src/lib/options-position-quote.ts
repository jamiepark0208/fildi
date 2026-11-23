/**
 * A83 — single-contract option quote + BS greeks (from options.ts).
 */
import { bsGreeks } from "./options-greeks.js";
import { fetchChain, type RawContract } from "./options.js";

const RISK_FREE_RATE = 0.045;

export interface OptionPositionQuoteResult {
  ticker: string;
  strike: number;
  expiry: string;
  optionType: "call" | "put";
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  midPrice: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
}

export async function getOptionPositionQuote(
  ticker: string,
  expiry: string,
  strike: number,
  optionType: "call" | "put",
): Promise<OptionPositionQuoteResult> {
  // Yahoo keys expirations at 00:00 UTC; local "T16:00:00" (23:00Z / 00:00Z next day) matched nothing → 0 contracts (10-21)
  const date = new Date(expiry + "T00:00:00Z");
  const raw = await fetchChain(ticker.toUpperCase(), date);
  const spot = raw.quote?.regularMarketPrice ?? 0;

  const contracts: RawContract[] = optionType === "call"
    ? (raw.options?.[0]?.calls ?? [])
    : (raw.options?.[0]?.puts ?? []);

  const contract = contracts.reduce<RawContract | null>((best, c) => {
    if (typeof c.strike !== "number") return best;
    if (!best || Math.abs(c.strike - strike) < Math.abs((best.strike ?? 0) - strike)) return c;
    return best;
  }, null);

  const bid = contract?.bid ?? null;
  const ask = contract?.ask ?? null;
  const lastPrice = contract?.lastPrice ?? null;
  const iv = contract?.impliedVolatility ?? null;
  const midPrice = bid != null && ask != null ? (bid + ask) / 2 : lastPrice;

  return buildPositionQuote(ticker, expiry, strike, optionType, { bid, ask, lastPrice, midPrice, iv, spot });
}

/** Shared shape + BS greeks — Yahoo path above and the stored/Schwab chain fallback (11-23: Yahoo 'fetch failed' → Portfolio 500s). */
export function buildPositionQuote(
  ticker: string, expiry: string, strike: number, optionType: "call" | "put",
  q: { bid: number | null; ask: number | null; lastPrice: number | null; midPrice: number | null; iv: number | null; spot: number },
): OptionPositionQuoteResult {
  const { bid, ask, lastPrice, midPrice, iv, spot } = q;
  const T = (new Date(expiry + "T00:00:00Z").getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
  let delta: number | null = null;
  let gamma: number | null = null;
  let theta: number | null = null;
  if (iv && iv > 0 && spot > 0 && T > 0) {
    const g = bsGreeks(spot, strike, T, RISK_FREE_RATE, iv, optionType === "call");
    delta = parseFloat(g.delta.toFixed(4));
    gamma = parseFloat(g.gamma.toFixed(5));
    theta = parseFloat(g.theta.toFixed(4));
  }
  const r3 = (v: number | null) => (v != null ? parseFloat(v.toFixed(3)) : null);
  return {
    ticker, strike, expiry, optionType,
    bid: r3(bid), ask: r3(ask), lastPrice: r3(lastPrice), midPrice: r3(midPrice),
    impliedVolatility: iv != null ? parseFloat(iv.toFixed(4)) : null,
    delta, gamma, theta,
  };
}
