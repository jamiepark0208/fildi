/** A367 — per-symbol 1m poll window (no DB). */
export const BAR_OVERLAP_MS = 2 * 60_000;
export const LIVE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** Max gap we back-fill from the last stored bar (restart / auth outage / overnight). */
export const MAX_GAP_FILL_MS = 4 * 24 * 60 * 60 * 1000;

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
    // Claude 11-07: fill the whole gap since the last stored bar (was capped at 2 h → holes after any outage).
    return Math.max(lastStoredMs - BAR_OVERLAP_MS, endMs - MAX_GAP_FILL_MS);
  }
  return endMs - (opts?.lookbackMs ?? LIVE_LOOKBACK_MS);
}
