#!/usr/bin/env python3
"""Split scheduler.ts (A332): state-guards, schedule-guards, jobs-loop."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src/lib/scheduler.monolith.bak"
OUT = ROOT / "src/lib/scheduler"
OUT.mkdir(parents=True, exist_ok=True)

lines = SRC.read_text().splitlines()


def sl(a: int, b: int) -> str:
    return "\n".join(lines[a - 1 : b])


IMPORTS = (
    sl(13, 62)
    .replace('from "./', 'from "../')
    .replace('from "../scripts/', 'from "../../scripts/')
)
HEAD = "/** Scheduler module (A332 split). */\n"

state = HEAD + IMPORTS + "\n\n" + sl(66, 201) + "\n\nexport let lastModelSnapshotFailure: Date | null = null;\n\n" + sl(304, 633) + "\n\n" + sl(695, 761) + "\n"
guards = HEAD + IMPORTS + "\n\n" + sl(203, 286) + "\n\n" + sl(288, 302) + "\n"
jobs = (
    HEAD
    + IMPORTS
    + """
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

"""
    + sl(415, 443)
    + "\n\n"
    + sl(635, 647)
    + "\n\n"
    + sl(657, 693)
    + "\n\n"
    + sl(763, 812)
    + "\n"
)

(OUT / "state-guards.ts").write_text(state)
(OUT / "schedule-guards.ts").write_text(guards)
(OUT / "jobs-loop.ts").write_text(jobs)
(OUT / "job-runners.ts").unlink(missing_ok=True)

sg = (OUT / "state-guards.ts").read_text()
sg = sg.replace('await import("./street-pt.js")', 'await import("../street-pt.js")')
sg = sg.replace("function daysSince", "export function daysSince")
sg = sg.replace("function isSameUtcDay", "export function isSameUtcDay")
for fn in ["loadDate", "loadAttempt", "refreshPersistedLastRuns", "getConfigString", "getConfigDate", "setConfigValue", "setConfigDate", "noteFailedAttempt"]:
    sg = sg.replace(f"async function {fn}(", f"export async function {fn}(")
for fn in [
    "runEnrichment", "runTradeExpiry", "runModelSnapshotJob", "runOptionScoreJob",
    "runEventBulletsJob", "runEarningsBackfillJob", "runFmpAnalystFeedJob",
    "runDeskIngestJob", "runVoicesIngestJob", "runSchwabHealthJob", "runResearchOpsJob", "runRetentionPrune",
]:
    sg = sg.replace(f"\nasync function {fn}(", f"\nexport async function {fn}(")
sg = sg.replace("\nfunction shouldRunOptionScoreNow(", "\nexport function shouldRunOptionScoreNow(")
sg = sg.replace("type AttemptSlot", "export type AttemptSlot")
for c in ["ATTEMPT_AT", "ATTEMPT_COUNT", "attempts"]:
    sg = sg.replace(f"const {c}", f"export const {c}")
for k in [
    "LAST_ENRICHMENT_RUN_KEY", "LAST_RETENTION_PRUNE_KEY", "LAST_TRADE_EXPIRY_RUN_KEY",
    "LAST_MODEL_SNAPSHOT_RUN_KEY", "LAST_OPTION_SCORE_RUN_KEY", "LAST_EVENT_BULLETS_RUN_KEY",
    "LAST_EARNINGS_BACKFILL_RUN_KEY", "LAST_FMP_ANALYST_FEED_RUN_KEY", "LAST_DESK_INGEST_RUN_KEY",
    "LAST_VOICES_INGEST_RUN_KEY", "LAST_SCHWAB_HEALTH_RUN_KEY", "LAST_RESEARCH_OPS_RUN_KEY",
]:
    sg = sg.replace(f"const {k} ", f"export const {k} ")
(OUT / "state-guards.ts").write_text(sg)

gd = (OUT / "schedule-guards.ts").read_text()
gd = gd.replace(
    HEAD + IMPORTS + "\n\n",
    HEAD
    + IMPORTS
    + """
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

""",
)
for fn in [
    "runEnrichment", "shouldRunEnrichmentNow", "shouldRunRetentionNow", "shouldRunTradeExpiryNow",
    "shouldRunModelSnapshotNow", "shouldRunEventBulletsNow",
    "shouldRunEarningsBackfillNow", "shouldRunFmpAnalystFeedNow", "shouldRunDeskIngestNow",
    "shouldRunVoicesIngestNow", "shouldRunSchwabHealthNow", "shouldRunResearchOpsNow",
]:
    gd = gd.replace(f"async function {fn}(", f"export async function {fn}(")
    gd = gd.replace(f"\nfunction {fn}(", f"\nexport function {fn}(")
for c in ["SCHEDULE_HOUR", "TRADE_EXPIRY_DAY", "TRADE_EXPIRY_HOUR", "MODEL_SNAPSHOT_DAY", "MODEL_SNAPSHOT_HOUR", "CHECK_INTERVAL_MS", "STARTUP_TICK_MS", "MAINTAIN_OWNED"]:
    gd = gd.replace(f"const {c} ", f"export const {c} ")
(OUT / "schedule-guards.ts").write_text(gd)

jl = (OUT / "jobs-loop.ts").read_text()
jl = jl.replace("\nfunction runDueJobs(", "\nexport function runDueJobs(")
(OUT / "jobs-loop.ts").write_text(jl)

entry = """export {
  runSchwab1mPoll,
  runSchwab1mBackfill,
  schwab1mPollRunning,
  lastSchwab1mPollRun,
} from \"./schwab-1m-poll.js\";
export { shouldRunRegimeCheckpointsAt } from \"./scheduler-catchup.js\";
export {
  lastEnrichmentRun,
  enrichmentRunning,
  noteEnrichmentRunFromDb,
  setEnrichmentRunning,
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
} from \"./scheduler/state-guards.js\";
export {
  runMorningPrecomputeIfDue,
  runRetentionPruneIfDue,
  regimeCheckRunning,
  lastRegimeCheckpointRun,
  shouldRunRegimeCheckpointsNow,
  runRegimeCheckpoints,
  startScheduler,
} from \"./scheduler/jobs-loop.js\";
"""
(ROOT / "src/lib/scheduler.ts").write_text(entry)

for name in ("state-guards.ts", "schedule-guards.ts", "jobs-loop.ts"):
    print(name, sum(1 for _ in (OUT / name).open()))
