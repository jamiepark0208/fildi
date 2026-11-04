// Exported so data-health / scheduled-tasks routes can read them without a DB round-trip.
// Hydrated from app_config at startup — see loadPersistedLastRun().
export { researchOpsRunning } from "../research-ops.js";
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
export let lastResearchOpsRun: Date | null = null;
export let lastRetentionPrune: Date | null = null;
export let lastModelSnapshotFailure: Date | null = null;
export let regimeCheckRunning = false;
export let lastRegimeCheckpointRun: Date | null = null;

/** Cross-module writes (export let is read-only outside this file under TS). */
export const schedulerMut = {
  setLastEnrichmentRun(d: Date | null) { lastEnrichmentRun = d; },
  setEnrichmentRunning(v: boolean) { enrichmentRunning = v; },
  setLastTradeExpiryRun(d: Date | null) { lastTradeExpiryRun = d; },
  setTradeExpiryRunning(v: boolean) { tradeExpiryRunning = v; },
  setLastModelSnapshotRun(d: Date | null) { lastModelSnapshotRun = d; },
  setModelSnapshotRunning(v: boolean) { modelSnapshotRunning = v; },
  setLastModelSnapshotFailure(d: Date | null) { lastModelSnapshotFailure = d; },
  setLastOptionScoreRun(d: Date | null) { lastOptionScoreRun = d; },
  setOptionScoreRunning(v: boolean) { optionScoreRunning = v; },
  setLastEventBulletsRun(d: Date | null) { lastEventBulletsRun = d; },
  setEventBulletsRunning(v: boolean) { eventBulletsRunning = v; },
  setLastEarningsBackfillRun(d: Date | null) { lastEarningsBackfillRun = d; },
  setEarningsBackfillRunning(v: boolean) { earningsBackfillRunning = v; },
  setLastFmpAnalystFeedRun(d: Date | null) { lastFmpAnalystFeedRun = d; },
  setFmpAnalystFeedRunning(v: boolean) { fmpAnalystFeedRunning = v; },
  setLastDeskIngestRun(d: Date | null) { lastDeskIngestRun = d; },
  setDeskIngestRunning(v: boolean) { deskIngestRunning = v; },
  setLastVoicesIngestRun(d: Date | null) { lastVoicesIngestRun = d; },
  setVoicesIngestRunning(v: boolean) { voicesIngestRunning = v; },
  setLastSchwabHealthRun(d: Date | null) { lastSchwabHealthRun = d; },
  setSchwabHealthRunning(v: boolean) { schwabHealthRunning = v; },
  setLastResearchOpsRun(d: Date | null) { lastResearchOpsRun = d; },
  setLastRetentionPrune(d: Date | null) { lastRetentionPrune = d; },
  setRegimeCheckRunning(v: boolean) { regimeCheckRunning = v; },
  setLastRegimeCheckpointRun(d: Date | null) { lastRegimeCheckpointRun = d; },
};
