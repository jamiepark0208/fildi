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
import { pruneOldRows } from "./retention.js";
import { rotateApiServerLogIfNeeded, pruneScriptLogs } from "./log-rotation.js";

// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";
const LAST_RETENTION_PRUNE_KEY = "last_retention_prune";

// Exported so data-health route can read it without a DB round-trip.
// Hydrated from app_config at startup — see loadPersistedLastRun().
export let lastEnrichmentRun: Date | null = null;
export let enrichmentRunning = false;

async function getConfigDate(key: string): Promise<Date | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  const iso = rows[0]?.value as string | undefined;
  return iso ? new Date(iso) : null;
}

async function setConfigDate(key: string, date: Date): Promise<void> {
  const value = date.toISOString();
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key, value });
  } else {
    await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
  }
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth()    === b.getUTCMonth() &&
    a.getUTCDate()     === b.getUTCDate()
  );
}

let lastRetentionPrune: Date | null = null;

const SCHEDULE_DAYS = new Set([0, 4]); // 0=Sunday, 4=Thursday (UTC)
const SCHEDULE_HOUR = 2;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function shouldRunEnrichmentNow(): boolean {
  const now = new Date();
  return (
    SCHEDULE_DAYS.has(now.getUTCDay()) &&
    now.getUTCHours() === SCHEDULE_HOUR &&
    !(lastEnrichmentRun && isSameUtcDay(lastEnrichmentRun, now))
  );
}

function shouldRunRetentionNow(): boolean {
  const now = new Date();
  return !(lastRetentionPrune && isSameUtcDay(lastRetentionPrune, now));
}

async function runEnrichment() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;
  logger.info("scheduler: starting nightly enrichment");
  try {
    await runNightlyEnrichment();
    lastEnrichmentRun = new Date();
    await setConfigDate(LAST_ENRICHMENT_RUN_KEY, lastEnrichmentRun);
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
  } finally {
    enrichmentRunning = false;
  }
}

// Runs at most once/day, independent of the enrichment window — table/log growth
// from per-request activity doesn't need to wait for a biweekly job.
async function runRetentionPrune() {
  lastRetentionPrune = new Date();
  await setConfigDate(LAST_RETENTION_PRUNE_KEY, lastRetentionPrune).catch(err =>
    logger.error({ err }, "scheduler: failed to persist retention-prune timestamp"),
  );
  await pruneOldRows();
  pruneScriptLogs();
}

export async function startScheduler(): Promise<void> {
  [lastEnrichmentRun, lastRetentionPrune] = await Promise.all([
    getConfigDate(LAST_ENRICHMENT_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_RETENTION_PRUNE_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted retention-prune, dedupe guard starts cold");
      return null;
    }),
  ]);

  setInterval(() => {
    if (shouldRunEnrichmentNow()) runEnrichment();
    if (shouldRunRetentionNow()) runRetentionPrune();
    // Size-gated, not day-gated — checks every tick but only acts past the 20MB threshold.
    rotateApiServerLogIfNeeded();
  }, CHECK_INTERVAL_MS);

  logger.info(
    { scheduleDays: ["Sunday", "Thursday"], scheduleHourUtc: SCHEDULE_HOUR, lastEnrichmentRun, lastRetentionPrune },
    "scheduler: enrichment + retention schedule registered",
  );
}
