/**
 * Twice-weekly enrichment scheduler.
 *
 * Fires on Sunday and Thursday at 02:00–02:59 UTC.
 * Uses a 30-minute heartbeat to detect the window without external cron.
 * Skips if an enrichment already ran within the current calendar day (UTC).
 */
import { eq } from "drizzle-orm";
import { db, appConfig } from "@workspace/db";
import { logger } from "./logger.js";
import { runNightlyEnrichment } from "../scripts/nightly-enrichment.js";

// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";

// Exported so data-health route can read it without a DB round-trip.
// Hydrated from app_config at startup — see loadPersistedLastRun().
export let lastEnrichmentRun: Date | null = null;
export let enrichmentRunning = false;

async function loadPersistedLastRun(): Promise<void> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, LAST_ENRICHMENT_RUN_KEY)).limit(1);
  const iso = rows[0]?.value as string | undefined;
  if (iso) lastEnrichmentRun = new Date(iso);
}

async function persistLastRun(date: Date): Promise<void> {
  const value = date.toISOString();
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, LAST_ENRICHMENT_RUN_KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: LAST_ENRICHMENT_RUN_KEY, value });
  } else {
    await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, LAST_ENRICHMENT_RUN_KEY));
  }
}

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
    await persistLastRun(lastEnrichmentRun);
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
  } finally {
    enrichmentRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  await loadPersistedLastRun().catch(err =>
    logger.error({ err }, "scheduler: failed to load persisted last-run, dedupe guard starts cold"),
  );

  setInterval(() => {
    if (shouldRunNow()) runEnrichment();
  }, CHECK_INTERVAL_MS);

  logger.info(
    { scheduleDays: ["Sunday", "Thursday"], scheduleHourUtc: SCHEDULE_HOUR, lastEnrichmentRun },
    "scheduler: enrichment schedule registered",
  );
}
