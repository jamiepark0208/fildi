import YahooFinanceClass from "yahoo-finance2";
import { getTier, TIER_CONFIG } from "./constants.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  incomePct: number;
  meetsGate: boolean;
}

export interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  spot: number;
  tier: 1 | 2 | 3;
  puts: OptionRow[];
  fetchedAt: number;
}

// Raw shape we read from yf2 (validateResult: false)
interface RawContract {
  strike?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
  volume?: number;
}

interface RawOptionsResponse {
  expirationDates?: unknown[];
  quote?: { regularMarketPrice?: number };
  options?: Array<{
    expirationDate?: unknown;
    puts?: RawContract[];
    calls?: RawContract[];
  }>;
}

// ── Black-Scholes Greeks ──────────────────────────────────────────────────────

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCDF(x: number): number {
  const t   = 1 / (1 + 0.2316419 * Math.abs(x));
  const d   = 0.3989422820 * Math.exp(-x * x / 2);
  const p   = d * t * (0.3193815310 + t * (-0.3565638140 + t * (1.7814779370 + t * (-1.8212559780 + t * 1.3302744290))));
  return x > 0 ? 1 - p : p;
}

function bsGreeks(
  S: number, K: number, T: number, r: number, sigma: number, isCall: boolean
): { delta: number; gamma: number; theta: number } {
  if (T <= 0 || sigma <= 0 || S <= 0) {
    return { delta: 0, gamma: 0, theta: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1    = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2    = d1 - sigma * sqrtT;
  const nd1   = normPDF(d1);

  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = nd1 / (S * sigma * sqrtT);
  const thetaAnnual = isCall
    ? (-S * nd1 * sigma / (2 * sqrtT)) - r * K * Math.exp(-r * T) * normCDF(d2)
    : (-S * nd1 * sigma / (2 * sqrtT)) + r * K * Math.exp(-r * T) * normCDF(-d2);

  return { delta, gamma, theta: thetaAnnual / 365 };
}

// ── Option position quote ─────────────────────────────────────────────────────

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
  const date = new Date(expiry + "T16:00:00");
  const raw  = await fetchChain(ticker.toUpperCase(), date);
  const spot = raw.quote?.regularMarketPrice ?? 0;

  const contracts: RawContract[] = optionType === "call"
    ? (raw.options?.[0]?.calls ?? [])
    : (raw.options?.[0]?.puts  ?? []);

  // Find closest strike to requested
  const contract = contracts.reduce<RawContract | null>((best, c) => {
    if (typeof c.strike !== "number") return best;
    if (!best || Math.abs(c.strike - strike) < Math.abs((best.strike ?? 0) - strike)) return c;
    return best;
  }, null);

  const bid       = contract?.bid       ?? null;
  const ask       = contract?.ask       ?? null;
  const lastPrice = contract?.lastPrice ?? null;
  const iv        = contract?.impliedVolatility ?? null;
  const midPrice  = bid != null && ask != null ? (bid + ask) / 2 : lastPrice;

  // Time to expiry in years
  const T = (date.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
  const r = 0.045;

  let delta: number | null = null;
  let gamma: number | null = null;
  let theta: number | null = null;

  if (iv && iv > 0 && spot > 0 && T > 0) {
    const g = bsGreeks(spot, strike, T, r, iv, optionType === "call");
    delta = parseFloat(g.delta.toFixed(4));
    gamma = parseFloat(g.gamma.toFixed(5));
    theta = parseFloat(g.theta.toFixed(4));
  }

  return {
    ticker,
    strike,
    expiry,
    optionType,
    bid:               bid       != null ? parseFloat(bid.toFixed(3))       : null,
    ask:               ask       != null ? parseFloat(ask.toFixed(3))       : null,
    lastPrice:         lastPrice != null ? parseFloat(lastPrice.toFixed(3)) : null,
    midPrice:          midPrice  != null ? parseFloat(midPrice.toFixed(3))  : null,
    impliedVolatility: iv        != null ? parseFloat(iv.toFixed(4))        : null,
    delta,
    gamma,
    theta,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") return d.slice(0, 10);
  return "";
}

function daysUntil(d: unknown): number {
  const ms = (d instanceof Date ? d.getTime() : 0) - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function isWeeklyExpiry(d: unknown): boolean {
  return d instanceof Date && d.getDay() === 5; // Friday
}

function buildRows(
  puts: RawContract[],
  spot: number,
  minOTM: number,
  maxOTM: number,
  minIncome: number,
): OptionRow[] {
  const lo = spot * (1 - maxOTM);
  const hi = spot * (1 - minOTM);

  return puts
    .filter(p => typeof p.strike === "number" && p.strike >= lo && p.strike <= hi)
    .map(p => {
      const strike    = p.strike!;
      const bid       = p.bid       ?? 0;
      const ask       = p.ask       ?? 0;
      const lastPrice = p.lastPrice ?? 0;
      const iv        = p.impliedVolatility ?? 0;
      const volume    = typeof p.volume === "number" ? p.volume : null;
      const incomePct = bid > 0 ? (bid / strike) * 100 : 0;
      return {
        strike, bid, ask, lastPrice, iv, volume,
        incomePct: Math.round(incomePct * 1000) / 1000,
        meetsGate: incomePct >= minIncome * 100,
      };
    })
    .sort((a, b) => b.strike - a.strike);
}

async function fetchChain(ticker: string, date?: Date): Promise<RawOptionsResponse> {
  const opts = date ? { date } : {};
  return yahooFinance.options(
    ticker,
    opts as Parameters<typeof yahooFinance.options>[1],
    { validateResult: false },
  ) as Promise<RawOptionsResponse>;
}

// ── Public API — no server-side caching, fresh on every click ─────────────────
// Returns up to 2 expiry chains: nearest 1wk + nearest 2wk (both 2-21 DTE).

export async function getOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  const key    = ticker.toUpperCase();
  const tier   = getTier(key);
  const config = TIER_CONFIG[tier];

  // Initial fetch — gets spot price, all expiry dates, and first expiry's puts
  const raw0 = await fetchChain(key);
  const spot  = raw0.quote?.regularMarketPrice;
  if (!spot) throw new Error(`No spot price for ${key}`);

  const allDates = (raw0.expirationDates ?? []).filter((d): d is Date => d instanceof Date);
  // Keep expiries with 2–21 DTE (skip today/tomorrow, cap at ~3 weeks), take first 2
  const targets = allDates.filter(d => daysUntil(d) >= 2 && daysUntil(d) <= 21).slice(0, 2);
  if (targets.length === 0) throw new Error(`No viable expiry dates for ${key}`);

  // The first raw fetch already contains puts for its expiry — reuse if DTE matches target[0]
  const firstRawDte = daysUntil(raw0.options?.[0]?.expirationDate);

  function buildResult(raw: RawOptionsResponse, fallbackDate: Date): OptionsChainResult {
    const expiryDate = raw.options?.[0]?.expirationDate ?? fallbackDate;
    const dte        = daysUntil(expiryDate);
    const weeksOut   = Math.max(1, Math.round(dte / 7));
    return {
      ticker: key,
      expiry:        toDateStr(expiryDate),
      isWeekly:      isWeeklyExpiry(expiryDate),
      daysToExpiry:  dte,
      spot: spot as number,
      tier,
      puts:      buildRows(raw.options?.[0]?.puts ?? [], spot as number, config.minOTM, config.maxOTM, config.minIncome / weeksOut),
      fetchedAt: Date.now(),
    };
  }

  const results: OptionsChainResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    const date       = targets[i];
    const canReuse   = i === 0 && Math.abs(daysUntil(date) - firstRawDte) <= 1;
    const raw        = canReuse ? raw0 : await fetchChain(key, date);
    results.push(buildResult(raw, date));
  }
  return results;
}
