/**
 * Twice-weekly enrichment scheduler.
 *
 * Fires on Sunday and Thursday at 02:00–02:59 UTC.
 * Uses a 30-minute heartbeat to detect the window without external cron.
 * Skips if an enrichment already ran within the current calendar day (UTC).
 */
import { logger } from "./logger.js";
import { runNightlyEnrichment } from "../scripts/nightly-enrichment.js";

// Exported so data-health route can read it without a DB round-trip.
export let lastEnrichmentRun: Date | null = null;
export let enrichmentRunning = false;

const SCHEDULE_DAYS = new Set([0, 4]); // 0=Sunday, 4=Thursday (UTC)
const SCHEDULE_HOUR = 2;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function shouldRunNow(): boolean {
  const now = new Date();
  return (
    SCHEDULE_DAYS.has(now.getUTCDay()) &&
    now.getUTCHours() === SCHEDULE_HOUR &&
    !ranTodayUtc()
  );
}

function ranTodayUtc(): boolean {
  if (!lastEnrichmentRun) return false;
  const last = lastEnrichmentRun;
  const now = new Date();
  return (
    last.getUTCFullYear() === now.getUTCFullYear() &&
    last.getUTCMonth()    === now.getUTCMonth() &&
    last.getUTCDate()     === now.getUTCDate()
  );
}

async function runEnrichment() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;
  logger.info("scheduler: starting nightly enrichment");
  try {
    await runNightlyEnrichment();
    lastEnrichmentRun = new Date();
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
  } finally {
    enrichmentRunning = false;
  }
}

export function startScheduler() {
  setInterval(() => {
    if (shouldRunNow()) runEnrichment();
  }, CHECK_INTERVAL_MS);

  logger.info(
    { scheduleDays: ["Sunday", "Thursday"], scheduleHourUtc: SCHEDULE_HOUR },
    "scheduler: enrichment schedule registered",
  );
}
