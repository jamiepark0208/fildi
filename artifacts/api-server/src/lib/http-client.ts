import { logger } from "./logger.js";

/** Shared sleep — re-exported so callers can pace batch loops without re-declaring it. */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** ±50% jitter around a base delay so synchronized failures don't retry in lockstep (thundering herd on recovery). */
function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

export interface FetchJsonOptions {
  /** Provider name for log/error messages (e.g. "FMP", "Polygon", "AV"). */
  provider: string;
  maxRetries?: number;
  /** Per-attempt socket timeout. Node's global fetch has NO default timeout — a stalled
   *  upstream connection hangs forever without this, accumulating over a long-running server. */
  timeoutMs?: number;
  baseDelayMs?: number;
  init?: RequestInit;
}

/**
 * Single source of truth for external JSON GETs: per-attempt timeout, exponential
 * backoff with jitter, and 429/!ok handling. Replaces the byte-identical fetchWithRetry
 * that FMP/Polygon/AV each carried (see one-time review — drift + missing timeouts).
 */
export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchJsonOptions): Promise<T> {
  const { provider, maxRetries = 3, timeoutMs = 15_000, baseDelayMs = 1000, init } = opts;
  let delay = baseDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(jitter(delay));
      delay *= 2;
      continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`${provider} rate limit exceeded after ${maxRetries} retries`);
      logger.warn({ url, attempt, provider }, `${provider}: rate limited, backing off`);
      await sleep(jitter(delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`${provider} HTTP ${res.status} for ${url}`);
      await sleep(jitter(delay));
      delay *= 2;
      continue;
    }
    return res.json() as Promise<T>;
  }
  // Unreachable: the loop returns or throws on the final attempt.
  throw new Error(`${provider}: exhausted retries for ${url}`);
}
