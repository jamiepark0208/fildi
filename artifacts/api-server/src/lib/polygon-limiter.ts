/**
 * Shared Polygon free-tier gate (A96): 5 calls/min → 12.5 s gap between any polygon HTTP calls.
 * short-interest, short-volume, dividends, grouped aggs all go through `polygonFetch`.
 */
import { recordApiUsage } from "./api-usage.js";

const GAP_MS = 12_500;
let lastCall = 0;
let chain: Promise<void> = Promise.resolve();

/** Serialize callers and enforce the free-tier gap. Counts every call via recordApiUsage. */
export async function polygonFetch(url: string, init?: RequestInit): Promise<Response> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const prev = chain;
  chain = gate;
  await prev;
  try {
    const wait = lastCall + GAP_MS - Date.now();
    lastCall = Math.max(Date.now(), lastCall + GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
    void recordApiUsage("polygon", 1).catch(() => {});
    return res;
  } finally {
    release();
  }
}

export function polygonApiKey(): string | undefined {
  return process.env.POLYGON_API_KEY || undefined;
}
