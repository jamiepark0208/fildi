import { logger } from "./logger.js";

/** Shared sleep — re-exported so callers can pace batch loops without re-declaring it. */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** ±50% jitter around a base delay so synchronized failures don't retry in lockstep (thundering herd on recovery). */
export function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

/**
 * Masks credentials carried in query strings (FMP/AV `apikey`, Polygon `apiKey`, Finnhub
 * `token`, FRED `api_key`). Use on every URL that reaches a log line or an Error message —
 * callers log err.message (logApiCall, logger.warn) into api.log, whose tail the Scheduled
 * Tasks page displays, and pino's `redact` can't mask substrings inside a string.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|token)=)[^&#]*/gi, "$1***");
}

/** Parses a Retry-After header (seconds or HTTP date), capped at 30s; `fallbackMs` when absent/invalid. */
export function retryAfterMs(res: Response, fallbackMs = 2_000): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return fallbackMs;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(30_000, sec * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(30_000, Math.max(0, when - Date.now()));
  return fallbackMs;
}

// ── Per-provider rate limit ──────────────────────────────────────────────────
// Rolling-window caps shared by EVERY caller of a provider (nightly enrichment, on-demand
// enrich, peer resolver, earnings calendar, ...). Batch scripts keep their own sleeps; this
// only binds when several paths hit the same provider at once. Set just under the
// published free-tier limits noted in the backfill scripts.
const PROVIDER_LIMITS: Record<string, { max: number; windowMs: number }> = {
  Finnhub: { max: 55, windowMs: 60_000 }, // 60/min free tier
  Polygon: { max: 5,  windowMs: 60_000 }, // 5/min free tier
  AV:      { max: 5,  windowMs: 60_000 }, // 5/min free tier (daily cap enforced by AV_MAX_DAILY_CALLS)
  EDGAR:   { max: 9,  windowMs: 1_000 },  // SEC fair-access: 10 req/s
  // FMP starter ~300/min published; book quota ~220/day (A46). Cap burst, not daily.
  FMP:     { max: 8,  windowMs: 1_000 },  // ~8/s — replaces ad-hoc 300–400ms sleeps (A83)
};

/** Run `fn` over items with at most `concurrency` in flight (order preserved). */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const out = new Array<R>(n);
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), n);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const recentCalls = new Map<string, number[]>();
const acquireChain = new Map<string, Promise<void>>();

/** Waits until `provider` has a free slot in its window. No-op for providers without a limit. */
export async function acquireProviderSlot(provider: string): Promise<void> {
  const limit = PROVIDER_LIMITS[provider];
  if (!limit) return;
  // Serialize acquirers per provider so two waiters can't both claim the same freed slot.
  const run = (acquireChain.get(provider) ?? Promise.resolve()).then(async () => {
    const calls = recentCalls.get(provider) ?? [];
    for (;;) {
      const now = Date.now();
      while (calls.length > 0 && calls[0]! <= now - limit.windowMs) calls.shift();
      if (calls.length < limit.max) break;
      await sleep(calls[0]! + limit.windowMs - now + 5);
    }
    calls.push(Date.now());
    recentCalls.set(provider, calls);
  });
  acquireChain.set(provider, run.catch(() => undefined));
  await run;
}

export interface FetchJsonOptions {
  /** Provider name for log/error messages and the PROVIDER_LIMITS key (e.g. "FMP", "Polygon", "AV"). */
  provider: string;
  maxRetries?: number;
  /** Per-attempt socket timeout. Node's global fetch has NO default timeout — a stalled
   *  upstream connection hangs forever without this, accumulating over a long-running server. */
  timeoutMs?: number;
  baseDelayMs?: number;
  init?: RequestInit;
  /** Resolve `null` on 404 instead of throwing (providers where 404 = "no data for ticker"). */
  nullOn404?: boolean;
  /** A266 — persist this response in vendor_raw. Secrets stay out of endpoint/key. */
  vendorRaw?: { source: string; endpoint: string; key: string; latestOnly?: boolean };
}

/**
 * Single source of truth for external JSON GETs: per-provider rate limit, per-attempt
 * timeout, exponential backoff with jitter (Retry-After honored on 429/503), fail-fast
 * on permanent 4xx, and credential redaction in logs/errors.
 */
export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchJsonOptions & { nullOn404: true }): Promise<T | null>;
export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchJsonOptions): Promise<T>;
export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchJsonOptions): Promise<T | null> {
  const { provider, maxRetries = 3, timeoutMs = 15_000, baseDelayMs = 1000, init, nullOn404 = false } = opts;
  const safeUrl = redactUrl(url);
  let delay = baseDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireProviderSlot(provider);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(jitter(delay));
      delay *= 2;
      continue;
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt === maxRetries) throw new Error(`${provider} HTTP ${res.status} (rate limited) after ${maxRetries} retries for ${safeUrl}`);
      const wait = res.headers.has("retry-after") ? retryAfterMs(res) : jitter(delay);
      logger.warn({ url: safeUrl, attempt, provider, status: res.status, waitMs: wait }, `${provider}: rate limited, backing off`);
      await sleep(wait);
      delay *= 2;
      continue;
    }
    if (res.status === 404 && nullOn404) return null;
    if (!res.ok) {
      // Permanent client errors (bad auth, plan/entitlement, not-found) never succeed on
      // retry — failing fast avoids burning ~15s*attempts per ticker on a dead endpoint.
      const isPermanent = res.status >= 400 && res.status < 500;
      if (isPermanent || attempt === maxRetries) throw new Error(`${provider} HTTP ${res.status} for ${safeUrl}`);
      await sleep(jitter(delay));
      delay *= 2;
      continue;
    }
    const body = (await res.json()) as T;
    if (opts.vendorRaw && body != null) {
      try {
        const { rememberVendorPayload } = await import("./vendor-raw.js");
        await rememberVendorPayload({ ...opts.vendorRaw, payload: body });
      } catch (err) {
        logger.warn({ err: String(err), source: opts.vendorRaw.source }, "vendor_raw: store failed");
      }
    }
    return body;
  }
  // Unreachable: the loop returns or throws on the final attempt.
  throw new Error(`${provider}: exhausted retries for ${safeUrl}`);
}
