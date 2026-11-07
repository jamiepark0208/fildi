/** A367 — per-symbol 1m poll window (no DB). */
export const BAR_OVERLAP_MS = 2 * 60_000;
export const LIVE_LOOKBACK_MS = 2 * 60 * 60 * 1000;

export function pollStartMsForSymbol(
  sym: string,
  endMs: number,
  lastStoredMs: number | undefined,
  opts?: { days?: number; lookbackMs?: number },
): number {
  void sym;
  if (opts?.days != null) {
    return endMs - opts.days * 24 * 60 * 60 * 1000;
  }
  if (lastStoredMs != null && lastStoredMs > 0) {
    return Math.max(lastStoredMs - BAR_OVERLAP_MS, endMs - LIVE_LOOKBACK_MS);
  }
  return endMs - (opts?.lookbackMs ?? LIVE_LOOKBACK_MS);
}
