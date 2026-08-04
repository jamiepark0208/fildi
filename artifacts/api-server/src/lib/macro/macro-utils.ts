// Shared small helpers used across the macro/* submodules. Extracted verbatim
// from macro-data.ts — no behavior change.
import type { ChartPoint, MarketQuote } from "../macro-data.js";

// ── Concurrency limiter ───────────────────────────────────────────────────────
// Replaces Promise.allSettled for external HTTP calls — runs at most `limit`
// tasks at once so we don't exhaust sockets on Replit's free tier.
export async function allSettledLimited<T>(
  thunks: (() => Promise<T>)[],
  concurrency = 5
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await thunks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export function safeQuote(q: unknown): MarketQuote {
  if (!q || typeof q !== "object")
    return { value: null, change: null, changePct: null };
  const r = q as Record<string, unknown>;
  return {
    value:     typeof r["regularMarketPrice"]         === "number" ? r["regularMarketPrice"]         : null,
    change:    typeof r["regularMarketChange"]        === "number" ? r["regularMarketChange"]        : null,
    changePct: typeof r["regularMarketChangePercent"] === "number" ? r["regularMarketChangePercent"] : null,
  };
}

export function sortedByDate(points: ChartPoint[]): ChartPoint[] {
  return [...points].sort((a, b) => a.date.localeCompare(b.date));
}

export function valueDaysAgo(sorted: ChartPoint[], daysAgo: number): number | null {
  if (sorted.length === 0) return null;
  const targetDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const targetStr = targetDate.toISOString().slice(0, 10);
  let val: number | null = null;
  for (const p of sorted) {
    if (p.date > targetStr) break;
    val = p.value;
  }
  return val ?? sorted[0].value;
}
