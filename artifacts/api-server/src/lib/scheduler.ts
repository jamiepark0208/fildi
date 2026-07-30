/**
 * Background job scheduler for the api-server.
 *
 * - Nightly enrichment: Sunday and Thursday at 02:00–02:59 UTC.
 * - Retention prune: once per calendar day (UTC), any hour.
 * - Trade-idea expiry resolution: Saturday at 02:00–02:59 UTC — settles option
 *   trade ideas left OPEN past Friday's expiry (see trade-post-expiry.ts).
 *
 * Uses a 30-minute heartbeat to detect each window without external cron.
 * Each job skips if it already ran within the current calendar day (UTC).
 */
import { eq } from "drizzle-orm";
import { db, appConfig } from "@workspace/db";
import { logger } from "./logger.js";
import { runNightlyEnrichment } from "../scripts/nightly-enrichment.js";
import { pruneOldRows } from "./retention.js";
import { rotateApiServerLogIfNeeded, pruneScriptLogs } from "./log-rotation.js";
import { resolveExpiredOptionTrades } from "./trade-post-expiry.js";
import { runModelSnapshot, runModelGrading } from "./model-track-record.js";
import { isMarketOpen, minutesSinceOpen } from "./market-hours.js";
import { runCheckpoint, CHECKPOINTS_MIN } from "./intraday-regime.js";
import { runEntrySignals } from "./intraday-entry-signals.js";

// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";
const LAST_RETENTION_PRUNE_KEY = "last_retention_prune";
const LAST_TRADE_EXPIRY_RUN_KEY = "last_trade_expiry_run";
const LAST_MODEL_SNAPSHOT_RUN_KEY = "last_model_snapshot_run";

// Exported so data-health / scheduled-tasks routes can read them without a DB round-trip.
// Hydrated from app_config at startup — see loadPersistedLastRun().
export let lastEnrichmentRun: Date | null = null;
export let enrichmentRunning = false;
// Setter so other modules (e.g. the ad-hoc refetch-queue route) can share this
// mutex with the scheduler — a plain `let` export is read-only outside this file.
export function setEnrichmentRunning(v: boolean) { enrichmentRunning = v; }
export let lastTradeExpiryRun: Date | null = null;
export let tradeExpiryRunning = false;
export let lastModelSnapshotRun: Date | null = null;
export let modelSnapshotRunning = false;

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

function daysSince(d: Date | null): number {
  if (!d) return Infinity;
  return (Date.now() - d.getTime()) / (24 * 60 * 60 * 1000);
}

export let lastRetentionPrune: Date | null = null;

const SCHEDULE_DAYS = new Set([0, 4]); // 0=Sunday, 4=Thursday (UTC)
const SCHEDULE_HOUR = 2;
const TRADE_EXPIRY_DAY = 6; // Saturday (UTC) — the day after Friday's typical option expiry
const TRADE_EXPIRY_HOUR = 2;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Windows are Sun/Thu, so a healthy run is never more than ~4 days old. If the process
// wasn't alive during the exact scheduled hour (deploy restart, autoscale cold start),
// the day/hour match is missed entirely with no other trigger — catch up once the gap
// exceeds a full cycle instead of silently skipping until the next window.
const ENRICHMENT_CATCHUP_DAYS = 4;

function shouldRunEnrichmentNow(): boolean {
  const now = new Date();
  const onSchedule = SCHEDULE_DAYS.has(now.getUTCDay()) && now.getUTCHours() === SCHEDULE_HOUR;
  const missedWindow = daysSince(lastEnrichmentRun) > ENRICHMENT_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastEnrichmentRun && isSameUtcDay(lastEnrichmentRun, now));
}

function shouldRunRetentionNow(): boolean {
  const now = new Date();
  return !(lastRetentionPrune && isSameUtcDay(lastRetentionPrune, now));
}

// Weekly (Saturday) cadence — same missed-window risk as enrichment, so apply the
// same catch-up guard rather than depending entirely on the lazy /feed/posts fallback.
const TRADE_EXPIRY_CATCHUP_DAYS = 8;

function shouldRunTradeExpiryNow(): boolean {
  const now = new Date();
  const onSchedule = now.getUTCDay() === TRADE_EXPIRY_DAY && now.getUTCHours() === TRADE_EXPIRY_HOUR;
  const missedWindow = daysSince(lastTradeExpiryRun) > TRADE_EXPIRY_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastTradeExpiryRun && isSameUtcDay(lastTradeExpiryRun, now));
}

// Model accountability snapshot: Friday 19:00–19:59 UTC — market is OPEN (15:00 ET),
// so Yahoo bids are live (bid=0 for every contract when closed). Catch-up runs on
// other days fall back to lastPrice with bidIsLive=false flagged on the row.
const MODEL_SNAPSHOT_DAY = 5; // Friday (UTC)
const MODEL_SNAPSHOT_HOUR = 19;
const MODEL_SNAPSHOT_CATCHUP_DAYS = 8;

function shouldRunModelSnapshotNow(): boolean {
  const now = new Date();
  const onSchedule = now.getUTCDay() === MODEL_SNAPSHOT_DAY && now.getUTCHours() === MODEL_SNAPSHOT_HOUR;
  const missedWindow = daysSince(lastModelSnapshotRun) > MODEL_SNAPSHOT_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastModelSnapshotRun && isSameUtcDay(lastModelSnapshotRun, now));
}

async function runEnrichment() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;
  logger.info("scheduler: starting nightly enrichment");
  try {
    await runNightlyEnrichment("scheduled");
    lastEnrichmentRun = new Date();
    await setConfigDate(LAST_ENRICHMENT_RUN_KEY, lastEnrichmentRun);
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
  } finally {
    enrichmentRunning = false;
  }
}

// Belt-and-suspenders for resolveExpiredOptionTrades(), which already runs lazily
// on GET /feed/posts — this guarantees expired trades settle even if nobody opens
// the feed over the weekend, instead of staying OPEN until the next visit.
async function runTradeExpiry() {
  if (tradeExpiryRunning) return;
  tradeExpiryRunning = true;
  logger.info("scheduler: starting trade-idea expiry resolution");
  try {
    await resolveExpiredOptionTrades();
    // Model accountability grading rides the same Saturday window — internally
    // stage-isolated (each grader catches its own errors), so a grading failure
    // can't mask a successful trade-idea resolution or vice versa.
    await runModelGrading();
    lastTradeExpiryRun = new Date();
    await setConfigDate(LAST_TRADE_EXPIRY_RUN_KEY, lastTradeExpiryRun);
    logger.info("scheduler: trade-idea expiry resolution complete");
  } catch (err) {
    logger.error({ err }, "scheduler: trade-idea expiry resolution failed");
  } finally {
    tradeExpiryRunning = false;
  }
}

async function runModelSnapshotJob() {
  if (modelSnapshotRunning) return;
  modelSnapshotRunning = true;
  logger.info("scheduler: starting model accountability snapshot");
  try {
    await runModelSnapshot();
    lastModelSnapshotRun = new Date();
    await setConfigDate(LAST_MODEL_SNAPSHOT_RUN_KEY, lastModelSnapshotRun);
    logger.info("scheduler: model accountability snapshot complete");
  } catch (err) {
    logger.error({ err }, "scheduler: model accountability snapshot failed");
  } finally {
    modelSnapshotRunning = false;
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

export let regimeCheckRunning = false;
export let lastRegimeCheckpointRun: Date | null = null;

// Separate, finer heartbeat for the intraday regime banner — checkpoints are
// 15 min apart, tighter than the 30-min cadence the other jobs use, so this
// runs on its own interval rather than changing CHECK_INTERVAL_MS for everything else.
async function runRegimeCheckpoints() {
  if (regimeCheckRunning) return;
  const minSinceOpen = minutesSinceOpen();
  if (minSinceOpen == null) return;
  regimeCheckRunning = true;
  try {
    let anyRecorded = false;
    for (const threshold of CHECKPOINTS_MIN) {
      if (minSinceOpen >= threshold) {
        const recorded = await runCheckpoint(threshold).catch(err => {
          logger.error({ err, threshold }, "scheduler: intraday-regime checkpoint failed");
          return false;
        });
        if (recorded) anyRecorded = true;
      }
    }
    // Per-ticker entry signals ride the same cadence: refreshed once per newly
    // resolved checkpoint, not on every 60s tick (each run is ~46 chart fetches).
    if (anyRecorded) {
      await runEntrySignals().catch(err =>
        logger.error({ err }, "scheduler: entry-signal recompute failed"),
      );
    }
    lastRegimeCheckpointRun = new Date();
  } finally {
    regimeCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  [lastEnrichmentRun, lastRetentionPrune, lastTradeExpiryRun, lastModelSnapshotRun] = await Promise.all([
    getConfigDate(LAST_ENRICHMENT_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_RETENTION_PRUNE_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted retention-prune, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_TRADE_EXPIRY_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted trade-expiry last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_MODEL_SNAPSHOT_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted model-snapshot last-run, dedupe guard starts cold");
      return null;
    }),
  ]);

  setInterval(() => {
    if (shouldRunEnrichmentNow()) runEnrichment();
    if (shouldRunRetentionNow()) runRetentionPrune();
    if (shouldRunTradeExpiryNow()) runTradeExpiry();
    if (shouldRunModelSnapshotNow()) runModelSnapshotJob();
    // Size-gated, not day-gated — checks every tick but only acts past the 20MB threshold.
    rotateApiServerLogIfNeeded();
  }, CHECK_INTERVAL_MS);

  setInterval(() => {
    if (isMarketOpen()) runRegimeCheckpoints();
  }, 60 * 1000);

  logger.info(
    {
      scheduleDays: ["Sunday", "Thursday"], scheduleHourUtc: SCHEDULE_HOUR,
      tradeExpiryDay: "Saturday", tradeExpiryHourUtc: TRADE_EXPIRY_HOUR,
      modelSnapshotDay: "Friday", modelSnapshotHourUtc: MODEL_SNAPSHOT_HOUR,
      lastEnrichmentRun, lastRetentionPrune, lastTradeExpiryRun, lastModelSnapshotRun,
    },
    "scheduler: enrichment + retention + trade-expiry schedule registered",
  );
}
