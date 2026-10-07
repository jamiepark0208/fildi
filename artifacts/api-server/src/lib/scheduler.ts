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
import { eq, desc, inArray } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { db, appConfig, enrichmentRuns } from "@workspace/db";
import { logger } from "./logger.js";
import { runNightlyEnrichment } from "../scripts/nightly-enrichment.js";
import { pruneOldRows } from "./retention.js";
import { rotateApiServerLogIfNeeded } from "./log-rotation.js";
import { resolveExpiredOptionTrades } from "./trade-post-expiry.js";
import { runModelSnapshot, runModelGrading } from "./model-track-record.js";
import { computeAndPersistOptionScores } from "./option-score-snapshots.js";
import { getMarketOpenUtc, isMarketOpen, minutesSinceOpen } from "./market-hours.js";
import { runCheckpoint, CHECKPOINTS_MIN } from "./intraday-regime.js";
import { runEntrySignals } from "./intraday-entry-signals.js";
import { runEventBulletCheck } from "./event-bullets.js";
import { runEarningsHistoryBackfill } from "./earnings-history.js";
import { runFmpAnalystFeedPoll } from "./fmp-analyst-feed.js";
import { ingestDeskCommentaries } from "./desk-commentary.js";
import { getSchwabAccessToken, getSchwabAuthStatus } from "./schwab-auth.js";
import {
  runResearchOpsHealthJob,
  researchOpsRunning,
  lastResearchOpsRun as researchOpsModuleRun,
} from "./research-ops.js";
import { shouldRunRegimeCheckpointsAt } from "./scheduler-catchup.js";

export { shouldRunRegimeCheckpointsAt } from "./scheduler-catchup.js";

// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";
const LAST_RETENTION_PRUNE_KEY = "last_retention_prune";
const LAST_TRADE_EXPIRY_RUN_KEY = "last_trade_expiry_run";
const LAST_MODEL_SNAPSHOT_RUN_KEY = "last_model_snapshot_run";
const LAST_OPTION_SCORE_RUN_KEY = "last_option_score_snapshot_run";
const LAST_EVENT_BULLETS_RUN_KEY = "last_event_bullets_run";
const LAST_EARNINGS_BACKFILL_RUN_KEY = "last_earnings_backfill_run";
const LAST_FMP_ANALYST_FEED_RUN_KEY = "last_fmp_analyst_feed_run";
const LAST_DESK_INGEST_RUN_KEY = "last_desk_commentary_ingest_run";
const LAST_SCHWAB_HEALTH_RUN_KEY = "last_schwab_health_run";
const LAST_RESEARCH_OPS_RUN_KEY = "last_research_ops_health_run";

// Exported so data-health / scheduled-tasks routes can read them without a DB round-trip.
// Hydrated from app_config at startup — see loadPersistedLastRun().
export let lastEnrichmentRun: Date | null = null;
export let enrichmentRunning = false;
// Setter so other modules (e.g. the ad-hoc refetch-queue route) can share this
// mutex with the scheduler — a plain `let` export is read-only outside this file.

/** Keep in-memory stamp aligned with enrichment_runs (Maintain writes there, not only app_config). */
export function noteEnrichmentRunFromDb(at: Date): void {
  if (!lastEnrichmentRun || at.getTime() > lastEnrichmentRun.getTime()) {
    lastEnrichmentRun = at;
  }
}
export function setEnrichmentRunning(v: boolean) { enrichmentRunning = v; }
export let lastTradeExpiryRun: Date | null = null;
export let tradeExpiryRunning = false;
export let lastModelSnapshotRun: Date | null = null;
export let modelSnapshotRunning = false;
export let lastOptionScoreRun: Date | null = null;
export let optionScoreRunning = false;
export let lastEventBulletsRun: Date | null = null;
export let eventBulletsRunning = false;
export let lastEarningsBackfillRun: Date | null = null;
export let earningsBackfillRunning = false;
export let lastFmpAnalystFeedRun: Date | null = null;
export let fmpAnalystFeedRunning = false;
export let lastDeskIngestRun: Date | null = null;
export let deskIngestRunning = false;
export let lastSchwabHealthRun: Date | null = null;
export let schwabHealthRunning = false;
/** Re-export for scheduled-tasks — probe only, never vendor sync. */
export { researchOpsRunning };
export let lastResearchOpsRun: Date | null = null;

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

// Daily precompute (event bullets / earnings / FMP): ~7:00 AM PT so the app is
// ready when you open the Mac (~8 AM). 14:00 UTC ≈ 7:00 AM PDT.
// Catch-up: first heartbeat in 14–16 UTC (7–9 AM PT) if still not run today —
// covers lid-closed at 7:00 then wake at 8.
const DAILY_PRECOMPUTE_HOUR_UTC = 14;
const DAILY_PRECOMPUTE_CATCHUP_END_UTC = 16;

function shouldRunDailyPrecompute(lastRun: Date | null): boolean {
  const now = new Date();
  if (lastRun && isSameUtcDay(lastRun, now)) return false;
  const hour = now.getUTCHours();
  const onSchedule = hour === DAILY_PRECOMPUTE_HOUR_UTC;
  const morningCatchup = hour > DAILY_PRECOMPUTE_HOUR_UTC && hour <= DAILY_PRECOMPUTE_CATCHUP_END_UTC;
  const missedWindow = daysSince(lastRun) > 1.5;
  return onSchedule || morningCatchup || missedWindow;
}

function shouldRunEventBulletsNow(): boolean {
  return shouldRunDailyPrecompute(lastEventBulletsRun);
}

function shouldRunEarningsBackfillNow(): boolean {
  return shouldRunDailyPrecompute(lastEarningsBackfillRun);
}

function shouldRunFmpAnalystFeedNow(): boolean {
  return shouldRunDailyPrecompute(lastFmpAnalystFeedRun);
}

  /** Drive → DB catch-up. Cheap; only files newer than last run. No missed-poll replay. */
  function shouldRunDeskIngestNow(): boolean {
    if (deskIngestRunning) return false;
    if (!lastDeskIngestRun) return true;
    return Date.now() - lastDeskIngestRun.getTime() >= 25 * 60 * 1000;
  }

  /** Proactive access-token refresh + re-auth warning. No market-data pulls. */
  function shouldRunSchwabHealthNow(): boolean {
    if (schwabHealthRunning) return false;
    if (!lastSchwabHealthRun) return true;
    return Date.now() - lastSchwabHealthRun.getTime() >= 6 * 60 * 60 * 1000;
  }

  /** Local WRDS/LSEG cache + LSEG :9000 probe. Never syncs vendors (lane contract). */
  function shouldRunResearchOpsNow(): boolean {
    if (researchOpsRunning) return false;
    if (!lastResearchOpsRun) return true;
    return Date.now() - lastResearchOpsRun.getTime() >= 6 * 60 * 60 * 1000;
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
// so Yahoo bids are live (bid=0 for every contract when closed).
// Catch-up: only Friday during US cash session (16–21 UTC ≈ 9 AM–2 PM PT), not
// overnight — otherwise a schema/API failure retries every 30 min forever.
const MODEL_SNAPSHOT_DAY = 5; // Friday (UTC)
const MODEL_SNAPSHOT_HOUR = 19;
const MODEL_SNAPSHOT_CATCHUP_DAYS = 8;

function shouldRunModelSnapshotNow(): boolean {
  const now = new Date();
  if (lastModelSnapshotRun && isSameUtcDay(lastModelSnapshotRun, now)) return false;
  const onSchedule = now.getUTCDay() === MODEL_SNAPSHOT_DAY && now.getUTCHours() === MODEL_SNAPSHOT_HOUR;
  const fridaySession =
    now.getUTCDay() === MODEL_SNAPSHOT_DAY &&
    now.getUTCHours() >= 16 &&
    now.getUTCHours() <= 21;
  const missedWindow = daysSince(lastModelSnapshotRun) > MODEL_SNAPSHOT_CATCHUP_DAYS;
  return onSchedule || (missedWindow && fridaySession);
}

async function runEnrichment() {
  // Mac LaunchAgent `com.fildi.maintain` owns enrichment scheduling (daily lean +
  // ≥4d full catch-up). Keeping the in-process Sun/Thu job would double-run.
  if (process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" || process.env.DISABLE_SCHEDULER_ENRICHMENT === "true") {
    logger.info("scheduler: enrichment skipped (DISABLE_SCHEDULER_ENRICHMENT) — use maintain LaunchAgent");
    return;
  }
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
/** Manual / admin trigger — same body as the Saturday schedule. */
export async function runTradeExpiry() {
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

/** Manual / admin trigger — same body as the Friday schedule. */
export async function runModelSnapshotJob() {
  if (modelSnapshotRunning) return;
  modelSnapshotRunning = true;
  logger.info("scheduler: starting model accountability snapshot");
  try {
    const result = await runModelSnapshot();
    lastModelSnapshotRun = new Date();
    await setConfigDate(LAST_MODEL_SNAPSHOT_RUN_KEY, lastModelSnapshotRun);
    // Dual-write also refreshed option scores — mark that job done today.
    lastOptionScoreRun = lastModelSnapshotRun;
    await setConfigDate(LAST_OPTION_SCORE_RUN_KEY, lastOptionScoreRun).catch(() => {});
    try {
      mkdirSync("/tmp/fildi-logs", { recursive: true });
      writeFileSync(
        "/tmp/fildi-logs/model-snapshot-last.json",
        JSON.stringify({
          ts: lastModelSnapshotRun.toISOString(),
          degraded: result.degraded,
          recs: result.recs,
          liveBidRecs: result.liveBidRecs,
          failures: result.failures,
        }),
      );
    } catch { /* best-effort status file */ }
    if (result.degraded) {
      logger.warn(result, "scheduler: model snapshot DEGRADED (many non-live bids)");
    }
    logger.info(result, "scheduler: model accountability snapshot complete");
  } catch (err) {
    logger.error({ err }, "scheduler: model accountability snapshot failed");
  } finally {
    modelSnapshotRunning = false;
  }
}

// Overall options rankings: Mon–Fri 19:00 UTC (market open Mon–Thu ET / Fri open) —
// Yahoo bids live. Catch-up once/day if missed. Uses premium-IV candidate filter (~100).
const OPTION_SCORE_HOUR = 19;
const OPTION_SCORE_CATCHUP_DAYS = 2;

function shouldRunOptionScoreNow(): boolean {
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun … 5=Fri
  // Friday: model snapshot dual-writes option_score_snapshots — skip standalone job.
  if (dow === MODEL_SNAPSHOT_DAY) return false;
  const weekday = dow >= 1 && dow <= 5;
  const onSchedule = weekday && now.getUTCHours() === OPTION_SCORE_HOUR;
  const missedWindow = daysSince(lastOptionScoreRun) > OPTION_SCORE_CATCHUP_DAYS;
  return (onSchedule || missedWindow) && !(lastOptionScoreRun && isSameUtcDay(lastOptionScoreRun, now));
}

/** Manual / admin trigger — Overall option score persistence. */
export async function runOptionScoreJob() {
  if (optionScoreRunning) return;
  optionScoreRunning = true;
  logger.info("scheduler: starting option score snapshots (Overall rankings)");
  try {
    await computeAndPersistOptionScores();
    lastOptionScoreRun = new Date();
    await setConfigDate(LAST_OPTION_SCORE_RUN_KEY, lastOptionScoreRun);
    logger.info("scheduler: option score snapshots complete");
  } catch (err) {
    logger.error({ err }, "scheduler: option score snapshots failed");
  } finally {
    optionScoreRunning = false;
  }
}

/** Manual / admin trigger — daily event-bullet precompute. */
export async function runEventBulletsJob() {
  if (eventBulletsRunning) return;
  eventBulletsRunning = true;
  logger.info("scheduler: starting event-bullets trigger check");
  try {
    await runEventBulletCheck();
    lastEventBulletsRun = new Date();
    await setConfigDate(LAST_EVENT_BULLETS_RUN_KEY, lastEventBulletsRun);
    logger.info("scheduler: event-bullets trigger check complete");
  } catch (err) {
    logger.error({ err }, "scheduler: event-bullets trigger check failed");
  } finally {
    eventBulletsRunning = false;
  }
}

/** Manual / admin trigger — capped earnings-history backfill. */
export async function runEarningsBackfillJob() {
  if (earningsBackfillRunning) return;
  earningsBackfillRunning = true;
  logger.info("scheduler: starting earnings history backfill");
  try {
    await runEarningsHistoryBackfill("scheduled");
    lastEarningsBackfillRun = new Date();
    await setConfigDate(LAST_EARNINGS_BACKFILL_RUN_KEY, lastEarningsBackfillRun);
    logger.info("scheduler: earnings history backfill complete");
  } catch (err) {
    logger.error({ err }, "scheduler: earnings history backfill failed");
  } finally {
    earningsBackfillRunning = false;
  }
}

/** Manual / admin trigger — FMP grades/price-target tape archive. */
export async function runFmpAnalystFeedJob() {
  if (fmpAnalystFeedRunning) return;
  fmpAnalystFeedRunning = true;
  logger.info("scheduler: starting fmp analyst feed poll");
  try {
    const result = await runFmpAnalystFeedPoll();
    lastFmpAnalystFeedRun = new Date();
    await setConfigDate(LAST_FMP_ANALYST_FEED_RUN_KEY, lastFmpAnalystFeedRun);
    logger.info(result, "scheduler: fmp analyst feed poll complete");
  } catch (err) {
    logger.error({ err }, "scheduler: fmp analyst feed poll failed");
  } finally {
    fmpAnalystFeedRunning = false;
  }
}

/**
 * FactSet desk emails: Drive folder → desk_commentaries.
 * Only files mtime ≥ last run (or last 48h on first run). No full-history replay.
 */
export async function runDeskIngestJob() {
  if (deskIngestRunning) return;
  deskIngestRunning = true;
  logger.info("scheduler: starting desk commentary ingest");
  try {
    const sinceMs = lastDeskIngestRun
      ? lastDeskIngestRun.getTime() - 5 * 60 * 1000
      : Date.now() - 48 * 60 * 60 * 1000;
    const result = await ingestDeskCommentaries({ sinceMs });
    lastDeskIngestRun = new Date();
    await setConfigDate(LAST_DESK_INGEST_RUN_KEY, lastDeskIngestRun);
    logger.info(result, "scheduler: desk commentary ingest complete");
  } catch (err) {
    logger.error({ err }, "scheduler: desk commentary ingest failed");
  } finally {
    deskIngestRunning = false;
  }
}

/**
 * Schwab OAuth health: refresh access token (keeps file warm) + warn before 7d refresh expiry.
 * Does NOT pull market data — zero RPM cost beyond the token endpoint.
 */
export async function runSchwabHealthJob() {
  if (schwabHealthRunning) return;
  schwabHealthRunning = true;
  logger.info("scheduler: starting schwab auth health check");
  try {
    const before = getSchwabAuthStatus();
    if (!before.configured) {
      logger.info("scheduler: schwab health skipped — credentials not configured");
    } else if (!before.hasTokens) {
      logger.warn("scheduler: schwab health — no tokens; run scripts/schwab-oauth.mjs");
    } else {
      const token = await getSchwabAccessToken();
      const after = getSchwabAuthStatus();
      if (!token) {
        logger.warn(
          { err: after.lastError, refreshDaysLeft: after.refreshDaysLeft },
          "scheduler: schwab health — access refresh failed; re-run oauth if refresh expired",
        );
      } else if (after.refreshDaysLeft != null && after.refreshDaysLeft < 2) {
        logger.warn(
          { refreshDaysLeft: after.refreshDaysLeft },
          "scheduler: schwab refresh token nearing expiry — re-run scripts/schwab-oauth.mjs",
        );
      } else {
        logger.info(
          { refreshDaysLeft: after.refreshDaysLeft, accessValid: after.accessValid },
          "scheduler: schwab auth healthy",
        );
      }
    }
    lastSchwabHealthRun = new Date();
    await setConfigDate(LAST_SCHWAB_HEALTH_RUN_KEY, lastSchwabHealthRun);
  } catch (err) {
    logger.error({ err }, "scheduler: schwab health check failed");
  } finally {
    schwabHealthRunning = false;
  }
}

/**
 * Research ops health — Schwab-analog for WRDS/LSEG.
 * Probes local sync_state + LSEG desktop TCP. Never runs sync_*.py / never burns quota.
 */
export async function runResearchOpsJob() {
  logger.info("scheduler: starting research ops health check");
  try {
    await runResearchOpsHealthJob();
    lastResearchOpsRun = researchOpsModuleRun ?? new Date();
    await setConfigDate(LAST_RESEARCH_OPS_RUN_KEY, lastResearchOpsRun);
  } catch (err) {
    logger.error({ err }, "scheduler: research ops health check failed");
  }
}

// Runs at most once/day, independent of the enrichment window — table/log growth
// from per-request activity doesn't need to wait for a biweekly job.
/** Manual / admin trigger — daily table/log prune. */
export async function runRetentionPrune() {
  try {
    await pruneOldRows(); // includes filesystem log prune
    lastRetentionPrune = new Date();
    await setConfigDate(LAST_RETENTION_PRUNE_KEY, lastRetentionPrune).catch(err =>
      logger.error({ err }, "scheduler: failed to persist retention-prune timestamp"),
    );
  } catch (err) {
    logger.error({ err }, "scheduler: retention prune failed — lastRun not advanced");
  }
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

// Separate, finer heartbeat for the intraday regime banner — checkpoints are
// 15 min apart, tighter than the 30-min cadence the other jobs use, so this
// runs on its own interval rather than changing CHECK_INTERVAL_MS for everything else.
/**
 * Manual / admin trigger. During RTH uses live minutes-since-open.
 * After the close on a trading day, still catch up any missing checkpoints
 * (Scheduled Tasks "Run" at night must not be a silent no-op).
 */
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
    }
    lastRegimeCheckpointRun = new Date();
  } finally {
    regimeCheckRunning = false;
  }
}

export async function startScheduler(): Promise<void> {
  [lastEnrichmentRun, lastRetentionPrune, lastTradeExpiryRun, lastModelSnapshotRun, lastOptionScoreRun, lastEventBulletsRun, lastEarningsBackfillRun, lastFmpAnalystFeedRun, lastDeskIngestRun, lastSchwabHealthRun, lastResearchOpsRun] = await Promise.all([
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
    getConfigDate(LAST_OPTION_SCORE_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted option-score last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_EVENT_BULLETS_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted event-bullets last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_EARNINGS_BACKFILL_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted earnings-backfill last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_FMP_ANALYST_FEED_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted fmp-analyst-feed last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_DESK_INGEST_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted desk-ingest last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_SCHWAB_HEALTH_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted schwab-health last-run, dedupe guard starts cold");
      return null;
    }),
    getConfigDate(LAST_RESEARCH_OPS_RUN_KEY).catch(err => {
      logger.error({ err }, "scheduler: failed to load persisted research-ops last-run, dedupe guard starts cold");
      return null;
    }),
  ]);

  // Prefer enrichment_runs (Maintain daily) over app_config — Maintain used to
  // write only enrichment_runs, leaving Data Health stuck on an old scheduler stamp.
  try {
    const rows = await db
      .select({ finishedAt: enrichmentRuns.finishedAt })
      .from(enrichmentRuns)
      .where(inArray(enrichmentRuns.status, ["success", "partial"]))
      .orderBy(desc(enrichmentRuns.finishedAt))
      .limit(1);
    const at = rows[0]?.finishedAt ? new Date(rows[0].finishedAt as unknown as string) : null;
    if (at) noteEnrichmentRunFromDb(at);
  } catch (err) {
    logger.warn({ err }, "scheduler: enrichment_runs hydrate skipped");
  }

  setInterval(() => {
    if (shouldRunEnrichmentNow()) runEnrichment();
    if (shouldRunRetentionNow()) runRetentionPrune();
    if (shouldRunTradeExpiryNow()) runTradeExpiry();
    if (shouldRunModelSnapshotNow()) runModelSnapshotJob();
    if (shouldRunOptionScoreNow()) runOptionScoreJob();
    if (shouldRunEventBulletsNow()) runEventBulletsJob();
    if (shouldRunEarningsBackfillNow()) runEarningsBackfillJob();
    if (shouldRunFmpAnalystFeedNow()) runFmpAnalystFeedJob();
    if (shouldRunDeskIngestNow()) runDeskIngestJob();
    if (shouldRunSchwabHealthNow()) runSchwabHealthJob();
    if (shouldRunResearchOpsNow()) runResearchOpsJob();
    // Size-gated, not day-gated — checks every tick but only acts past the 20MB threshold.
    rotateApiServerLogIfNeeded();
  }, CHECK_INTERVAL_MS);

  setInterval(() => {
    // RTH + after-close catch-up when the host missed the session (see shouldRunRegimeCheckpointsAt).
    if (shouldRunRegimeCheckpointsNow()) runRegimeCheckpoints();
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
