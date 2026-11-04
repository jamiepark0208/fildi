import {
  shouldRunRegimeCheckpointsAt,
  shouldRunEnrichmentAt,
  shouldRunRetentionAt,
  shouldRunDailyPrecomputeAt,
  shouldRunOptionScoreAt,
} from "../scheduler-catchup.js";
import { isMarketOpen, getMarketOpenUtc } from "../market-hours.js";
import { CHECKPOINTS_MIN } from "../intraday-regime.js";
import { researchOpsRunning } from "../research-ops.js";
import { attempts } from "./config.js";
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
  voicesIngestRunning,
  lastVoicesIngestRun,
  deskIngestRunning,
  schwabHealthRunning,
  lastSchwabHealthRun,
  lastResearchOpsRun,
  lastModelSnapshotFailure,
  lastRegimeCheckpointRun,
} from "./state.js";

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function daysSince(d: Date | null): number {
  if (!d) return Infinity;
  return (Date.now() - d.getTime()) / (24 * 60 * 60 * 1000);
}

export const SCHEDULE_HOUR = 2;
export const TRADE_EXPIRY_DAY = 6;
export const TRADE_EXPIRY_HOUR = 2;
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const STARTUP_TICK_MS = 60 * 1000;
export const MODEL_SNAPSHOT_HOUR = 19;

const MAINTAIN_OWNED =
  process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" || process.env.DISABLE_SCHEDULER_ENRICHMENT === "true";

const TRADE_EXPIRY_CATCHUP_DAYS = 8;
const MODEL_SNAPSHOT_DAY = 5;
const MODEL_SNAPSHOT_CATCHUP_DAYS = 7;

export function shouldRunEnrichmentNow(): boolean {
  return shouldRunEnrichmentAt(lastEnrichmentRun, new Date(), attempts.enrichment);
}

export function shouldRunRetentionNow(): boolean {
  if (MAINTAIN_OWNED && new Date().getUTCHours() < 20) return false;
  return shouldRunRetentionAt(lastRetentionPrune, new Date(), attempts.retention);
}

export function shouldRunEventBulletsNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastEventBulletsRun, new Date(), attempts.eventBullets, MAINTAIN_OWNED);
}

export function shouldRunEarningsBackfillNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastEarningsBackfillRun, new Date(), attempts.earnings, MAINTAIN_OWNED);
}

export function shouldRunFmpAnalystFeedNow(): boolean {
  return shouldRunDailyPrecomputeAt(lastFmpAnalystFeedRun, new Date(), attempts.fmp, MAINTAIN_OWNED);
}

export function shouldRunDeskIngestNow(): boolean {
  if (deskIngestRunning) return false;
  if (!lastDeskIngestRun) return true;
  return Date.now() - lastDeskIngestRun.getTime() >= 25 * 60 * 1000;
}

export function shouldRunVoicesIngestNow(): boolean {
  if (voicesIngestRunning) return false;
  if (!lastVoicesIngestRun) return true;
  return Date.now() - lastVoicesIngestRun.getTime() >= 6 * 60 * 60 * 1000;
}

export function shouldRunSchwabHealthNow(): boolean {
  if (schwabHealthRunning) return false;
  if (!lastSchwabHealthRun) return true;
  return Date.now() - lastSchwabHealthRun.getTime() >= 6 * 60 * 60 * 1000;
}

export function shouldRunResearchOpsNow(): boolean {
  if (researchOpsRunning) return false;
  if (!lastResearchOpsRun) return true;
  return Date.now() - lastResearchOpsRun.getTime() >= 6 * 60 * 60 * 1000;
}

export function shouldRunTradeExpiryNow(): boolean {
  const now = new Date();
  const onSchedule = now.getUTCDay() === TRADE_EXPIRY_DAY && now.getUTCHours() === TRADE_EXPIRY_HOUR;
  const missedWindow = daysSince(lastTradeExpiryRun) > TRADE_EXPIRY_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastTradeExpiryRun && isSameUtcDay(lastTradeExpiryRun, now));
}

export function shouldRunModelSnapshotNow(): boolean {
  const now = new Date();
  if (lastModelSnapshotRun && isSameUtcDay(lastModelSnapshotRun, now)) return false;
  if (lastModelSnapshotFailure && now.getTime() - lastModelSnapshotFailure.getTime() < 30 * 60 * 1000) return false;
  const onSchedule = now.getUTCDay() === MODEL_SNAPSHOT_DAY && now.getUTCHours() === MODEL_SNAPSHOT_HOUR;
  const fridaySession =
    now.getUTCDay() === MODEL_SNAPSHOT_DAY &&
    now.getUTCHours() >= 16 &&
    now.getUTCHours() <= 21;
  const weekdaySession = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && now.getUTCHours() >= 16 && now.getUTCHours() <= 19;
  const missedWindow = daysSince(lastModelSnapshotRun) > MODEL_SNAPSHOT_CATCHUP_DAYS;
  return onSchedule || (missedWindow && (fridaySession || weekdaySession));
}

export function shouldRunOptionScoreNow(): boolean {
  return shouldRunOptionScoreAt(lastOptionScoreRun, new Date(), attempts.optionScore);
}

export function shouldRunRegimeCheckpointsNow(now: Date = new Date()): boolean {
  return shouldRunRegimeCheckpointsAt({
    isOpen: isMarketOpen(now),
    marketOpenUtc: getMarketOpenUtc(now),
    now,
    lastRun: lastRegimeCheckpointRun,
    lastCheckpointMin: CHECKPOINTS_MIN[CHECKPOINTS_MIN.length - 1]!,
  });
}
