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

// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
export const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";
export const LAST_RETENTION_PRUNE_KEY = "last_retention_prune";
export const LAST_TRADE_EXPIRY_RUN_KEY = "last_trade_expiry_run";
export const LAST_MODEL_SNAPSHOT_RUN_KEY = "last_model_snapshot_run";
export const LAST_OPTION_SCORE_RUN_KEY = "last_option_score_snapshot_run";
export const LAST_EVENT_BULLETS_RUN_KEY = "last_event_bullets_run";
export const LAST_EARNINGS_BACKFILL_RUN_KEY = "last_earnings_backfill_run";
export const LAST_FMP_ANALYST_FEED_RUN_KEY = "last_fmp_analyst_feed_run";
export const LAST_DESK_INGEST_RUN_KEY = "last_desk_commentary_ingest_run";
export const LAST_VOICES_INGEST_RUN_KEY = "last_voices_ingest_run";
export const LAST_SCHWAB_HEALTH_RUN_KEY = "last_schwab_health_run";
export const LAST_RESEARCH_OPS_RUN_KEY = "last_research_ops_health_run";

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
export let lastVoicesIngestRun: Date | null = null;
export let voicesIngestRunning = false;
export let lastSchwabHealthRun: Date | null = null;
export let schwabHealthRunning = false;
/** Re-export for scheduled-tasks — probe only, never vendor sync. */
export { researchOpsRunning };
export let lastResearchOpsRun: Date | null = null;

export async function getConfigString(key: string): Promise<string | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

export async function getConfigDate(key: string): Promise<Date | null> {
  const iso = await getConfigString(key);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key, value });
  } else {
    await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
  }
}

export async function setConfigDate(key: string, date: Date): Promise<void> {
  await setConfigValue(key, date.toISOString());
}

export type AttemptSlot = "enrichment" | "optionScore" | "eventBullets" | "earnings" | "fmp" | "retention";

export const ATTEMPT_AT: Record<AttemptSlot, string> = {
  enrichment: "last_enrichment_attempt",
  optionScore: "last_option_score_attempt",
  eventBullets: "last_event_bullets_attempt",
  earnings: "last_earnings_backfill_attempt",
  fmp: "last_fmp_analyst_feed_attempt",
  retention: "last_retention_prune_attempt",
};

export const ATTEMPT_COUNT: Record<AttemptSlot, string> = {
  enrichment: "enrichment_attempt_count",
  optionScore: "option_score_attempt_count",
  eventBullets: "event_bullets_attempt_count",
  earnings: "earnings_backfill_attempt_count",
  fmp: "fmp_analyst_feed_attempt_count",
  retention: "retention_prune_attempt_count",
};

export const attempts: Record<AttemptSlot, RunAttempt> = {
  enrichment: { ...NO_ATTEMPT },
  optionScore: { ...NO_ATTEMPT },
  eventBullets: { ...NO_ATTEMPT },
  earnings: { ...NO_ATTEMPT },
  fmp: { ...NO_ATTEMPT },
  retention: { ...NO_ATTEMPT },
};

export async function noteFailedAttempt(slot: AttemptSlot): Promise<void> {
  const now = new Date();
  let prev: string | null = null;
  try {
    prev = await getConfigString(ATTEMPT_COUNT[slot]);
  } catch { /* count starts at 1 */ }
  const next = nextAttemptCount(prev, now);
  attempts[slot] = { lastAttempt: now, attemptsOnDay: parseAttemptCount(next, now) };
  await setConfigValue(ATTEMPT_AT[slot], now.toISOString()).catch((err) =>
    logger.error({ err, slot }, "scheduler: failed to persist attempt time"),
  );
  await setConfigValue(ATTEMPT_COUNT[slot], next).catch((err) =>
    logger.error({ err, slot }, "scheduler: failed to persist attempt count"),
  );
}

export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth()    === b.getUTCMonth() &&
    a.getUTCDate()     === b.getUTCDate()
  );
}

export function daysSince(d: Date | null): number {
  if (!d) return Infinity;
  return (Date.now() - d.getTime()) / (24 * 60 * 60 * 1000);
}

export let lastRetentionPrune: Date | null = null;

export let lastModelSnapshotFailure: Date | null = null;

export async function runEnrichment() {
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
    const outcome = await runNightlyEnrichment("scheduled");
    if (outcome === "busy") {
      logger.info("scheduler: enrichment skipped — another process holds the advisory lock");
      return;
    }
    lastEnrichmentRun = new Date();
    await setConfigDate(LAST_ENRICHMENT_RUN_KEY, lastEnrichmentRun);
    logger.info("scheduler: enrichment complete");
  } catch (err) {
    logger.error({ err }, "scheduler: enrichment failed");
    await noteFailedAttempt("enrichment");
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
    lastModelSnapshotFailure = new Date();
    logger.error({ err }, "scheduler: model accountability snapshot failed");
  } finally {
    modelSnapshotRunning = false;
  }
}

// Option scores: Mon–Thu 19:00 UTC. Friday stays with the model snapshot. Catch-up after 2 days.
export function shouldRunOptionScoreNow(): boolean {
  return shouldRunOptionScoreAt(lastOptionScoreRun, new Date(), attempts.optionScore);
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
    await noteFailedAttempt("optionScore");
  } finally {
    optionScoreRunning = false;
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
  eventBulletsRunning = true;
  logger.info("scheduler: starting event-bullets trigger check");
  try {
    await runEventBulletCheck();
    lastEventBulletsRun = new Date();
    await setConfigDate(LAST_EVENT_BULLETS_RUN_KEY, lastEventBulletsRun);
    logger.info("scheduler: event-bullets trigger check complete");
  } catch (err) {
    logger.error({ err }, "scheduler: event-bullets trigger check failed");
    await noteFailedAttempt("eventBullets");
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
    await noteFailedAttempt("earnings");
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
    deskIngestRunning = false;
  }
}

/**
 * Schwab OAuth health: refresh access token (keeps file warm) + warn before 7d refresh expiry.
 * Does NOT pull market data — zero RPM cost beyond the token endpoint.
 */

export async function runVoicesIngestJob() {
  if (voicesIngestRunning) return;
  voicesIngestRunning = true;
  logger.info("scheduler: starting voices (Fed speeches) ingest");
  try {
    const result = await ingestFedSpeeches({ limit: 40 });
    lastVoicesIngestRun = new Date();
    await setConfigDate(LAST_VOICES_INGEST_RUN_KEY, lastVoicesIngestRun);
    logger.info(result, "scheduler: voices ingest complete");
    const resolved = await autoResolveOpenViews({ limit: 80 });
    logger.info(resolved, "scheduler: voices auto-resolve complete");
  } catch (err) {
    logger.error({ err }, "scheduler: voices ingest failed");
  } finally {
    voicesIngestRunning = false;
  }
}

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
    await noteFailedAttempt("retention");
  }
}

export async function loadDate(key: string): Promise<Date | null> {
  try {
    return await getConfigDate(key);
  } catch (err) {
    logger.error({ err, key }, "scheduler: failed to load persisted last-run");
    return null;
  }
}

export async function loadAttempt(slot: AttemptSlot): Promise<void> {
  const now = new Date();
  let at: Date | null = null;
  let raw: string | null = null;
  try { at = await getConfigDate(ATTEMPT_AT[slot]); } catch { at = null; }
  try { raw = await getConfigString(ATTEMPT_COUNT[slot]); } catch { raw = null; }
  const fromDb: RunAttempt = { lastAttempt: at, attemptsOnDay: parseAttemptCount(raw, now) };
  const mem = attempts[slot];
  const fresher = pickFresherStamp(mem.lastAttempt, fromDb.lastAttempt);
  const dbWins = !mem.lastAttempt || (fresher != null && fromDb.lastAttempt != null && fresher.getTime() === fromDb.lastAttempt.getTime());
  attempts[slot] = dbWins ? fromDb : mem;
}

/** Re-read app_config (and enrichment_runs) so a Maintain write after startup is visible. */
export async function refreshPersistedLastRuns(): Promise<void> {
  const [enrichment, retention, trade, model, option, bullets, earnings, fmp, desk, voices, schwab, research] = await Promise.all([
    loadDate(LAST_ENRICHMENT_RUN_KEY),
    loadDate(LAST_RETENTION_PRUNE_KEY),
    loadDate(LAST_TRADE_EXPIRY_RUN_KEY),
    loadDate(LAST_MODEL_SNAPSHOT_RUN_KEY),
    loadDate(LAST_OPTION_SCORE_RUN_KEY),
    loadDate(LAST_EVENT_BULLETS_RUN_KEY),
    loadDate(LAST_EARNINGS_BACKFILL_RUN_KEY),
    loadDate(LAST_FMP_ANALYST_FEED_RUN_KEY),
    loadDate(LAST_DESK_INGEST_RUN_KEY),
    loadDate(LAST_VOICES_INGEST_RUN_KEY),
    loadDate(LAST_SCHWAB_HEALTH_RUN_KEY),
    loadDate(LAST_RESEARCH_OPS_RUN_KEY),
  ]);
  lastEnrichmentRun = pickFresherStamp(lastEnrichmentRun, enrichment);
  lastRetentionPrune = pickFresherStamp(lastRetentionPrune, retention);
  lastTradeExpiryRun = pickFresherStamp(lastTradeExpiryRun, trade);
  lastModelSnapshotRun = pickFresherStamp(lastModelSnapshotRun, model);
  lastOptionScoreRun = pickFresherStamp(lastOptionScoreRun, option);
  lastEventBulletsRun = pickFresherStamp(lastEventBulletsRun, bullets);
  lastEarningsBackfillRun = pickFresherStamp(lastEarningsBackfillRun, earnings);
  lastFmpAnalystFeedRun = pickFresherStamp(lastFmpAnalystFeedRun, fmp);
  lastDeskIngestRun = pickFresherStamp(lastDeskIngestRun, desk);
  lastVoicesIngestRun = pickFresherStamp(lastVoicesIngestRun, voices);
  lastSchwabHealthRun = pickFresherStamp(lastSchwabHealthRun, schwab);
  lastResearchOpsRun = pickFresherStamp(lastResearchOpsRun, research);

  // Prefer enrichment_runs (Maintain daily) over a stale app_config stamp.
  try {
    const rows = await db
      .select({ finishedAt: enrichmentRuns.finishedAt })
      .from(enrichmentRuns)
      .where(inArray(enrichmentRuns.status, ["success", "partial"]))
      .orderBy(desc(enrichmentRuns.finishedAt))
      .limit(1);
    const at = rows[0]?.finishedAt ? new Date(rows[0].finishedAt as unknown as string) : null;
    if (at && !Number.isNaN(at.getTime())) lastEnrichmentRun = pickFresherStamp(lastEnrichmentRun, at);
  } catch (err) {
    logger.warn({ err }, "scheduler: enrichment_runs hydrate skipped");
  }

  await Promise.all((Object.keys(ATTEMPT_AT) as AttemptSlot[]).map((slot) => loadAttempt(slot)));
}
