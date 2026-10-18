import { yahooFinance } from "./yahoo-client.js";
import { getTier } from "./constants.js";
import { TTLCache } from "./ttl-cache.js";
import { isPlausibleOptionQuote } from "@workspace/option-scoring";
import { getSchwabOptionChains } from "./schwab-client.js";
import { logger } from "./logger.js";
import { recordOptionsChainSource } from "./options-chain-source-stats.js";
import { daysUntilCeil, exactDaysUntil, settlementOffsetDays } from "./date-util.js";


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
  /** True when Yahoo bid is 0 / missing — not used for income or meetsGate. */
  quoteStale: boolean;
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
  calls: OptionRow[];
  fetchedAt: number;
  /** Provenance — schwab preferred; yahoo fallback. */
  source?: "schwab" | "yahoo";
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
const MONTHLY_TARGET_DTE   = 37;  // ~30-45D covered-call convention for the calls-only 3rd chain
const MONTHLY_MAX_DIFF_RATIO = 0.6; // same nearest-match sanity cutoff as getIvTermStructure

// ── Shared expiry date cache (24h TTL — expiry calendars change rarely) ───────
export const expiryCache = new TTLCache<Date[]>(24 * 60 * 60 * 1000, 'options-expiry', 1000); // key = ticker

// ── Black-Scholes Greeks ──────────────────────────────────────────────────────

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz–Stegun). Exported for Greeks unit + Python cross-tests (A83). */
export function normCDF(x: number): number {
  const t   = 1 / (1 + 0.2316419 * Math.abs(x));
  const d   = 0.3989422820 * Math.exp(-x * x / 2);
  const p   = d * t * (0.3193815310 + t * (-0.3565638140 + t * (1.7814779370 + t * (-1.8212559780 + t * 1.3302744290))));
  return x > 0 ? 1 - p : p;
}

/** Black–Scholes delta/gamma/theta (theta per calendar day). Exported for unit tests (A83). */
export function bsGreeks(
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

/** Alias — options path uses ceil (may be negative). */
const daysUntil = daysUntilCeil;

function isWeeklyExpiry(d: unknown): boolean {
  return d instanceof Date && d.getDay() === 5; // Friday
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
  contracts: RawContract[],
  spot: number,
  exactDte: number,
  isCall: boolean = false,
): OptionRow[] {
  const lo = isCall ? spot * (1 + FLAT_MIN_OTM) : spot * (1 - FLAT_MAX_OTM);
  const hi = isCall ? spot * (1 + FLAT_MAX_OTM) : spot * (1 - FLAT_MIN_OTM);
  const T  = exactDte / 365;

  const rows = contracts
    .filter(p => typeof p.strike === "number" && p.strike >= lo && p.strike <= hi)
    .map(p => {
      const strike       = p.strike!;
      const bid          = p.bid              ?? 0;
      const ask          = p.ask              ?? 0;
      const lastPrice    = p.lastPrice        ?? 0;
      const iv           = p.impliedVolatility ?? 0;
      const volume       = typeof p.volume === "number" ? p.volume : null;
      const openInterest = typeof p.openInterest === "number" ? p.openInterest : null;
      // Sell-side price MUST be a live bid on THIS contract (put bid for puts, call bid
      // for calls). Never invent from ask, never lastPrice (invents inverted OTM curves).
      const priceForIncome = bid > 0 ? bid : 0;
      const incomePct    = priceForIncome > 0 ? (priceForIncome / strike) * 100 : 0;
      const mid          = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
      const spreadPct    = mid !== null && mid > 0 ? parseFloat(((ask - bid) / mid).toFixed(4)) : null;
      const otmPct = spot > 0
        ? (isCall ? (strike - spot) / spot : (spot - strike) / spot)
        : 0;

      let delta: number | null = null;
      if (iv > 0 && spot > 0 && T > 0) {
        const g = bsGreeks(spot, strike, T, RISK_FREE_RATE, iv, isCall);
        delta = parseFloat(g.delta.toFixed(4));
      }

      const liveBid = bid > 0;
      const plausible = liveBid && isPlausibleOptionQuote(bid, strike, spot, otmPct);

      return {
        strike, bid, ask, lastPrice, iv, volume, openInterest,
        incomePct: Math.round(incomePct * 1000) / 1000,
        meetsGate: plausible,
        bidIsLive: liveBid,
        quoteStale: !liveBid,
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

function pickNearestExpiry(dates: Date[], targetDte: number, maxDiffRatio: number = 0.6): Date | null {
  let best: Date | null = null;
  let bestDiff = Infinity;
  for (const d of dates) {
    const diff = Math.abs(exactDaysUntil(d) - targetDte);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  if (!best || bestDiff > targetDte * maxDiffRatio) return null;
  return best;
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
// Schwab first (1 call / ticker); Yahoo fallback on auth/rate/empty.

export async function getOptionsChain(ticker: string): Promise<OptionsChainResult[]> {
  const key  = ticker.toUpperCase();

  try {
    const schwab = await getSchwabOptionChains(key);
    if (schwab?.length) {
      recordOptionsChainSource("schwab");
      return schwab.map((c) => ({ ...c, source: "schwab" as const }));
    }
  } catch (err) {
    logger.warn({ ticker: key, err: String(err) }, "options: Schwab chain failed — Yahoo fallback");
  }

  return getOptionsChainYahoo(key);
}

async function getOptionsChainYahoo(key: string): Promise<OptionsChainResult[]> {
  const tier = getTier(key);

  // Use cached expiry dates if available; skip the undated initial call entirely
  const cachedDates = expiryCache.get(key);
  let raw0: RawOptionsResponse | null = null;
  let targets: Date[];

  if (cachedDates) {
    // exactDaysUntil (real elapsed time), not daysUntil (calendar-day ceil) — only exclude
    // expiries that have actually passed. Near-zero-DTE contracts still show (you can sell
    // a put right up until expiry); withFreshDte/buildRows floor exactDte at 0.5 days before
    // computing delta/weeklyIncome so those figures don't blow up for same-day expiries.
    targets = cachedDates.filter(d => exactDaysUntil(d) > 0 && exactDaysUntil(d) <= 28).slice(0, 2);
    if (targets.length === 0) throw new Error(`No viable expiry dates for ${key}`);
  } else {
    // Cache miss — initial undated fetch to discover expiry calendar
    raw0 = await fetchChain(key);
    const allDates = (raw0.expirationDates ?? []).filter((d): d is Date => d instanceof Date);
    expiryCache.set(key, allDates);
    targets = allDates.filter(d => exactDaysUntil(d) > 0 && exactDaysUntil(d) <= 28).slice(0, 2);
    if (targets.length === 0) throw new Error(`No viable expiry dates for ${key}`);
  }

  // Fetch spot price — reuse raw0 if available, otherwise fetch first target.
  // Prefer golden-source live quote (A7): Yahoo options.quote.regularMarketPrice
  // often lags a session behind during RTH / right after the open.
  if (!raw0) raw0 = await fetchChain(key, targets[0]);
  let spot = raw0.quote?.regularMarketPrice;
  try {
    const { getLivePrices } = await import("./live-quote.js");
    const livePx = (await getLivePrices([key])).get(key)?.price;
    if (livePx != null && livePx > 0) spot = livePx;
  } catch {
    /* keep Yahoo options quote */
  }
  if (!spot) throw new Error(`No spot price for ${key}`);

  // The first raw fetch already contains puts for its expiry — reuse if DTE matches target[0]
  const firstRawDte = daysUntil(raw0.options?.[0]?.expirationDate);

  function buildResult(raw: RawOptionsResponse, fallbackDate: Date, putsOnly: boolean = false): OptionsChainResult {
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
      puts:      putsOnly ? [] : buildRows(raw.options?.[0]?.puts ?? [], spot as number, exactDte),
      calls:     buildRows(raw.options?.[0]?.calls ?? [], spot as number, exactDte, true),
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

  // 3rd chain: monthly expiry (~30-45 DTE) for calls only — puts stay weekly/2wk-only.
  // Skip entirely if no viable monthly date exists (short calendar) or it collapses onto
  // an already-fetched target (small-cap tickers with few expiries).
  const allDates = cachedDates ?? (raw0.expirationDates ?? []).filter((d): d is Date => d instanceof Date);
  const monthlyDate = pickNearestExpiry(
    allDates.filter(d => exactDaysUntil(d) > 0),
    MONTHLY_TARGET_DTE,
    MONTHLY_MAX_DIFF_RATIO,
  );
  if (monthlyDate) {
    const collidesWithTarget = targets.some(d => Math.abs(daysUntil(d) - daysUntil(monthlyDate)) <= 1);
    if (!collidesWithTarget) {
      const monthlyRaw = await fetchChain(key, monthlyDate);
      results.push(buildResult(monthlyRaw, monthlyDate, true));
    }
  }

  recordOptionsChainSource("yahoo");
  return results.map((c) => ({ ...c, source: "yahoo" as const }));
}

// ── IV term structure (ATM implied vol across the expiry calendar) ────────────
// Ticker-level, not tied to any one strike — the whole point is showing how ATM IV
// changes across time buckets (1W/1M/2M/3M/6M/1Y), e.g. backwardation before earnings.

export interface IvTermPoint {
  label:  string; // "1W" | "1M" | "2M" | "3M" | "6M" | "1Y"
  expiry: string;
  dte:    number;
  iv:     number; // decimal, e.g. 0.32
}

const IV_TERM_BUCKETS: Array<{ label: string; targetDte: number }> = [
  { label: "1W", targetDte: 7 },
  { label: "1M", targetDte: 30 },
  { label: "2M", targetDte: 60 },
  { label: "3M", targetDte: 90 },
  { label: "6M", targetDte: 180 },
  { label: "1Y", targetDte: 365 },
];

export async function getIvTermStructure(ticker: string): Promise<IvTermPoint[]> {
  const key = ticker.toUpperCase();

  const cachedDates = expiryCache.get(key);
  let raw0: RawOptionsResponse | null = null;
  let allDates: Date[];

  if (cachedDates) {
    allDates = cachedDates;
  } else {
    raw0 = await fetchChain(key);
    allDates = (raw0.expirationDates ?? []).filter((d): d is Date => d instanceof Date);
    expiryCache.set(key, allDates);
  }

  const future = allDates.filter(d => exactDaysUntil(d) > 0).sort((a, b) => a.getTime() - b.getTime());
  if (future.length === 0) return [];

  // Nearest available expiry per target bucket; skip a bucket if the closest match is
  // way off target (short-dated chains shouldn't fabricate a fake "1Y" point), and
  // de-dupe expiries picked by more than one bucket (short chains often collapse buckets).
  const picked = new Map<string, { label: string; date: Date }>();
  for (const { label, targetDte } of IV_TERM_BUCKETS) {
    let best: Date | null = null;
    let bestDiff = Infinity;
    for (const d of future) {
      const diff = Math.abs(exactDaysUntil(d) - targetDte);
      if (diff < bestDiff) { bestDiff = diff; best = d; }
    }
    if (!best || bestDiff > targetDte * 0.6) continue;
    const dateKey = toDateStr(best);
    if (!picked.has(dateKey)) picked.set(dateKey, { label, date: best });
  }
  if (picked.size === 0) return [];

  if (!raw0) raw0 = await fetchChain(key, [...picked.values()][0].date);
  const spot = raw0.quote?.regularMarketPrice;
  if (!spot) return [];

  const firstRawDte = daysUntil(raw0.options?.[0]?.expirationDate);

  const results: IvTermPoint[] = [];
  for (const { label, date } of picked.values()) {
    const canReuse = Math.abs(daysUntil(date) - firstRawDte) <= 1 && (raw0.options?.[0]?.puts?.length ?? 0) > 0;
    const raw      = canReuse ? raw0 : await fetchChain(key, date);
    const contracts = [...(raw.options?.[0]?.puts ?? []), ...(raw.options?.[0]?.calls ?? [])]
      .filter((c): c is RawContract & { strike: number; impliedVolatility: number } =>
        typeof c.strike === "number" && typeof c.impliedVolatility === "number" && c.impliedVolatility > 0);
    if (contracts.length === 0) continue;

    let atm = contracts[0];
    let bestDiff = Math.abs(atm.strike - (spot as number));
    for (const c of contracts) {
      const diff = Math.abs(c.strike - (spot as number));
      if (diff < bestDiff) { bestDiff = diff; atm = c; }
    }

    results.push({ label, expiry: toDateStr(date), dte: Math.round(exactDaysUntil(date)), iv: atm.impliedVolatility });
  }

  return results.sort((a, b) => a.dte - b.dte);
}
