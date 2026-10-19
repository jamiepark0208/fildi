/**
 * A87 — Polygon daily aggregates → YahooBar-shaped series (soft fill when Schwab/Yahoo thin).
 * Ranked equal to FMP in price-source-rank (below Schwab, above LSEG/Yahoo).
 */
import { fetchJsonWithRetry } from "./http-client.js";
import type { YahooBar } from "./indicator-bar-merge.js";

type Agg = { t: number; o: number; h: number; l: number; c: number; v?: number };

export async function fetchPolygonDailyBars(
  ticker: string,
  period1Ymd: string,
): Promise<YahooBar[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return [];
  const t = ticker.toUpperCase();
  // period2 exclusive-ish: today UTC
  const period2 = new Date().toISOString().slice(0, 10);
  const url =
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/` +
    `${period1Ymd}/${period2}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`;
  const data = await fetchJsonWithRetry<{ results?: Agg[]; status?: string }>(url, {
    provider: "Polygon",
    nullOn404: true,
    timeoutMs: 30_000,
  });
  if (!data?.results?.length) return [];
  return data.results.map((b) => {
    const day = new Date(b.t).toISOString().slice(0, 10);
    return {
      date: new Date(`${day}T16:00:00.000Z`),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: Number(b.v) || 0,
    };
  });
}
