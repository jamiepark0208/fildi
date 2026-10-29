/**
 * Shared breakdown fetch — one query key for watchlist, stock sheet, hover prefetch.
 *
 * Freshness policy (stale-while-revalidate):
 * - Cache paints instantly on revisit (no blank flash).
 * - Data older than STALE_MS is refetched on mount; in-flight requests are deduped by React Query.
 * - Hover prefetch warms the cache; click within STALE_MS usually shares that request.
 * - Not "cache forever" — live quote overlay on the API still refreshes last/day%.
 */
import type { QueryClient } from "@tanstack/react-query";

export const BREAKDOWN_STALE_MS = 30_000;
export const BREAKDOWN_GC_MS = 15 * 60_000;

export function breakdownQueryKey(ticker: string) {
  return ["breakdown", ticker.toUpperCase()] as const;
}

export async function fetchBreakdown(ticker: string): Promise<unknown> {
  const t = ticker.trim().toUpperCase();
  const res = await fetch(`/api/stocks/breakdown?ticker=${encodeURIComponent(t)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    if (res.status === 503) {
      throw new Error(err.error || "Market data temporarily unavailable — retry");
    }
    // Avoid raw undici "fetch failed" in the sheet — map vendor outages.
    const msg = err.error || `HTTP ${res.status}`;
    throw new Error(/fetch failed/i.test(msg) ? "Market data vendor timeout — retry" : msg);
  }
  return res.json();
}

/** Warm cache on ticker hover — no-op if already fresh. */
export function prefetchBreakdown(qc: QueryClient, ticker: string) {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  void qc.prefetchQuery({
    queryKey: breakdownQueryKey(t),
    queryFn: () => fetchBreakdown(t),
    staleTime: BREAKDOWN_STALE_MS,
  });
}
