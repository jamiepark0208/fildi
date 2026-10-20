/**
 * Schwab Market Data client (Individual Trader API).
 * Budget: ~100 req/min token bucket (under 120 RPM hard limit).
 *
 * Caching layers (outer → inner):
 *   - routes/options `optionsCache` 30m — primary RPM saver for scanner/UI
 *   - schwabChainCache 5m + getOrCompute — coalesces concurrent cold misses
 *   - livePriceCache 60s — quote golden source (live-quote.ts)
 */
import { isPlausibleOptionQuote } from "@workspace/option-scoring";
import { getTier } from "./constants.js";
import { logger } from "./logger.js";
import {
  getSchwabAccessToken,
  invalidateSchwabAccessToken,
  schwabCredentialsConfigured,
} from "./schwab-auth.js";
import { TTLCache } from "./ttl-cache.js";
import { retryAfterMs } from "./http-client.js";
import {
  daysUntilCeilNonNeg,
  exactDaysUntil,
  settlementOffsetDays,
} from "./date-util.js";
import type { OptionRow, OptionsChainResult } from "./options.js";

const BASE = "https://api.schwabapi.com/marketdata/v1";
const RPM_BUDGET = 100;
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM_BUDGET);
/** Inner cache; outer optionsCache (30m) owns scanner reuse. */
const CHAIN_CACHE_TTL_MS = 5 * 60_000;

export const schwabChainCache = new TTLCache<OptionsChainResult[]>(CHAIN_CACHE_TTL_MS, "schwab-options-chain", 500);

let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

/** Rolling 60s request counter for status / ops. */
const usage = {
  windowStartedAt: Date.now(),
  requestsInWindow: 0,
  totalRequests: 0,
  lastStatus: null as number | null,
  last429At: null as number | null,
  lastPath: null as string | null,
  lastError: null as string | null,
};

function bumpUsage(path: string, status: number | null, err?: string): void {
  const now = Date.now();
  if (now - usage.windowStartedAt >= 60_000) {
    usage.windowStartedAt = now;
    usage.requestsInWindow = 0;
  }
  usage.requestsInWindow++;
  usage.totalRequests++;
  usage.lastPath = path;
  usage.lastStatus = status;
  if (status === 429) usage.last429At = now;
  if (err) usage.lastError = err;
}

export function getSchwabUsageStats(): {
  rpmBudget: number;
  requestsLast60s: number;
  totalRequests: number;
  lastStatus: number | null;
  last429At: string | null;
  lastPath: string | null;
  lastError: string | null;
  chainCache: { entryCount: number; hitRate: string; ttlMs: number };
} {
  const now = Date.now();
  if (now - usage.windowStartedAt >= 60_000) {
    usage.windowStartedAt = now;
    usage.requestsInWindow = 0;
  }
  const stats = schwabChainCache.getStats();
  return {
    rpmBudget: RPM_BUDGET,
    requestsLast60s: usage.requestsInWindow,
    totalRequests: usage.totalRequests,
    lastStatus: usage.lastStatus,
    last429At: usage.last429At ? new Date(usage.last429At).toISOString() : null,
    lastPath: usage.lastPath,
    lastError: usage.lastError,
    chainCache: {
      entryCount: stats.entryCount,
      hitRate: stats.hitRate,
      ttlMs: stats.ttlMs,
    },
  };
}

async function throttle(): Promise<void> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  chain = run.catch(() => undefined);
  await run;
}

async function schwabFetch(url: URL, token: string, retried401 = false, retried429 = false): Promise<Response | null> {
  await throttle();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    bumpUsage(url.pathname, res.status);

    if (res.status === 401 && !retried401) {
      logger.warn({ path: url.pathname }, "schwab: 401 — invalidating access + one retry");
      invalidateSchwabAccessToken();
      const next = await getSchwabAccessToken();
      if (!next) return res;
      return schwabFetch(url, next, true, retried429);
    }
    if (res.status === 429 && !retried429) {
      const wait = retryAfterMs(res);
      logger.warn({ path: url.pathname, wait }, "schwab: 429 — backing off once");
      await new Promise((r) => setTimeout(r, wait));
      return schwabFetch(url, token, retried401, true);
    }
    return res;
  } catch (err) {
    bumpUsage(url.pathname, null, String(err));
    logger.warn({ path: url.pathname, err: String(err) }, "schwab: fetch threw");
    return null;
  }
}

export async function schwabGet<T = unknown>(path: string, query?: Record<string, string>): Promise<T | null> {
  const token = await getSchwabAccessToken();
  if (!token) return null;
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const res = await schwabFetch(url, token);
  if (!res) return null;
  if (res.status === 429) {
    logger.warn({ path }, "schwab: still rate limited after retry");
    return null;
  }
  if (res.status === 401) {
    logger.warn({ path }, "schwab: 401 after retry — re-run scripts/schwab-oauth.mjs");
    return null;
  }
  if (!res.ok) {
    logger.warn({ path, status: res.status }, "schwab: request failed");
    return null;
  }
  return (await res.json()) as T;
}

export interface SchwabQuoteNorm {
  price: number | null;
  changePercent: number | null;
  /** Absolute $ net change (netChange / netChangeInDouble). */
  change: number | null;
  open: number | null;
}

/** Batch equity quotes. Returns null map entry omitted on total failure. */
export async function getSchwabQuotes(symbols: string[]): Promise<Map<string, SchwabQuoteNorm> | null> {
  if (!schwabCredentialsConfigured() || symbols.length === 0) return null;
  const keys = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = new Map<string, SchwabQuoteNorm>();

  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    // fields=quote only — fundamental bloated payload unused by live-price path
    const data = await schwabGet<Record<string, SchwabQuotePayload>>("/quotes", {
      symbols: chunk.join(","),
      fields: "quote",
    });
    if (!data) {
      if (i === 0) return null;
      break;
    }
    for (const sym of chunk) {
      const row = data[sym];
      const q = row?.quote;
      out.set(sym, {
        price: num(q?.lastPrice ?? q?.mark ?? q?.closePrice) ?? null,
        changePercent: num(q?.netPercentChangeInDouble ?? q?.netPercentChange) ?? null,
        change: num(q?.netChangeInDouble ?? q?.netChange) ?? null,
        open: num(q?.openPrice) ?? null,
      });
    }
  }
  return out;
}

export interface SchwabDailyBar {
  /** ET trading date YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Schwab /pricehistory candle → ET trading date (candles are stamped at local midnight CT). */
export function schwabCandleYmd(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Split-adjusted daily OHLCV from `startYmd` through today (regular session only). One call per symbol.
 * Null when Schwab is unavailable or the symbol is unknown — callers fall back to Yahoo.
 */
export async function getSchwabDailyBars(symbol: string, startYmd: string): Promise<SchwabDailyBar[] | null> {
  if (!schwabCredentialsConfigured()) return null;
  const data = await schwabGet<{ candles?: SchwabCandle[]; empty?: boolean }>("/pricehistory", {
    symbol: symbol.toUpperCase(),
    periodType: "year",
    frequencyType: "daily",
    frequency: "1",
    startDate: String(Date.parse(`${startYmd}T00:00:00Z`)),
    endDate: String(Date.now()),
    needExtendedHoursData: "false",
  });
  if (!data || data.empty || !data.candles?.length) return null;
  const byDate = new Map<string, SchwabDailyBar>();
  for (const c of data.candles) {
    const close = num(c.close);
    if (close == null || close <= 0 || c.datetime == null) continue;
    byDate.set(schwabCandleYmd(c.datetime), {
      date: schwabCandleYmd(c.datetime),
      open: num(c.open) ?? close,
      high: num(c.high) ?? close,
      low: num(c.low) ?? close,
      close,
      volume: num(c.volume) ?? 0,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface SchwabMinuteBar {
  /** Candle open time (epoch ms). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Schwab 1m `/pricehistory` max window — `periodType=day` + `period` ≤ 10. */
export const SCHWAB_1M_MAX_MS = 10 * 24 * 60 * 60 * 1000;

/** Clamp a minute-bar request to the API's 10-day window (end-anchored). */
export function clampSchwabMinuteWindow(startMs: number, endMs: number): { startMs: number; endMs: number } {
  const end = Number.isFinite(endMs) ? endMs : Date.now();
  const startRaw = Number.isFinite(startMs) ? startMs : end - SCHWAB_1M_MAX_MS;
  const endClamped = Math.max(startRaw, end);
  const startClamped = Math.max(startRaw, endClamped - SCHWAB_1M_MAX_MS);
  return { startMs: startClamped, endMs: endClamped };
}

/**
 * 1-minute OHLCV from Schwab `/pricehistory` (regular session). One call per symbol.
 * Window is clamped to ≤10 calendar days. Null when Schwab is unavailable.
 */
export async function getSchwabMinuteBars(
  symbol: string,
  startMs: number,
  endMs: number = Date.now(),
): Promise<SchwabMinuteBar[] | null> {
  if (!schwabCredentialsConfigured()) return null;
  const w = clampSchwabMinuteWindow(startMs, endMs);
  const data = await schwabGet<{ candles?: SchwabCandle[]; empty?: boolean }>("/pricehistory", {
    symbol: symbol.toUpperCase(),
    periodType: "day",
    frequencyType: "minute",
    frequency: "1",
    startDate: String(w.startMs),
    endDate: String(w.endMs),
    needExtendedHoursData: "false",
  });
  if (!data || data.empty || !data.candles?.length) return null;
  const out: SchwabMinuteBar[] = [];
  for (const c of data.candles) {
    const close = num(c.close);
    if (close == null || close <= 0 || c.datetime == null) continue;
    out.push({
      ts: c.datetime,
      open: num(c.open) ?? close,
      high: num(c.high) ?? close,
      low: num(c.low) ?? close,
      close,
      volume: num(c.volume) ?? 0,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

interface SchwabCandle {
  open?: number; high?: number; low?: number; close?: number; volume?: number; datetime?: number;
}

interface SchwabQuotePayload {
  quote?: {
    lastPrice?: number;
    mark?: number;
    closePrice?: number;
    openPrice?: number;
    netPercentChangeInDouble?: number;
    netPercentChange?: number;
    netChangeInDouble?: number;
    netChange?: number;
  };
}

interface SchwabOptionContract {
  strikePrice?: number;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  volatility?: number;
  delta?: number;
  totalVolume?: number;
  openInterest?: number;
  inTheMoney?: boolean;
}

type ExpDateMap = Record<string, Record<string, SchwabOptionContract[]>>;

export interface SchwabChainResponse {
  symbol?: string;
  status?: string;
  underlyingPrice?: number;
  underlying?: { quote?: { lastPrice?: number; mark?: number } };
  callExpDateMap?: ExpDateMap;
  putExpDateMap?: ExpDateMap;
}

const FLAT_MIN_OTM = 0.03;
const FLAT_MAX_OTM = 0.25;
/** Sub-$10 names often have $0.50/$1 strikes — 25% max leaves the band empty (e.g. CABA). */
const FLAT_MAX_OTM_LOW_PRICE = 0.40;
const LOW_PRICE_SPOT = 10;
const MONTHLY_TARGET_DTE = 37;
const MONTHLY_MAX_DIFF_RATIO = 0.6;

function flatMaxOtm(spot: number): number {
  return spot > 0 && spot < LOW_PRICE_SPOT ? FLAT_MAX_OTM_LOW_PRICE : FLAT_MAX_OTM;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const daysUntil = daysUntilCeilNonNeg;

/** Standard equity monthly = 3rd Friday (day-of-month 15–21). */
export function isStandardMonthlyExpiry(d: Date): boolean {
  return d.getDay() === 5 && d.getDate() >= 15 && d.getDate() <= 21;
}

/** Weekly listed Friday that is not the standard monthly. */
function isWeeklyExpiry(d: Date): boolean {
  return d.getDay() === 5 && !isStandardMonthlyExpiry(d);
}
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Exported for unit tests. */
export function parseExpKey(key: string): { date: Date; dteHint: number } | null {
  const m = key.match(/^(\d{4}-\d{2}-\d{2}):(\d+)/);
  if (!m) return null;
  const date = new Date(`${m[1]}T16:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return { date, dteHint: Number(m[2]) };
}

function contractsFromStrikeMap(strikeMap: Record<string, SchwabOptionContract[]>): SchwabOptionContract[] {
  const out: SchwabOptionContract[] = [];
  for (const arr of Object.values(strikeMap)) {
    if (Array.isArray(arr) && arr[0]) out.push(arr[0]!);
  }
  return out;
}

/** Normalize Schwab IV: percent (28.5) → decimal (0.285). */
export function normalizeSchwabIv(raw: unknown): number {
  let iv = num(raw) ?? 0;
  if (iv > 3) iv = iv / 100;
  return iv;
}

function buildRows(
  contracts: SchwabOptionContract[],
  spot: number,
  exactDte: number,
  isCall: boolean,
): OptionRow[] {
  const maxOtm = flatMaxOtm(spot);
  const lo = isCall ? spot * (1 + FLAT_MIN_OTM) : spot * (1 - maxOtm);
  const hi = isCall ? spot * (1 + maxOtm) : spot * (1 - FLAT_MIN_OTM);

  const rows: OptionRow[] = [];
  for (const p of contracts) {
    const strike = num(p.strikePrice);
    if (strike == null || strike < lo || strike > hi) continue;
    const bid = num(p.bid) ?? 0;
    const ask = num(p.ask) ?? 0;
    const lastPrice = num(p.last) ?? num(p.mark) ?? 0;
    const iv = normalizeSchwabIv(p.volatility);
    const volume = num(p.totalVolume);
    const openInterest = num(p.openInterest);
    const priceForIncome = bid > 0 ? bid : 0;
    const incomePct = priceForIncome > 0 ? (priceForIncome / strike) * 100 : 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const spreadPct = mid != null && mid > 0 ? parseFloat(((ask - bid) / mid).toFixed(4)) : null;
    const otmPct = spot > 0 ? (isCall ? (strike - spot) / spot : (spot - strike) / spot) : 0;
    let delta = num(p.delta);
    if (delta != null) delta = parseFloat(delta.toFixed(4));

    const liveBid = bid > 0;
    const plausible = liveBid && isPlausibleOptionQuote(bid, strike, spot, otmPct);
    rows.push({
      strike,
      bid,
      ask,
      lastPrice,
      iv,
      volume,
      openInterest,
      incomePct: Math.round(incomePct * 1000) / 1000,
      meetsGate: plausible,
      bidIsLive: liveBid,
      quoteStale: !liveBid,
      delta,
      spreadPct,
    });
  }

  const byStrike = new Map<number, OptionRow>();
  for (const row of rows) {
    const existing = byStrike.get(row.strike);
    if (!existing || row.bid > existing.bid) byStrike.set(row.strike, row);
  }
  return Array.from(byStrike.values()).sort((a, b) => b.strike - a.strike);
}

function pickNearestExpiry(dates: Date[], targetDte: number, maxDiffRatio: number): Date | null {
  let best: Date | null = null;
  let bestDiff = Infinity;
  for (const d of dates) {
    const diff = Math.abs(exactDaysUntil(d) - targetDte);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  if (!best || bestDiff > targetDte * maxDiffRatio) return null;
  return best;
}

/** Exported for unit / edge-case tests. */
export function mapChainResponse(ticker: string, raw: SchwabChainResponse): OptionsChainResult[] | null {
  const spot =
    num(raw.underlyingPrice) ??
    num(raw.underlying?.quote?.lastPrice) ??
    num(raw.underlying?.quote?.mark);
  if (spot == null || spot <= 0) return null;

  const callMap = raw.callExpDateMap ?? {};
  const putMap = raw.putExpDateMap ?? {};
  const expKeys = [...new Set([...Object.keys(callMap), ...Object.keys(putMap)])];
  const parsed = expKeys
    .map((k) => {
      const p = parseExpKey(k);
      return p ? { key: k, ...p } : null;
    })
    .filter((x): x is { key: string; date: Date; dteHint: number } => x != null)
    .filter((x) => exactDaysUntil(x.date) > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (!parsed.length) return null;

  // Near = weeklies/front month within 28 DTE. Many small-caps only list the next
  // monthly (~30–45 DTE) — treat that as a full put+call chain, not calls-only.
  let near = parsed.filter((x) => exactDaysUntil(x.date) <= 28).slice(0, 2);
  const allDates = parsed.map((x) => x.date);
  const monthlyDate = pickNearestExpiry(allDates, MONTHLY_TARGET_DTE, MONTHLY_MAX_DIFF_RATIO);

  if (near.length === 0 && monthlyDate) {
    const m = parsed.find((x) => toDateStr(x.date) === toDateStr(monthlyDate));
    if (m) near = [m];
  }

  const targets: Array<{ key: string; date: Date; putsOnly: boolean }> = near.map((x) => ({
    key: x.key,
    date: x.date,
    putsOnly: false,
  }));
  if (monthlyDate) {
    const collides = near.some((x) => Math.abs(daysUntil(x.date) - daysUntil(monthlyDate)) <= 1);
    if (!collides) {
      const m = parsed.find((x) => toDateStr(x.date) === toDateStr(monthlyDate));
      // Extra monthly alongside weeklies = calls-only (put scoring stays on ≤28 DTE).
      if (m) targets.push({ key: m.key, date: m.date, putsOnly: true });
    }
  }

  const tier = getTier(ticker);
  const results: OptionsChainResult[] = [];
  for (const t of targets) {
    const exactDte = Math.max(0.5, exactDaysUntil(t.date));
    const puts = t.putsOnly
      ? []
      : buildRows(contractsFromStrikeMap(putMap[t.key] ?? {}), spot, exactDte, false);
    const calls = buildRows(contractsFromStrikeMap(callMap[t.key] ?? {}), spot, exactDte, true);
    results.push({
      ticker,
      expiry: toDateStr(t.date),
      isWeekly: isWeeklyExpiry(t.date),
      daysToExpiry: daysUntil(t.date),
      exactDte,
      settlementDte: exactDte + settlementOffsetDays(t.date),
      spot,
      tier,
      puts,
      calls,
      fetchedAt: Date.now(),
    });
  }
  return results.length ? results : null;
}

/**
 * One Schwab /chains call → OptionsChainResult[] (same shape as Yahoo path).
 * Cached 5m with in-flight coalescing. Returns null → caller should Yahoo-fallback.
 */
export async function getSchwabOptionChains(ticker: string): Promise<OptionsChainResult[] | null> {
  if (!schwabCredentialsConfigured()) return null;
  const key = ticker.toUpperCase();

  try {
    return await schwabChainCache.getOrCompute(key, async () => {
      const from = new Date();
      from.setUTCDate(from.getUTCDate() + 1);
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + 45);
      const fromDate = from.toISOString().slice(0, 10);
      const toDate = to.toISOString().slice(0, 10);

      const raw = await schwabGet<SchwabChainResponse>("/chains", {
        symbol: key,
        contractType: "ALL",
        includeUnderlyingQuote: "true",
        fromDate,
        toDate,
      });
      if (!raw) throw new Error("schwab-chain-miss");
      const mapped = mapChainResponse(key, raw);
      if (!mapped) {
        logger.warn({ ticker: key, status: raw.status }, "schwab: chain map empty");
        throw new Error("schwab-chain-empty");
      }
      return mapped;
    });
  } catch {
    // Miss / empty → null so Yahoo can fill; do not poison cache
    return null;
  }
}

export function schwabAvailable(): boolean {
  return schwabCredentialsConfigured();
}


/**
 * Full strike ladder for one ticker between two dates (A192 skew survey): ONE /chains call → flat rows, every strike (ATM included).
 * The scanner's chain fetch keeps only 3–25 % OTM, so wings/ATM for spreads & condors need this. Shares the 100-rpm throttle.
 */
export async function getSchwabChainLadder(ticker: string, fromDate: string, toDate: string, strikeCount = 80): Promise<{
  spot: number | null;
  rows: Array<{ expiry: string; side: "put" | "call"; strike: number; bid: number | null; ask: number | null; mark: number | null;
    iv: number | null; delta: number | null; oi: number | null; volume: number | null }>;
} | null> {
  const raw = await schwabGet<SchwabChainResponse>("/chains", {
    symbol: ticker.toUpperCase(), contractType: "ALL", includeUnderlyingQuote: "true", fromDate, toDate, strikeCount: String(strikeCount),
  });
  if (!raw) return null;
  const rows: Array<{ expiry: string; side: "put" | "call"; strike: number; bid: number | null; ask: number | null; mark: number | null;
    iv: number | null; delta: number | null; oi: number | null; volume: number | null }> = [];
  for (const [side, map] of [["put", raw.putExpDateMap], ["call", raw.callExpDateMap]] as const) {
    for (const [expKey, strikes] of Object.entries(map ?? {})) {
      const expiry = expKey.split(":")[0];
      for (const list of Object.values(strikes)) {
        const c = list?.[0];
        if (!c || !(num(c.strikePrice) ?? 0)) continue;
        const iv = normalizeSchwabIv(c.volatility);
        const d = num(c.delta);
        rows.push({ expiry, side, strike: num(c.strikePrice)!, bid: num(c.bid), ask: num(c.ask), mark: num(c.mark),
          iv: iv > 0 ? iv : null, delta: d != null && Math.abs(d) <= 1 ? d : null, oi: num(c.openInterest), volume: num(c.totalVolume) });
      }
    }
  }
  return { spot: num(raw.underlyingPrice) ?? num(raw.underlying?.quote?.lastPrice) ?? null, rows };
}
