import { writeFileSync, mkdirSync } from 'node:fs';
import { logger } from '../logger.js';
import { runNightlyEnrichment } from '../../scripts/nightly-enrichment.js';
import { pruneOldRows } from '../retention.js';
import { resolveExpiredOptionTrades } from '../trade-post-expiry.js';
import { runModelSnapshot, runModelGrading } from '../model-track-record.js';
import { computeAndPersistOptionScores } from '../option-score-snapshots.js';
import { etDateKey, getMarketOpenUtc, minutesSinceOpen } from '../market-hours.js';
import { runCheckpoint, CHECKPOINTS_MIN } from '../intraday-regime.js';
import { runEntrySignals } from '../intraday-entry-signals.js';
import { runModelListIntradayCheck } from '../model-list-intraday.js';
import { runEventBulletCheck } from '../event-bullets.js';
import { runEarningsHistoryBackfill } from '../earnings-history.js';
import { runFmpAnalystFeedPoll } from '../fmp-analyst-feed.js';
import { ingestDeskCommentaries } from '../desk-commentary.js';
import { extractPendingDeskFacts } from '../desk-facts.js';
import { resolvePendingDeskFacts } from '../desk-fact-resolve.js';
import { ingestFedSpeeches } from '../figure-views-ingest.js';
import { autoResolveOpenViews } from '../figure-views-auto-resolve.js';
import { getSchwabAccessToken, getSchwabAuthStatus } from '../schwab-auth.js';
import { runResearchOpsHealthJob, lastResearchOpsRun as researchOpsModuleRun } from '../research-ops.js';
import { isPublicHost } from '../host-role.js';
import { setConfigDate, noteFailedAttempt } from './config.js';
import { loadDate } from './persist.js';
import {
  LAST_ENRICHMENT_RUN_KEY, LAST_RETENTION_PRUNE_KEY, LAST_TRADE_EXPIRY_RUN_KEY,
  LAST_MODEL_SNAPSHOT_RUN_KEY, LAST_OPTION_SCORE_RUN_KEY, LAST_EVENT_BULLETS_RUN_KEY,
  LAST_EARNINGS_BACKFILL_RUN_KEY, LAST_FMP_ANALYST_FEED_RUN_KEY, LAST_DESK_INGEST_RUN_KEY,
  LAST_VOICES_INGEST_RUN_KEY, LAST_SCHWAB_HEALTH_RUN_KEY, LAST_RESEARCH_OPS_RUN_KEY,
} from './keys.js';
import {
  enrichmentRunning, tradeExpiryRunning, modelSnapshotRunning, optionScoreRunning,
  eventBulletsRunning, earningsBackfillRunning, fmpAnalystFeedRunning, deskIngestRunning,
  voicesIngestRunning, schwabHealthRunning, regimeCheckRunning,
  lastEnrichmentRun, lastTradeExpiryRun, lastModelSnapshotRun, lastOptionScoreRun,
  lastEventBulletsRun, lastEarningsBackfillRun, lastFmpAnalystFeedRun, lastDeskIngestRun,
  lastVoicesIngestRun, lastSchwabHealthRun, lastResearchOpsRun, lastRetentionPrune,
  lastRegimeCheckpointRun, lastModelSnapshotFailure, schedulerMut,
} from './state.js';

export async function runEnrichment() {
  // Mac LaunchAgent `com.fildi.maintain` owns enrichment scheduling (daily lean +
  // ≥4d full catch-up). Keeping the in-process Sun/Thu job would double-run.
  if (process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" || process.env.DISABLE_SCHEDULER_ENRICHMENT === "true") {
    logger.info("scheduler: enrichment skipped (DISABLE_SCHEDULER_ENRICHMENT) — use maintain LaunchAgent");
    return;
  }
  if (enrichmentRunning) return;
  schedulerMut.setEnrichmentRunning(true);
  logger.info("scheduler: starting nightly enrichment");
  try {
    const outcome = await runNightlyEnrichment("scheduled");
    if (outcome === "busy") {
      logger.info("scheduler: enrichment skipped — another process holds the advisory lock");
      return;
    }
    const enrichmentAt = new Date();
    schedulerMut.setLastEnrichmentRun(enrichmentAt);
    await setConfigDate(LAST_ENRICHMENT_RUN_KEY, enrichmentAt);
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
    await noteFailedAttempt("enrichment");
  } finally {
    schedulerMut.setEnrichmentRunning(false);
  }
}

// Belt-and-suspenders for resolveExpiredOptionTrades(), which already runs lazily
// on GET /feed/posts — this guarantees expired trades settle even if nobody opens
// the feed over the weekend, instead of staying OPEN until the next visit.
/** Manual / admin trigger — same body as the Saturday schedule. */
export async function runTradeExpiry() {
  if (tradeExpiryRunning) return;
  schedulerMut.setTradeExpiryRunning(true);
  logger.info("scheduler: starting trade-idea expiry resolution");
  try {
    await resolveExpiredOptionTrades();
    // Model accountability grading rides the same Saturday window — internally
    // stage-isolated (each grader catches its own errors), so a grading failure
    // can't mask a successful trade-idea resolution or vice versa.
    await runModelGrading();
    const tradeAt = new Date();
    schedulerMut.setLastTradeExpiryRun(tradeAt);
    await setConfigDate(LAST_TRADE_EXPIRY_RUN_KEY, tradeAt);
    logger.info("scheduler: trade-idea expiry resolution complete");
  } catch (err) {
    logger.error({ err }, "scheduler: trade-idea expiry resolution failed");
  } finally {
    schedulerMut.setTradeExpiryRunning(false);
  }
}

/** Manual / admin trigger — same body as the Friday schedule. */
export async function runModelSnapshotJob() {
  if (modelSnapshotRunning) return;
  schedulerMut.setModelSnapshotRunning(true);
  logger.info("scheduler: starting model accountability snapshot");
  try {
    const result = await runModelSnapshot();
    const snapshotAt = new Date();
    schedulerMut.setLastModelSnapshotRun(snapshotAt);
    await setConfigDate(LAST_MODEL_SNAPSHOT_RUN_KEY, snapshotAt);
    // Dual-write also refreshed option scores — mark that job done today.
    schedulerMut.setLastOptionScoreRun(snapshotAt);
    await setConfigDate(LAST_OPTION_SCORE_RUN_KEY, snapshotAt).catch(() => {});
    try {
      mkdirSync("/tmp/fildi-logs", { recursive: true });
      writeFileSync(
        "/tmp/fildi-logs/model-snapshot-last.json",
        JSON.stringify({
          ts: snapshotAt.toISOString(),
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
    schedulerMut.setLastModelSnapshotFailure(new Date());
    logger.error({ err }, "scheduler: model accountability snapshot failed");
  } finally {
    schedulerMut.setModelSnapshotRunning(false);
  }
}

/** Manual / admin trigger — Overall option score persistence. */
export async function runOptionScoreJob() {
  if (optionScoreRunning) return;
  schedulerMut.setOptionScoreRunning(true);
  logger.info("scheduler: starting option score snapshots (Overall rankings)");
  try {
    await computeAndPersistOptionScores();
    const optionAt = new Date();
    schedulerMut.setLastOptionScoreRun(optionAt);
    await setConfigDate(LAST_OPTION_SCORE_RUN_KEY, optionAt);
    logger.info("scheduler: option score snapshots complete");
  } catch (err) {
    logger.error({ err }, "scheduler: option score snapshots failed");
    await noteFailedAttempt("optionScore");
  } finally {
    schedulerMut.setOptionScoreRunning(false);
  }
}

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

/** Manual / admin trigger — daily event-bullet precompute. */
export async function runEventBulletsJob() {
  if (eventBulletsRunning) return;
  schedulerMut.setEventBulletsRunning(true);
  logger.info("scheduler: starting event-bullets trigger check");
  try {
    await runEventBulletCheck();
    const bulletsAt = new Date();
    schedulerMut.setLastEventBulletsRun(bulletsAt);
    await setConfigDate(LAST_EVENT_BULLETS_RUN_KEY, bulletsAt);
    logger.info("scheduler: event-bullets trigger check complete");
  } catch (err) {
    logger.error({ err }, "scheduler: event-bullets trigger check failed");
    await noteFailedAttempt("eventBullets");
  } finally {
    schedulerMut.setEventBulletsRunning(false);
  }
}

/** Manual / admin trigger — capped earnings-history backfill. */
export async function runEarningsBackfillJob() {
  if (earningsBackfillRunning) return;
  schedulerMut.setEarningsBackfillRunning(true);
  logger.info("scheduler: starting earnings history backfill");
  try {
    await runEarningsHistoryBackfill("scheduled");
    const earningsAt = new Date();
    schedulerMut.setLastEarningsBackfillRun(earningsAt);
    await setConfigDate(LAST_EARNINGS_BACKFILL_RUN_KEY, earningsAt);
    logger.info("scheduler: earnings history backfill complete");
  } catch (err) {
    logger.error({ err }, "scheduler: earnings history backfill failed");
    await noteFailedAttempt("earnings");
  } finally {
    schedulerMut.setEarningsBackfillRunning(false);
  }
}

/** Manual / admin trigger — FMP grades/price-target tape archive. */
export async function runFmpAnalystFeedJob() {
  if (fmpAnalystFeedRunning) return;
  schedulerMut.setFmpAnalystFeedRunning(true);
  logger.info("scheduler: starting fmp analyst feed poll");
  try {
    const result = await runFmpAnalystFeedPoll();
    const fmpAt = new Date();
    schedulerMut.setLastFmpAnalystFeedRun(fmpAt);
    await setConfigDate(LAST_FMP_ANALYST_FEED_RUN_KEY, fmpAt);
    logger.info(result, "scheduler: fmp analyst feed poll complete");
    // Keep watchlist vsSt filled: LSEG pt_mean + events (+ fundamentals gaps).
    try {
      const { backfillStreetPt } = await import("../street-pt.js");
      const street = await backfillStreetPt();
      logger.info(street, "scheduler: street_pt_daily refresh after analyst feed");
    } catch (err) {
      logger.warn({ err }, "scheduler: street_pt_daily refresh failed (non-fatal)");
    }
  } catch (err) {
    logger.error({ err }, "scheduler: fmp analyst feed poll failed");
    await noteFailedAttempt("fmp");
  } finally {
    schedulerMut.setFmpAnalystFeedRunning(false);
  }
}

/**
 * FactSet desk emails: Drive folder → desk_commentaries.
 * Only files mtime ≥ last run (or last 48h on first run). No full-history replay.
 */
export async function runDeskIngestJob() {
  if (deskIngestRunning) return;
  schedulerMut.setDeskIngestRunning(true);
  logger.info("scheduler: starting desk commentary ingest");
  try {
    const sinceMs = lastDeskIngestRun
      ? lastDeskIngestRun.getTime() - 5 * 60 * 1000
      : Date.now() - 48 * 60 * 60 * 1000;
    const result = await ingestDeskCommentaries({ sinceMs });
    const deskAt = new Date();
    schedulerMut.setLastDeskIngestRun(deskAt);
    await setConfigDate(LAST_DESK_INGEST_RUN_KEY, deskAt);
    logger.info(result, "scheduler: desk commentary ingest complete");
    // D1: typed facts for new emails (Haiku, sequential, ≤ 20 per run, 2-min deadline each)
    const facts = await extractPendingDeskFacts({ limit: 20 }).catch((err) => {
      logger.warn({ err: String(err) }, "scheduler: desk facts extract failed");
      return null;
    });
    if (facts) logger.info(facts, "scheduler: desk facts extract complete");
    // D2: check analyst / calendar facts vs our tables (code; ≤ 10 Yahoo refreshes, 15 s deadline each)
    const checked = await resolvePendingDeskFacts({ limit: 200 }).catch((err) => {
      logger.warn({ err: String(err) }, "scheduler: desk facts resolve failed");
      return null;
    });
    if (checked) logger.info(checked, "scheduler: desk facts resolve complete");
  } catch (err) {
    logger.error({ err }, "scheduler: desk commentary ingest failed");
  } finally {
    schedulerMut.setDeskIngestRunning(false);
  }
}

/**
 * Schwab OAuth health: refresh access token (keeps file warm) + warn before 7d refresh expiry.
 * Does NOT pull market data — zero RPM cost beyond the token endpoint.
 */

export async function runVoicesIngestJob() {
  if (voicesIngestRunning) return;
  schedulerMut.setVoicesIngestRunning(true);
  logger.info("scheduler: starting voices (Fed speeches) ingest");
  try {
    const result = await ingestFedSpeeches({ limit: 40 });
    const voicesAt = new Date();
    schedulerMut.setLastVoicesIngestRun(voicesAt);
    await setConfigDate(LAST_VOICES_INGEST_RUN_KEY, voicesAt);
    logger.info(result, "scheduler: voices ingest complete");
    const resolved = await autoResolveOpenViews({ limit: 80 });
    logger.info(resolved, "scheduler: voices auto-resolve complete");
  } catch (err) {
    logger.error({ err }, "scheduler: voices ingest failed");
  } finally {
    schedulerMut.setVoicesIngestRunning(false);
  }
}

export async function runSchwabHealthJob() {
  if (schwabHealthRunning) return;
  schedulerMut.setSchwabHealthRunning(true);
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
    const schwabAt = new Date();
    schedulerMut.setLastSchwabHealthRun(schwabAt);
    await setConfigDate(LAST_SCHWAB_HEALTH_RUN_KEY, schwabAt);
  } catch (err) {
    logger.error({ err }, "scheduler: schwab health check failed");
  } finally {
    schedulerMut.setSchwabHealthRunning(false);
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
    const researchAt = researchOpsModuleRun ?? new Date();
    schedulerMut.setLastResearchOpsRun(researchAt);
    await setConfigDate(LAST_RESEARCH_OPS_RUN_KEY, researchAt);
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
    const retentionAt = new Date();
    schedulerMut.setLastRetentionPrune(retentionAt);
    await setConfigDate(LAST_RETENTION_PRUNE_KEY, retentionAt).catch(err =>
      logger.error({ err }, "scheduler: failed to persist retention-prune timestamp"),
    );
  } catch (err) {
    logger.error({ err }, "scheduler: retention prune failed — lastRun not advanced");
    await noteFailedAttempt("retention");
  }
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
  schedulerMut.setRegimeCheckRunning(true);
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
    schedulerMut.setLastRegimeCheckpointRun(new Date());
  } finally {
    schedulerMut.setRegimeCheckRunning(false);
  }
}