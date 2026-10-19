/**
 * A83 — ATM IV term structure across expiry buckets (from options.ts).
 */
import { exactDaysUntil, daysUntilCeil } from "./date-util.js";
import { mapWithConcurrency } from "./http-client.js";
import {
  expiryCache,
  fetchChain,
  toDateStr,
  type RawContract,
  type RawOptionsResponse,
} from "./options.js";

const daysUntil = daysUntilCeil;

export interface IvTermPoint {
  label: string;
  expiry: string;
  dte: number;
  iv: number;
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

  const future = allDates.filter((d) => exactDaysUntil(d) > 0).sort((a, b) => a.getTime() - b.getTime());
  if (future.length === 0) return [];

  const picked = new Map<string, { label: string; date: Date }>();
  for (const { label, targetDte } of IV_TERM_BUCKETS) {
    let best: Date | null = null;
    let bestDiff = Infinity;
    for (const d of future) {
      const diff = Math.abs(exactDaysUntil(d) - targetDte);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = d;
      }
    }
    if (!best || bestDiff > targetDte * 0.6) continue;
    const dateKey = toDateStr(best);
    if (!picked.has(dateKey)) picked.set(dateKey, { label, date: best });
  }
  if (picked.size === 0) return [];

  if (!raw0) raw0 = await fetchChain(key, [...picked.values()][0]!.date);
  const spot = raw0.quote?.regularMarketPrice;
  if (!spot) return [];

  const firstRawDte = daysUntil(raw0.options?.[0]?.expirationDate);
  const pickedList = [...picked.values()];

  const results = (
    await mapWithConcurrency(pickedList, 3, async ({ label, date }) => {
      const canReuse =
        Math.abs(daysUntil(date) - firstRawDte) <= 1 && (raw0!.options?.[0]?.puts?.length ?? 0) > 0;
      const raw = canReuse ? raw0! : await fetchChain(key, date);
      const contracts = [...(raw.options?.[0]?.puts ?? []), ...(raw.options?.[0]?.calls ?? [])].filter(
        (c): c is RawContract & { strike: number; impliedVolatility: number } =>
          typeof c.strike === "number" &&
          typeof c.impliedVolatility === "number" &&
          c.impliedVolatility > 0,
      );
      if (contracts.length === 0) return null;

      let atm = contracts[0]!;
      let bestDiff = Math.abs(atm.strike - (spot as number));
      for (const c of contracts) {
        const diff = Math.abs(c.strike - (spot as number));
        if (diff < bestDiff) {
          bestDiff = diff;
          atm = c;
        }
      }

      return {
        label,
        expiry: toDateStr(date),
        dte: Math.round(exactDaysUntil(date)),
        iv: atm.impliedVolatility,
      } satisfies IvTermPoint;
    })
  ).filter((r): r is IvTermPoint => r != null);

  return results.sort((a, b) => a.dte - b.dte);
}
