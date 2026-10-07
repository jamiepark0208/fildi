/**
 * Pure missed-window gates for the in-process scheduler (no DB / side effects).
 * Kept separate so unit tests do not boot @workspace/db.
 */

/** Regime 60s heartbeat: RTH always; after final checkpoint once if host missed the session. */
export function shouldRunRegimeCheckpointsAt(opts: {
  isOpen: boolean;
  marketOpenUtc: Date | null;
  now: Date;
  lastRun: Date | null;
  lastCheckpointMin: number;
}): boolean {
  if (opts.isOpen) return true;
  if (!opts.marketOpenUtc) return false;
  const elapsedMin = (opts.now.getTime() - opts.marketOpenUtc.getTime()) / 60_000;
  if (elapsedMin < opts.lastCheckpointMin) return false;
  const finalWindowAt = opts.marketOpenUtc.getTime() + opts.lastCheckpointMin * 60_000;
  if (opts.lastRun && opts.lastRun.getTime() >= finalWindowAt) return false;
  return true;
}
