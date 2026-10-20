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

/**
 * Failed scheduled jobs must not retry on every 30-minute heartbeat.
 * Same idea as the Friday model-snapshot window: record the attempt, wait
 * several hours, and stop after a few tries that UTC day. Schedules themselves
 * stay in the shouldRun*At functions below.
 */
export const FAILURE_BACKOFF_MS = 4 * 60 * 60 * 1000;
export const MAX_ATTEMPTS_PER_UTC_DAY = 3;

export type RunAttempt = {
  lastAttempt: Date | null;
  /** Attempts already stored for `now`'s UTC day. */
  attemptsOnDay: number;
};

export const NO_ATTEMPT: RunAttempt = { lastAttempt: null, attemptsOnDay: 0 };

export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export function daysSince(d: Date | null, now: Date): number {
  if (!d || Number.isNaN(d.getTime())) return Infinity;
  return (now.getTime() - d.getTime()) / 86_400_000;
}

/** Newer of the in-memory stamp and the DB stamp. Invalid dates are ignored. */
export function pickFresherStamp(memory: Date | null, dbStamp: Date | null): Date | null {
  const memOk = memory != null && !Number.isNaN(memory.getTime());
  const dbOk = dbStamp != null && !Number.isNaN(dbStamp.getTime());
  if (memOk && dbOk) return dbStamp!.getTime() >= memory!.getTime() ? dbStamp : memory;
  if (dbOk) return dbStamp;
  if (memOk) return memory;
  return null;
}

/** `YYYY-MM-DD:N` for today, else 0. */
export function parseAttemptCount(raw: string | null | undefined, now: Date): number {
  if (!raw) return 0;
  const day = now.toISOString().slice(0, 10);
  const [d, n] = raw.split(":");
  if (d !== day) return 0;
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function nextAttemptCount(raw: string | null | undefined, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `${day}:${parseAttemptCount(raw, now) + 1}`;
}

/** True when the last attempt failed and is still inside the backoff or the daily cap. */
export function failureBackoffBlocks(lastSuccess: Date | null, attempt: RunAttempt, now: Date): boolean {
  const at = attempt.lastAttempt;
  if (!at || Number.isNaN(at.getTime())) return false;
  const failed = !lastSuccess || Number.isNaN(lastSuccess.getTime()) || at.getTime() > lastSuccess.getTime();
  if (!failed) return false;
  if (isSameUtcDay(at, now) && attempt.attemptsOnDay >= MAX_ATTEMPTS_PER_UTC_DAY) return true;
  if (now.getTime() - at.getTime() < FAILURE_BACKOFF_MS) return true;
  return false;
}

// Sun/Thu 02:00 UTC, catch-up after 4 days. Hour and days match scheduler.ts.
const ENRICHMENT_DAYS = new Set([0, 4]);
const ENRICHMENT_HOUR = 2;
const ENRICHMENT_CATCHUP_DAYS = 4;

export function shouldRunEnrichmentAt(lastSuccess: Date | null, now: Date, attempt: RunAttempt = NO_ATTEMPT): boolean {
  if (failureBackoffBlocks(lastSuccess, attempt, now)) return false;
  const onSchedule = ENRICHMENT_DAYS.has(now.getUTCDay()) && now.getUTCHours() === ENRICHMENT_HOUR;
  const missedWindow = daysSince(lastSuccess, now) > ENRICHMENT_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastSuccess && isSameUtcDay(lastSuccess, now));
}

export function shouldRunRetentionAt(lastSuccess: Date | null, now: Date, attempt: RunAttempt = NO_ATTEMPT): boolean {
  if (failureBackoffBlocks(lastSuccess, attempt, now)) return false;
  return !(lastSuccess && isSameUtcDay(lastSuccess, now));
}

// 14:00 UTC ≈ 7:00 AM PT. Catch-up through 16:00 UTC, or if the last success is over 1.5 days old.
const DAILY_PRECOMPUTE_HOUR = 14;
const DAILY_PRECOMPUTE_CATCHUP_END = 16;

export function shouldRunDailyPrecomputeAt(lastSuccess: Date | null, now: Date, attempt: RunAttempt = NO_ATTEMPT): boolean {
  if (failureBackoffBlocks(lastSuccess, attempt, now)) return false;
  if (lastSuccess && isSameUtcDay(lastSuccess, now)) return false;
  const hour = now.getUTCHours();
  const onSchedule = hour === DAILY_PRECOMPUTE_HOUR;
  const morningCatchup = hour > DAILY_PRECOMPUTE_HOUR && hour <= DAILY_PRECOMPUTE_CATCHUP_END;
  const missedWindow = daysSince(lastSuccess, now) > 1.5;
  return onSchedule || morningCatchup || missedWindow;
}

// Fallback: Mon–Thu 19:00 UTC, skipped when the 7 AM PT Model List run already scanned today (snapshot-option-scores.ts stamps it).
// Friday stays with the model snapshot. Catch-up after 2 days.
const OPTION_SCORE_HOUR = 19;
const OPTION_SCORE_CATCHUP_DAYS = 2;
const FRIDAY = 5;

export function shouldRunOptionScoreAt(lastSuccess: Date | null, now: Date, attempt: RunAttempt = NO_ATTEMPT): boolean {
  if (failureBackoffBlocks(lastSuccess, attempt, now)) return false;
  const dow = now.getUTCDay();
  if (dow === FRIDAY) return false;
  const weekday = dow >= 1 && dow <= 5;
  const onSchedule = weekday && now.getUTCHours() === OPTION_SCORE_HOUR;
  const missedWindow = daysSince(lastSuccess, now) > OPTION_SCORE_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastSuccess && isSameUtcDay(lastSuccess, now));
}
