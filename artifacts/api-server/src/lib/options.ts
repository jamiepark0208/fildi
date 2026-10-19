import { yahooFinance } from "./yahoo-client.js";
import { getTier } from "./constants.js";
import { TTLCache } from "./ttl-cache.js";
import { isPlausibleOptionQuote } from "@workspace/option-scoring";
import { getSchwabOptionChains } from "./schwab-client.js";
import { logger } from "./logger.js";
import { recordOptionsChainSource } from "./options-chain-source-stats.js";
import { bsGreeks } from "./options-greeks.js";
export { bsGreeks, normCDF } from "./options-greeks.js";
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
export interface RawContract {
  strike?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
  volume?: number;
  openInterest?: number;
}

export interface RawOptionsResponse {
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

// ── Option position quote → options-position-quote.ts (A83) ──────────────────
export {
  getOptionPositionQuote,
  type OptionPositionQuoteResult,
} from "./options-position-quote.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toDateStr(d: unknown): string {
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

export async function fetchChain(ticker: string, date?: Date): Promise<RawOptionsResponse> {
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

export { getIvTermStructure, type IvTermPoint } from "./options-iv-term.js";
