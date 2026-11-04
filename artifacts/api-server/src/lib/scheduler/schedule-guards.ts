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
import {
  lastEnrichmentRun,
  lastRetentionPrune,
  lastTradeExpiryRun,
  lastModelSnapshotRun,
  lastOptionScoreRun,
  lastEventBulletsRun,
  lastEarningsBackfillRun,
  lastFmpAnalystFeedRun,
  lastDeskIngestRun,
  lastVoicesIngestRun,
  lastSchwabHealthRun,
  lastResearchOpsRun,
  lastModelSnapshotFailure,
  attempts,
  deskIngestRunning,
  voicesIngestRunning,
  schwabHealthRunning,
  noteFailedAttempt,
  daysSince,
  isSameUtcDay,
} from "./state-guards.js";

export const SCHEDULE_HOUR = 2;
export const TRADE_EXPIRY_DAY = 6; // Saturday (UTC) — the day after Friday's typical option expiry
export const TRADE_EXPIRY_HOUR = 2;
// 5 min (was 30, and no tick at startup): the dev API runs under `tsx --watch` and restarts on every agent save — 9× between
// 11:52 and 13:04 PT on 10-20 — so a 30-min first tick never came and the 19:00 UTC option scan was skipped. Checks are cheap.
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const STARTUP_TICK_MS = 60 * 1000; // first check 1 min after boot (lets a burst of restarts settle)

// Sun/Thu 02:00 UTC and the 4-day catch-up live in shouldRunEnrichmentAt.
export function shouldRunEnrichmentNow(): boolean {
  return shouldRunEnrichmentAt(lastEnrichmentRun, new Date(), attempts.enrichment);
}

export function shouldRunRetentionNow(): boolean {
  // Maintain prunes at 7 AM PT and stamps last_retention_prune → this only fires if maintain missed the day (after 19 UTC).
  if (MAINTAIN_OWNED && new Date().getUTCHours() < 20) return false;
  return shouldRunRetentionAt(lastRetentionPrune, new Date(), attempts.retention);
}

// Daily precompute: 14:00 UTC, catch-up through 16:00, or last success older than 1.5 days.
// Hours live in shouldRunDailyPrecomputeAt.
// Mac: com.fildi.maintain owns the morning chain (enrichment, precompute, retention) → the API is a later fallback only.
export const MAINTAIN_OWNED =
  process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" || process.env.DISABLE_SCHEDULER_ENRICHMENT === "true";

export function shouldRunEventBulletsNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastEventBulletsRun, new Date(), attempts.eventBullets, MAINTAIN_OWNED);
}

export function shouldRunEarningsBackfillNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastEarningsBackfillRun, new Date(), attempts.earnings, MAINTAIN_OWNED);
}

export function shouldRunFmpAnalystFeedNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastFmpAnalystFeedRun, new Date(), attempts.fmp, MAINTAIN_OWNED);
}

/** Drive → DB catch-up. Cheap; only files newer than last run. No missed-poll replay. */
export function shouldRunDeskIngestNow(): boolean {
  if (deskIngestRunning) return false;
  if (!lastDeskIngestRun) return true;
  return Date.now() - lastDeskIngestRun.getTime() >= 25 * 60 * 1000;
}

/** A85 Fed speeches RSS → figure_views. Cheap; 6h cadence. */
export function shouldRunVoicesIngestNow(): boolean {
  if (voicesIngestRunning) return false;
  if (!lastVoicesIngestRun) return true;
  return Date.now() - lastVoicesIngestRun.getTime() >= 6 * 60 * 60 * 1000;
}

/** Proactive access-token refresh + re-auth warning. No market-data pulls. */
export function shouldRunSchwabHealthNow(): boolean {
  if (schwabHealthRunning) return false;
  if (!lastSchwabHealthRun) return true;
  return Date.now() - lastSchwabHealthRun.getTime() >= 6 * 60 * 60 * 1000;
}

/** Local WRDS/LSEG cache + LSEG desktop-proxy probe (.portInUse / :9000/:9001). Never syncs vendors (lane contract). */
export function shouldRunResearchOpsNow(): boolean {
  if (researchOpsRunning) return false;
  if (!lastResearchOpsRun) return true;
  return Date.now() - lastResearchOpsRun.getTime() >= 6 * 60 * 60 * 1000;
}

// Weekly (Saturday) cadence — same missed-window risk as enrichment, so apply the
// same catch-up guard rather than depending entirely on the lazy /feed/posts fallback.
const TRADE_EXPIRY_CATCHUP_DAYS = 8;

export function shouldRunTradeExpiryNow(): boolean {
  const now = new Date();
  const onSchedule = now.getUTCDay() === TRADE_EXPIRY_DAY && now.getUTCHours() === TRADE_EXPIRY_HOUR;
  const missedWindow = daysSince(lastTradeExpiryRun) > TRADE_EXPIRY_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastTradeExpiryRun && isSameUtcDay(lastTradeExpiryRun, now));
}

// Model accountability snapshot: Friday 19:00–19:59 UTC — market is OPEN (15:00 ET),
// so Yahoo bids are live (bid=0 for every contract when closed).
// Catch-up: only Friday during US cash session (16–21 UTC ≈ 9 AM–2 PM PT), not
// overnight — otherwise a schema/API failure retries every 30 min forever.
export const MODEL_SNAPSHOT_DAY = 5; // Friday (UTC)
export const MODEL_SNAPSHOT_HOUR = 19;
const MODEL_SNAPSHOT_CATCHUP_DAYS = 7;



export function shouldRunModelSnapshotNow(): boolean {
  const now = new Date();
  if (lastModelSnapshotRun && isSameUtcDay(lastModelSnapshotRun, now)) return false;
  if (lastModelSnapshotFailure && now.getTime() - lastModelSnapshotFailure.getTime() < 30 * 60 * 1000) return false;
  const onSchedule = now.getUTCDay() === MODEL_SNAPSHOT_DAY && now.getUTCHours() === MODEL_SNAPSHOT_HOUR;
  const fridaySession =
    now.getUTCDay() === MODEL_SNAPSHOT_DAY &&
    now.getUTCHours() >= 16 &&
    now.getUTCHours() <= 21;
  // Was: missed > 8 days AND Friday → one missed Friday (10-16) meant no snapshot until 10-23+. Now any weekday in session.
  const weekdaySession = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && now.getUTCHours() >= 16 && now.getUTCHours() <= 19;
  const missedWindow = daysSince(lastModelSnapshotRun) > MODEL_SNAPSHOT_CATCHUP_DAYS;
  return onSchedule || (missedWindow && (fridaySession || weekdaySession));
}
