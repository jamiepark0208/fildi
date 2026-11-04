/**
 * Background job scheduler for the api-server.
 *
 * - Nightly enrichment: Sunday and Thursday at 02:00–02:59 UTC
 *   (disabled when DISABLE_SCHEDULER_ENRICHMENT=1 — Mac uses com.fildi.maintain instead).
 * - Retention prune: once per calendar day (UTC), any hour.
 * - Trade-idea expiry resolution: Saturday at 02:00–02:59 UTC — settles option
 *   trade ideas left OPEN past Friday's expiry (see trade-post-expiry.ts).
 *
 * Uses a 30-minute heartbeat to detect each window without external cron.
 * Each job skips if it already ran within the current calendar day (UTC).
 */
export { shouldRunRegimeCheckpointsAt } from "./scheduler-catchup.js";
export {
  runSchwab1mPoll,
  runSchwab1mBackfill,
  schwab1mPollRunning,
  lastSchwab1mPollRun,
} from "./schwab-1m-poll.js";

export {
  noteEnrichmentRunFromDb,
  setEnrichmentRunning,
  lastEnrichmentRun,
  enrichmentRunning,
  lastTradeExpiryRun,
  tradeExpiryRunning,
  lastModelSnapshotRun,
  modelSnapshotRunning,
  lastOptionScoreRun,
  optionScoreRunning,
  lastEventBulletsRun,
  eventBulletsRunning,
  lastEarningsBackfillRun,
  earningsBackfillRunning,
  lastFmpAnalystFeedRun,
  fmpAnalystFeedRunning,
  lastDeskIngestRun,
  deskIngestRunning,
  lastVoicesIngestRun,
  voicesIngestRunning,
  lastSchwabHealthRun,
  schwabHealthRunning,
  researchOpsRunning,
  lastResearchOpsRun,
  lastRetentionPrune,
  regimeCheckRunning,
  lastRegimeCheckpointRun,
} from "./scheduler/state.js";

export {
  runTradeExpiry,
  runModelSnapshotJob,
  runOptionScoreJob,
  runMorningPrecomputeIfDue,
  runRetentionPruneIfDue,
  runEventBulletsJob,
  runEarningsBackfillJob,
  runFmpAnalystFeedJob,
  runDeskIngestJob,
  runVoicesIngestJob,
  runSchwabHealthJob,
  runResearchOpsJob,
  runRetentionPrune,
  runRegimeCheckpoints,
} from "./scheduler/runners.js";

export { shouldRunRegimeCheckpointsNow } from "./scheduler/timing.js";

export { startScheduler } from "./scheduler/loop.js";
