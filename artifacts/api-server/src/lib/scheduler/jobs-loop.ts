/** Scheduler module (A332 split). */
import { eq, desc, inArray } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { db, appConfig, enrichmentRuns } from "@workspace/db";
import { logger } from "../logger.js";
import { runNightlyEnrichment } from "../../scripts/nightly-enrichment.js";
import { pruneOldRows } from "../retention.js";
import { rotateApiServerLogIfNeeded } from "../log-rotation.js";
import { resolveExpiredOptionTrades } from "../trade-post-expiry.js";
import { runModelSnapshot, runModelGrading } from "../model-track-record.js";
import { computeAndPersistOptionScores } from "../option-score-snapshots.js";
import { etDateKey, getMarketOpenUtc, isMarketOpen, minutesSinceOpen } from "../market-hours.js";
import { runCheckpoint, CHECKPOINTS_MIN } from "../intraday-regime.js";
import { runEntrySignals } from "../intraday-entry-signals.js";
import { runModelListIntradayCheck } from "../model-list-intraday.js";
import { runEventBulletCheck } from "../event-bullets.js";
import { runEarningsHistoryBackfill } from "../earnings-history.js";
import { runFmpAnalystFeedPoll } from "../fmp-analyst-feed.js";
import { ingestDeskCommentaries } from "../desk-commentary.js";
import { extractPendingDeskFacts } from "../desk-facts.js";
import { resolvePendingDeskFacts } from "../desk-fact-resolve.js";
import { ingestFedSpeeches } from "../figure-views-ingest.js";
import { autoResolveOpenViews } from "../figure-views-auto-resolve.js";
import { getSchwabAccessToken, getSchwabAuthStatus } from "../schwab-auth.js";
import {
  runResearchOpsHealthJob,
  researchOpsRunning,
  lastResearchOpsRun as researchOpsModuleRun,
} from "../research-ops.js";
import {
  startSchwab1mPoller,
  runSchwab1mPoll,
  runSchwab1mBackfill,
  schwab1mPollRunning,
  lastSchwab1mPollRun,
} from "../schwab-1m-poll.js";

export { runSchwab1mPoll, runSchwab1mBackfill, schwab1mPollRunning, lastSchwab1mPollRun };
import {
  shouldRunRegimeCheckpointsAt,
  shouldRunEnrichmentAt,
  shouldRunRetentionAt,
  shouldRunDailyPrecomputeAt,
  shouldRunOptionScoreAt,
  pickFresherStamp,
  parseAttemptCount,
  nextAttemptCount,
  type RunAttempt,
  NO_ATTEMPT,
} from "../scheduler-catchup.js";
import { getHostRole, isPublicHost, PUBLIC_HOST_SKIP } from "../host-role.js";
import { loadDate, refreshPersistedLastRuns } from "./state-guards.js";
import {
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
  LAST_EVENT_BULLETS_RUN_KEY,
  LAST_EARNINGS_BACKFILL_RUN_KEY,
  LAST_FMP_ANALYST_FEED_RUN_KEY,
  LAST_RETENTION_PRUNE_KEY,
  lastEnrichmentRun,
  lastRetentionPrune,
  lastTradeExpiryRun,
  lastModelSnapshotRun,
  runEnrichment,
  shouldRunOptionScoreNow,
} from "./state-guards.js";
import {
  shouldRunEnrichmentNow,
  shouldRunRetentionNow,
  shouldRunTradeExpiryNow,
  shouldRunModelSnapshotNow,
  shouldRunEventBulletsNow,
  shouldRunEarningsBackfillNow,
  shouldRunFmpAnalystFeedNow,
  shouldRunDeskIngestNow,
  shouldRunVoicesIngestNow,
  shouldRunSchwabHealthNow,
  shouldRunResearchOpsNow,
  SCHEDULE_HOUR,
  TRADE_EXPIRY_DAY,
  TRADE_EXPIRY_HOUR,
  MODEL_SNAPSHOT_DAY,
  MODEL_SNAPSHOT_HOUR,
  CHECK_INTERVAL_MS,
  STARTUP_TICK_MS,
} from "./schedule-guards.js";

/** Maintain's morning chain: run each precompute job unless it already ran today (ET day — a 6 PM PT run must not count
 *  for tomorrow). Returns the jobs that ran. Used by scripts/run-morning-precompute.ts so maintain + the API fallback
 *  never run the same job twice. */
export async function runMorningPrecomputeIfDue(force = false): Promise<string[]> {
  const jobs: [string, () => Promise<void>][] = [
    [LAST_EVENT_BULLETS_RUN_KEY, runEventBulletsJob],
    [LAST_EARNINGS_BACKFILL_RUN_KEY, runEarningsBackfillJob],
    [LAST_FMP_ANALYST_FEED_RUN_KEY, runFmpAnalystFeedJob],
  ];
  const ran: string[] = [];
  for (const [key, job] of jobs) {
    const last = await loadDate(key);
    if (!force && last && etDateKey(last) === etDateKey()) {
      logger.info({ key, last }, "morning-precompute: already ran today (ET) — skip");
      continue;
    }
    await job();
    ran.push(key);
  }
  return ran;
}

/** Maintain's retention prune: stamps the same key the API uses (Settings shows one last-run), skips if done today (ET). */
export async function runRetentionPruneIfDue(force = false): Promise<boolean> {
  const last = await loadDate(LAST_RETENTION_PRUNE_KEY);
  if (!force && last && etDateKey(last) === etDateKey()) return false;
  await runRetentionPrune();
  return true;
}

export let regimeCheckRunning = false;
export let lastRegimeCheckpointRun: Date | null = null;

/** RTH + after-close catch-up when the host missed the session. */
export function shouldRunRegimeCheckpointsNow(now: Date = new Date()): boolean {
  return shouldRunRegimeCheckpointsAt({
    isOpen: isMarketOpen(now),
    marketOpenUtc: getMarketOpenUtc(now),
    now,
    lastRun: lastRegimeCheckpointRun,
    lastCheckpointMin: CHECKPOINTS_MIN[CHECKPOINTS_MIN.length - 1]!,
  });
}

export async function runRegimeCheckpoints() {
  if (regimeCheckRunning) return;
  let minSinceOpen = minutesSinceOpen();
  if (minSinceOpen == null) {
    const open = getMarketOpenUtc();
    if (!open) return; // weekend / holiday
    const elapsed = (Date.now() - open.getTime()) / 60_000;
    if (elapsed < 0) return; // before open
    // Cap high enough to cover the last checkpoint (330m) after close.
    minSinceOpen = Math.max(elapsed, CHECKPOINTS_MIN[CHECKPOINTS_MIN.length - 1]!);
  }
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
      // Model List re-check rides the same checkpoints, in session only (fire-and-forget child process).
      if (!isPublicHost() && minutesSinceOpen() != null) runModelListIntradayCheck();
    }
    lastRegimeCheckpointRun = new Date();
  } finally {
    regimeCheckRunning = false;
  }
}

export function runDueJobs(): void {
  const pub = isPublicHost();
  if (shouldRunEnrichmentNow()) runEnrichment();
  if (shouldRunRetentionNow()) runRetentionPrune();
  if (!pub && shouldRunTradeExpiryNow()) runTradeExpiry();
  if (shouldRunModelSnapshotNow()) runModelSnapshotJob();
  if (shouldRunOptionScoreNow()) runOptionScoreJob();
  if (!pub && shouldRunEventBulletsNow()) runEventBulletsJob(); // Anthropic — off on public shadow
  if (shouldRunEarningsBackfillNow()) runEarningsBackfillJob();
  if (shouldRunFmpAnalystFeedNow()) runFmpAnalystFeedJob();
  if (!pub && shouldRunDeskIngestNow()) runDeskIngestJob();
  if (!pub && shouldRunVoicesIngestNow()) runVoicesIngestJob(); // LLM path — off on public shadow
  if (!pub && shouldRunSchwabHealthNow()) runSchwabHealthJob();
  if (!pub && shouldRunResearchOpsNow()) runResearchOpsJob();
  // Size-gated, not day-gated — checks every tick but only acts past the 20MB threshold.
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
    // RTH + after-close catch-up when the host missed the session (see shouldRunRegimeCheckpointsAt).
    if (shouldRunRegimeCheckpointsNow()) runRegimeCheckpoints();
  }, 60 * 1000);

  // A194 / A241: Schwab 1m stays Mac-only (no brokerage token on public VM).
  if (!isPublicHost()) startSchwab1mPoller();

  logger.info(
    {
      hostRole: role,
      publicSkip: isPublicHost() ? PUBLIC_HOST_SKIP : null,
      scheduleDays: ["Sunday", "Thursday"], scheduleHourUtc: SCHEDULE_HOUR,
      tradeExpiryDay: "Saturday", tradeExpiryHourUtc: TRADE_EXPIRY_HOUR,
      modelSnapshotDay: "Friday", modelSnapshotHourUtc: MODEL_SNAPSHOT_HOUR,
      lastEnrichmentRun, lastRetentionPrune, lastTradeExpiryRun, lastModelSnapshotRun,
    },
    "scheduler: enrichment + retention + trade-expiry schedule registered",
  );
}
