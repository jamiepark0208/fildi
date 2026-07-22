import YahooFinanceClass from "yahoo-finance2";
import { getTier } from "./constants.js";
import { TTLCache } from "./ttl-cache.js";

const yahooFinance = new YahooFinanceClass();

// ── Types ────────────────────────────────────────────────────────────────────

export interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  incomePct: number;
  meetsGate: boolean;
  bidIsLive: boolean;
  delta: number | null;
  spreadPct: number | null;
}

export interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  exactDte: number;
  settlementDte: number;
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
  openInterest?: number;
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

// ── Options scanner constants ─────────────────────────────────────────────────
const FLAT_MIN_OTM   = 0.03;  // 3% — minimum OTM distance (replaces tier bands)
const FLAT_MAX_OTM   = 0.25;  // 25% — maximum OTM distance (widened from 15% so high-IV names'
                               // income-target-optimal strikes aren't cut off before scoring)
const RISK_FREE_RATE = 0.045; // ~current T-bill rate

// ── Shared expiry date cache (24h TTL — expiry calendars change rarely) ───────
export const expiryCache = new TTLCache<Date[]>(24 * 60 * 60 * 1000, 'options-expiry', 1000); // key = ticker

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
  const r = RISK_FREE_RATE;

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

function exactDaysUntil(d: unknown): number {
  const ms = (d instanceof Date ? d.getTime() : 0) - Date.now();
  return ms / 86_400_000;
}

function isWeeklyExpiry(d: unknown): boolean {
  return d instanceof Date && d.getDay() === 5; // Friday
}

// Options settle T+1 business day after expiration — a put you sell against a Friday
// expiry doesn't return your capital until Monday. weeklyIncome (return per week of
// capital tied up) needs the settlement date, not the bare expiration date; option
// pricing (Greeks, theta/buffer) must keep using the real expiration date instead.
function settlementOffsetDays(expiryDate: Date): number {
  const day = expiryDate.getDay(); // 0=Sun .. 6=Sat
  if (day === 5) return 3; // Fri -> Mon
  if (day === 6) return 2; // Sat (shouldn't occur) -> Mon
  if (day === 0) return 1; // Sun (shouldn't occur) -> Mon
  return 1; // Mon-Thu -> next day
}

// daysToExpiry/exactDte/settlementDte are pure clock math (expiry date vs. now) — they
// don't need Yahoo data and shouldn't go stale just because the surrounding bid/ask/iv
// blob is cache-hit. Recompute them at serve time (whether the chain came from cache or
// a fresh fetch) so they're never more than a few ms old, no matter the cache TTL.
export function withFreshDte(chains: OptionsChainResult[]): OptionsChainResult[] {
  return chains.map(c => {
    const expiryDate = new Date(c.expiry + "T16:00:00");
    const exactDte    = Math.max(0.5, exactDaysUntil(expiryDate));
    return {
      ...c,
      daysToExpiry: daysUntil(expiryDate),
      exactDte,
      settlementDte: exactDte + settlementOffsetDays(expiryDate),
    };
  });
}

function buildRows(
  puts: RawContract[],
  spot: number,
  exactDte: number,
): OptionRow[] {
  const lo = spot * (1 - FLAT_MAX_OTM);
  const hi = spot * (1 - FLAT_MIN_OTM);
  const T  = exactDte / 365;

  const rows = puts
    .filter(p => typeof p.strike === "number" && p.strike >= lo && p.strike <= hi)
    .map(p => {
      const strike       = p.strike!;
      const bid          = p.bid              ?? 0;
      const ask          = p.ask              ?? 0;
      const lastPrice    = p.lastPrice        ?? 0;
      const iv           = p.impliedVolatility ?? 0;
      const volume       = typeof p.volume === "number" ? p.volume : null;
      const openInterest = typeof p.openInterest === "number" ? p.openInterest : null;
      // When market is closed, Yahoo returns bid=0; fall back to lastPrice so the scanner
      // can still show indicative income estimates outside of market hours.
      const priceForIncome = bid > 0 ? bid : lastPrice;
      const incomePct    = priceForIncome > 0 ? (priceForIncome / strike) * 100 : 0;
      const mid          = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
      const spreadPct    = mid !== null && mid > 0 ? parseFloat(((ask - bid) / mid).toFixed(4)) : null;

      let delta: number | null = null;
      if (iv > 0 && spot > 0 && T > 0) {
        const g = bsGreeks(spot, strike, T, RISK_FREE_RATE, iv, false);
        delta = parseFloat(g.delta.toFixed(4));
      }

      return {
        strike, bid, ask, lastPrice, iv, volume, openInterest,
        incomePct: Math.round(incomePct * 1000) / 1000,
        meetsGate: priceForIncome > 0,
        bidIsLive: bid > 0,
        delta,
        spreadPct,
      };
    });

  // Yahoo Finance returns duplicate strikes for mini/adjusted contracts — keep highest bid per strike
  const byStrike = new Map<number, typeof rows[0]>();
  for (const row of rows) {
    const existing = byStrike.get(row.strike);
    if (!existing || row.bid > existing.bid) byStrike.set(row.strike, row);
  }

  return Array.from(byStrike.values()).sort((a, b) => b.strike - a.strike);
}

async function fetchChain(ticker: string, date?: Date): Promise<RawOptionsResponse> {
  const opts = date ? { date } : {};
  return yahooFinance.options(
    ticker,
    opts as Parameters<typeof yahooFinance.options>[1],
    { validateResult: false },
  ) as Promise<RawOptionsResponse>;
}

// ── Public API ────────────────────────────────────────────────────────────────
// Returns up to 2 expiry chains: nearest 1wk + nearest 2wk (both 1-28 DTE).

export async function getOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  const key  = ticker.toUpperCase();
  const tier = getTier(key);

  // Use cached expiry dates if available; skip the undated initial call entirely
  const cachedDates = expiryCache.get(key);
  let raw0: RawOptionsResponse | null = null;
  let targets: Date[];

  if (cachedDates) {
    // exactDaysUntil (real elapsed time), not daysUntil (calendar-day ceil) — the ceil'd
    // version still counts an expiry a few hours away (e.g. tomorrow morning, checked
    // after-hours tonight) as "1 day out", letting a near-expired contract through. That
    // contract's near-zero real DTE then collapses BS delta to ~0 for nearly every OTM
    // strike (false ~100% POP) and inflates weeklyIncome by annualizing over almost no time.
    targets = cachedDates.filter(d => exactDaysUntil(d) >= 1 && exactDaysUntil(d) <= 28).slice(0, 2);
    if (targets.length === 0) throw new Error(`No viable expiry dates for ${key}`);
  } else {
    // Cache miss — initial undated fetch to discover expiry calendar
    raw0 = await fetchChain(key);
    const allDates = (raw0.expirationDates ?? []).filter((d): d is Date => d instanceof Date);
    expiryCache.set(key, allDates);
    targets = allDates.filter(d => exactDaysUntil(d) >= 1 && exactDaysUntil(d) <= 28).slice(0, 2);
    if (targets.length === 0) throw new Error(`No viable expiry dates for ${key}`);
  }

  // Fetch spot price — reuse raw0 if available, otherwise fetch first target
  if (!raw0) raw0 = await fetchChain(key, targets[0]);
  const spot = raw0.quote?.regularMarketPrice;
  if (!spot) throw new Error(`No spot price for ${key}`);

  // The first raw fetch already contains puts for its expiry — reuse if DTE matches target[0]
  const firstRawDte = daysUntil(raw0.options?.[0]?.expirationDate);

  function buildResult(raw: RawOptionsResponse, fallbackDate: Date): OptionsChainResult {
    const expiryDate = (raw.options?.[0]?.expirationDate ?? fallbackDate) as Date;
    const dte        = daysUntil(expiryDate);
    const exactDte   = Math.max(0.5, exactDaysUntil(expiryDate));
    const settlementDte = exactDte + settlementOffsetDays(expiryDate);
    return {
      ticker: key,
      expiry:        toDateStr(expiryDate),
      isWeekly:      isWeeklyExpiry(expiryDate),
      daysToExpiry:  dte,
      exactDte,
      settlementDte,
      spot: spot as number,
      tier,
      puts:      buildRows(raw.options?.[0]?.puts ?? [], spot as number, exactDte),
      fetchedAt: Date.now(),
    };
  }

  const results: OptionsChainResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    const date     = targets[i];
    const canReuse = i === 0 && Math.abs(daysUntil(date) - firstRawDte) <= 1;
    const raw      = canReuse ? raw0 : await fetchChain(key, date);
    results.push(buildResult(raw, date));
  }
  return results;
}
