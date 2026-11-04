import { rotateApiServerLogIfNeeded } from "../log-rotation.js";
import { logger } from "../logger.js";
import { startSchwab1mPoller } from "../schwab-1m-poll.js";
import { getHostRole, isPublicHost, PUBLIC_HOST_SKIP } from "../host-role.js";
import { refreshPersistedLastRuns } from "./persist.js";
import {
  shouldRunEnrichmentNow,
  shouldRunRetentionNow,
  shouldRunTradeExpiryNow,
  shouldRunModelSnapshotNow,
  shouldRunOptionScoreNow,
  shouldRunEventBulletsNow,
  shouldRunEarningsBackfillNow,
  shouldRunFmpAnalystFeedNow,
  shouldRunDeskIngestNow,
  shouldRunVoicesIngestNow,
  shouldRunSchwabHealthNow,
  shouldRunResearchOpsNow,
  shouldRunRegimeCheckpointsNow,
  SCHEDULE_HOUR,
  TRADE_EXPIRY_HOUR,
  CHECK_INTERVAL_MS,
  STARTUP_TICK_MS,
  MODEL_SNAPSHOT_HOUR,
} from "./timing.js";
import {
  runEnrichment,
  runTradeExpiry,
  runModelSnapshotJob,
  runOptionScoreJob,
  runEventBulletsJob,
  runEarningsBackfillJob,
  runFmpAnalystFeedJob,
  runDeskIngestJob,
  runVoicesIngestJob,
  runSchwabHealthJob,
  runResearchOpsJob,
  runRetentionPrune,
  runRegimeCheckpoints,
} from "./runners.js";
import {
  lastEnrichmentRun,
  lastRetentionPrune,
  lastTradeExpiryRun,
  lastModelSnapshotRun,
} from "./state.js";

function runDueJobs(): void {
  const pub = isPublicHost();
  if (shouldRunEnrichmentNow()) void runEnrichment();
  if (shouldRunRetentionNow()) void runRetentionPrune();
  if (!pub && shouldRunTradeExpiryNow()) void runTradeExpiry();
  if (shouldRunModelSnapshotNow()) void runModelSnapshotJob();
  if (shouldRunOptionScoreNow()) void runOptionScoreJob();
  if (!pub && shouldRunEventBulletsNow()) void runEventBulletsJob();
  if (shouldRunEarningsBackfillNow()) void runEarningsBackfillJob();
  if (shouldRunFmpAnalystFeedNow()) void runFmpAnalystFeedJob();
  if (!pub && shouldRunDeskIngestNow()) void runDeskIngestJob();
  if (!pub && shouldRunVoicesIngestNow()) void runVoicesIngestJob();
  if (!pub && shouldRunSchwabHealthNow()) void runSchwabHealthJob();
  if (!pub && shouldRunResearchOpsNow()) void runResearchOpsJob();
  rotateApiServerLogIfNeeded();
}

export async function startScheduler(): Promise<void> {
  await refreshPersistedLastRuns();
  const role = getHostRole();

  const tick = () => {
    void refreshPersistedLastRuns()
      .then(() => runDueJobs())
      .catch((err) => logger.error({ err }, "scheduler: tick failed"));
  };
  setTimeout(tick, STARTUP_TICK_MS);
  setInterval(tick, CHECK_INTERVAL_MS);

  setInterval(() => {
    if (shouldRunRegimeCheckpointsNow()) void runRegimeCheckpoints();
  }, 60 * 1000);

  if (!isPublicHost()) startSchwab1mPoller();

  logger.info(
    {
      hostRole: role,
      publicSkip: isPublicHost() ? PUBLIC_HOST_SKIP : null,
      scheduleDays: ["Sunday", "Thursday"],
      scheduleHourUtc: SCHEDULE_HOUR,
      tradeExpiryDay: "Saturday",
      tradeExpiryHourUtc: TRADE_EXPIRY_HOUR,
      modelSnapshotDay: "Friday",
      modelSnapshotHourUtc: MODEL_SNAPSHOT_HOUR,
      lastEnrichmentRun,
      lastRetentionPrune,
      lastTradeExpiryRun,
      lastModelSnapshotRun,
    },
    "scheduler: enrichment + retention + trade-expiry schedule registered",
  );
}
