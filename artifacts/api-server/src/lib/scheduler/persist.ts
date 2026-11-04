import { desc, inArray } from "drizzle-orm";
import { db, enrichmentRuns } from "@workspace/db";
import { logger } from "../logger.js";
import { pickFresherStamp, parseAttemptCount } from "../scheduler-catchup.js";
import { getConfigDate, getConfigString, attempts, ATTEMPT_AT, ATTEMPT_COUNT, type AttemptSlot } from "./config.js";
import {
  LAST_ENRICHMENT_RUN_KEY,
  LAST_RETENTION_PRUNE_KEY,
  LAST_TRADE_EXPIRY_RUN_KEY,
  LAST_MODEL_SNAPSHOT_RUN_KEY,
  LAST_OPTION_SCORE_RUN_KEY,
  LAST_EVENT_BULLETS_RUN_KEY,
  LAST_EARNINGS_BACKFILL_RUN_KEY,
  LAST_FMP_ANALYST_FEED_RUN_KEY,
  LAST_DESK_INGEST_RUN_KEY,
  LAST_VOICES_INGEST_RUN_KEY,
  LAST_SCHWAB_HEALTH_RUN_KEY,
  LAST_RESEARCH_OPS_RUN_KEY,
} from "./keys.js";
import {
  lastEnrichmentRun, lastRetentionPrune, lastTradeExpiryRun, lastModelSnapshotRun,
  lastOptionScoreRun, lastEventBulletsRun, lastEarningsBackfillRun, lastFmpAnalystFeedRun,
  lastDeskIngestRun, lastVoicesIngestRun, lastSchwabHealthRun, lastResearchOpsRun,
  schedulerMut,
} from "./state.js";

export async function loadDate(key: string): Promise<Date | null> {
  try {
    return await getConfigDate(key);
  } catch (err) {
    logger.error({ err, key }, "scheduler: failed to load persisted last-run");
    return null;
  }
}

async function loadAttempt(slot: AttemptSlot): Promise<void> {
  const now = new Date();
  let at: Date | null = null;
  let raw: string | null = null;
  try { at = await getConfigDate(ATTEMPT_AT[slot]); } catch { at = null; }
  try { raw = await getConfigString(ATTEMPT_COUNT[slot]); } catch { raw = null; }
  const fromDb = { lastAttempt: at, attemptsOnDay: parseAttemptCount(raw, now) };
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
  schedulerMut.setLastEnrichmentRun(pickFresherStamp(lastEnrichmentRun, enrichment));
  schedulerMut.setLastRetentionPrune(pickFresherStamp(lastRetentionPrune, retention));
  schedulerMut.setLastTradeExpiryRun(pickFresherStamp(lastTradeExpiryRun, trade));
  schedulerMut.setLastModelSnapshotRun(pickFresherStamp(lastModelSnapshotRun, model));
  schedulerMut.setLastOptionScoreRun(pickFresherStamp(lastOptionScoreRun, option));
  schedulerMut.setLastEventBulletsRun(pickFresherStamp(lastEventBulletsRun, bullets));
  schedulerMut.setLastEarningsBackfillRun(pickFresherStamp(lastEarningsBackfillRun, earnings));
  schedulerMut.setLastFmpAnalystFeedRun(pickFresherStamp(lastFmpAnalystFeedRun, fmp));
  schedulerMut.setLastDeskIngestRun(pickFresherStamp(lastDeskIngestRun, desk));
  schedulerMut.setLastVoicesIngestRun(pickFresherStamp(lastVoicesIngestRun, voices));
  schedulerMut.setLastSchwabHealthRun(pickFresherStamp(lastSchwabHealthRun, schwab));
  schedulerMut.setLastResearchOpsRun(pickFresherStamp(lastResearchOpsRun, research));

  try {
    const rows = await db
      .select({ finishedAt: enrichmentRuns.finishedAt })
      .from(enrichmentRuns)
      .where(inArray(enrichmentRuns.status, ["success", "partial"]))
      .orderBy(desc(enrichmentRuns.finishedAt))
      .limit(1);
    const at = rows[0]?.finishedAt ? new Date(rows[0].finishedAt as unknown as string) : null;
    if (at && !Number.isNaN(at.getTime())) schedulerMut.setLastEnrichmentRun(pickFresherStamp(lastEnrichmentRun, at));
  } catch (err) {
    logger.warn({ err }, "scheduler: enrichment_runs hydrate skipped");
  }

  await Promise.all((Object.keys(ATTEMPT_AT) as AttemptSlot[]).map((slot) => loadAttempt(slot)));
}
