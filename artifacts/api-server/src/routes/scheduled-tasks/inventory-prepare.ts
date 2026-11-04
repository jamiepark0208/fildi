// @ts-nocheck
import { join } from "node:path";
import { homedir } from "node:os";
import {
  lastEnrichmentRun, enrichmentRunning,
  lastTradeExpiryRun, tradeExpiryRunning,
  lastModelSnapshotRun, modelSnapshotRunning,
  lastOptionScoreRun, optionScoreRunning,
  lastEventBulletsRun, eventBulletsRunning,
  lastEarningsBackfillRun, earningsBackfillRunning,
  lastFmpAnalystFeedRun, fmpAnalystFeedRunning,
  lastDeskIngestRun, deskIngestRunning,
  lastSchwabHealthRun, schwabHealthRunning,
  lastSchwab1mPollRun, schwab1mPollRunning,
  lastResearchOpsRun, researchOpsRunning,
} from "../../lib/scheduler.js";
import { getSchwabAuthStatus } from "../../lib/schwab-auth.js";
import { type ResearchOpsReport } from "../../lib/research-ops.js";
import { CHECKPOINTS_MIN, type RegimeCheckpoint } from "../../lib/intraday-regime.js";
import type { ScheduledTaskRow } from "./types.js";
import {
  LOG_DIR,
  RBH_EXPORT_PROMPT_LAST,
  RBH_LAST,
  RBH_LOG,
  RBH_SCRIPT,
  OPENJEV_LAST,
  PM_ALERTS_LAST,
  TRANSCRIPTS_LAST,
  ageLabel,
  apiStatus,
  checkpointDueMinutesPt,
  isRegimeRecorded,
  launchdState,
  pmJobStatus,
  ptParts,
  ranPtToday,
  readJsonFile,
  regimeLeanLabel,
  rhCsvReady,
  vcheck,
  withToday,
  ymdInTz,
  CHECKPOINT_TIME_PT,
} from "./helpers.js";

import type { Inv } from "./inventory-types.js";

export function prepareInv(
  checkpoints: RegimeCheckpoint[],
  researchReport: ResearchOpsReport | null,
): Inv {
    const pt = ptParts();
  const maintainHeal = readJsonFile(join(LOG_DIR, "maintain-last.json"));
  const maintainFull = readJsonFile(join(LOG_DIR, "maintain-full-last.json"));
  // Prefer full-pass proof for verifyChecks; heal report for live stack health.
  const maintain = (() => {
    if (!maintainHeal && !maintainFull) return null;
    if (!maintainFull) return maintainHeal;
    if (!maintainHeal) return maintainFull;
    const healActions = Array.isArray(maintainHeal.actions) ? (maintainHeal.actions as string[]) : [];
    const fullActions = Array.isArray(maintainFull.actions) ? (maintainFull.actions as string[]) : [];
    const merged = [...healActions];
    for (const a of fullActions) {
      if (typeof a === "string" && !merged.includes(a)) merged.push(a);
    }
    return {
      ...maintainFull,
      ...maintainHeal,
      actions: merged,
      // Keep heal's live health stamps
      ts: maintainHeal.ts ?? maintainFull.ts,
      processOk: maintainHeal.processOk ?? maintainFull.processOk,
      ok: maintainHeal.ok ?? maintainFull.ok,
      budget: maintainHeal.budget ?? maintainFull.budget,
    };
  })();
  const rbh = readJsonFile(RBH_LAST);
  const PROCESS = new Set(["api_healthz", "vite", "postgres"]);
  const failedChecks = Array.isArray(maintain?.failedChecks) ? (maintain!.failedChecks as string[]) : [];
  const derivedProcessFailed = failedChecks.filter((n) => PROCESS.has(n));
  const derivedVendorFailed = failedChecks.filter((n) => !PROCESS.has(n));
  const processOk = typeof maintain?.processOk === "boolean"
    ? maintain.processOk
    : maintain ? derivedProcessFailed.length === 0 : null;
  const vendorsOk = typeof maintain?.vendorsOk === "boolean"
    ? maintain.vendorsOk
    : maintain ? derivedVendorFailed.length === 0 : null;
  const jobOk = typeof maintain?.ok === "boolean" ? maintain.ok : processOk;
  const maintainTs = typeof maintain?.ts === "string" ? maintain.ts : null;
  const maintainActionsList = Array.isArray(maintain?.actions) ? (maintain!.actions as string[]) : [];
  const maintainActions = maintainActionsList.slice(0, 4).join(", ") || null;
  const maintainRanToday = ranPtToday(maintainTs, pt.ymd);
  const retentionOk = maintainActionsList.some((a) => /^retention_prune_exit_0$/.test(a));
  const morningPreOk = maintainActionsList.some((a) => /^morning_precompute_exit_0$/.test(a))
    || ranPtToday(lastEventBulletsRun?.toISOString() ?? null, pt.ymd);
  /** Non-zero exit / process_still_down in actions[] → L1 verify fail */
  const maintainActionFail = maintainActionsList.some(
    (a) =>
      /_exit_[1-9]\d*$/.test(a) ||
      /process_still_down/.test(a) ||
      /local_stack_heal_exit_[1-9]/.test(a),
  );
  const maintainLd = launchdState("com.fildi.maintain");

  let maintainStatus: TaskStatus = "never";
  if (maintainLd === "missing") maintainStatus = "missing";
  else if (jobOk === false || processOk === false) maintainStatus = "failed";
  else if (maintainActionFail || vendorsOk === false) maintainStatus = "warn";
  else if (jobOk === true || processOk === true) maintainStatus = "ok";
  else if (maintainTs) maintainStatus = "idle";

  const rbhStarted = typeof rbh?.started_at === "string" ? rbh.started_at : null;
  const rbhOk = typeof rbh?.success === "boolean" ? rbh.success : null;
  const rbhDetail = typeof rbh?.detail === "string" ? rbh.detail : null;
  const rbhStage = typeof rbh?.stage_reached === "string" ? rbh.stage_reached : null;
  const rbhLd = launchdState("com.fildi.rbh-daily-export");
  const csv = rhCsvReady(pt.ymd);
  const ingestRanToday = ymdInTz(rbhStarted, "America/Los_Angeles") === pt.ymd;

  // Export = ask-first LaunchAgent (com.fildi.rbh-export-prompt) → Claude session.
  const rbhPromptLd = launchdState("com.fildi.rbh-export-prompt");
  const rbhPrompt = readJsonFile(RBH_EXPORT_PROMPT_LAST);
  const rbhPromptDecision = typeof rbhPrompt?.decision === "string" ? rbhPrompt.decision : null;
  const rbhPromptAt =
    typeof rbhPrompt?.ts === "string"
      ? rbhPrompt.ts
      : typeof rbhPrompt?.at === "string"
        ? rbhPrompt.at
        : typeof rbhPrompt?.updated_at === "string"
          ? rbhPrompt.updated_at
          : null;
  let rbhExportStatus: TaskStatus = "off";
  if (rbhPromptLd === "missing") rbhExportStatus = "missing";
  else if (pt.weekday) {
    if (csv.ready || rbhPromptDecision === "done") rbhExportStatus = "ok";
    else if (rbhPromptDecision === "error" || rbhPromptDecision === "gave_up") rbhExportStatus = "failed";
    else if (rbhPromptDecision === "skipped") rbhExportStatus = "idle";
    else if (pt.minutes >= 13 * 60) rbhExportStatus = "waiting";
    else rbhExportStatus = "idle";
  }

  let rbhIngestStatus: TaskStatus = "never";
  if (rbhLd === "missing") rbhIngestStatus = "missing";
  else if (rbhOk === false) rbhIngestStatus = "failed";
  else if (ingestRanToday && rbhOk === true && (rbhStage === "done" || csv.ready)) rbhIngestStatus = "ok";
  else if (!csv.ready && pt.weekday) rbhIngestStatus = "waiting";
  else if (rbhStarted) rbhIngestStatus = "idle";

  const enrichmentDisabled =
    process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" ||
    process.env.DISABLE_SCHEDULER_ENRICHMENT === "true";

  const degradedFlag = readJsonFile(join(LOG_DIR, "model-snapshot-last.json"));
  const snapshotDegraded = degradedFlag?.degraded === true
    && ymdInTz(typeof degradedFlag.ts === "string" ? degradedFlag.ts : null, "America/Los_Angeles") === pt.ymd;

  const utcHourAsPtLabel = (utcHour: number) => {
    const ptHour24 = (utcHour - 7 + 24) % 24;
    const suffix = ptHour24 >= 12 ? "PM" : "AM";
    const h12 = ptHour24 % 12 || 12;
    return `${h12}:00 ${suffix} PT`;
  };
  const utcHourAsPtMinutes = (utcHour: number) => ((utcHour - 7 + 24) % 24) * 60;

  const cpByMin = new Map(checkpoints.map((c) => [c.minAfterOpen, c]));
  const regimeRows: ScheduledTaskRow[] = CHECKPOINTS_MIN.map((min, i) => {
    const cp = cpByMin.get(min);
    const dueMin = checkpointDueMinutesPt(min);
    const label = CHECKPOINT_TIME_PT[min] ?? `+${min}m`;
    const due = pt.weekday && pt.minutes >= dueMin;
    const recorded = isRegimeRecorded(cp);
    let status: TaskStatus = "never";
    if (!pt.weekday) status = "off";
    else if (recorded) status = "ok";
    else if (due) status = "waiting";
    else status = "idle";

    const lean = regimeLeanLabel(cp, due);
    return withToday({
      id: `regime-${min}`,
      // Time lives in dueTimeLabel only — don't duplicate in the name.
      name: "Session regime",
      summary: lean,
      purpose: `SPY/QQQ checkpoint at ${label} (+${min}m). Same slots as Live Regime.`,
      schedule: `Weekdays ${label}`,
      frequencyRank: 10 + i * 0.01,
      frequency: "intraday",
      lastRun: recorded && cp?.timestamp ? new Date(cp.timestamp).toISOString() : null,
      running: false,
      runner: "api-scheduler",
      status,
      canRun: false,
      canToggle: false,
      enabled: pt.weekday,
      detail: recorded ? (cp?.factors?.[0] ?? null) : null,
      outcome: lean,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: pt.weekday,
      dueTimeLabel: label,
      dueMinutesPt: dueMin,
      verifyChecks: pt.weekday
        ? [vcheck(recorded, lean, null)]
        : [],
    }, pt);
  });

  // Single catalog row for All tasks (Today still lists each checkpoint time)
  const recordedToday = checkpoints.filter((c) => isRegimeRecorded(c));
  const latestResolved = [...recordedToday]
    .filter((c) => c.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const regimeCatalog = withToday({
    id: "regime",
    name: "Session Regime",
    summary: `${recordedToday.length}/${CHECKPOINTS_MIN.length} recorded`,
    purpose: "One job, many fires: SPY/QQQ session checkpoints at the same 11 times as Live (6:45 AM–12:00 PM PT). Today’s agenda shows each time; this row is the job itself.",
    schedule: "Weekdays · 11× (6:45 AM–12:00 PM PT)",
    frequencyRank: 10,
    frequency: "11× / session",
    lastRun: latestResolved?.timestamp ? new Date(latestResolved.timestamp).toISOString() : null,
    running: false,
    runner: "api-scheduler",
    status: !pt.weekday ? "off" : recordedToday.length > 0 ? "ok" : "idle",
    canRun: true,
    canToggle: false,
    enabled: true,
    outcome: latestResolved
      ? `${regimeLeanLabel(latestResolved, true)} · ${recordedToday.length}/${CHECKPOINTS_MIN.length}`
      : `0/${CHECKPOINTS_MIN.length}`,
    logFiles: [join(LOG_DIR, "api.log")],
    dueToday: false,
    dueTimeLabel: null,
    dueMinutesPt: null,
  }, pt);

  const stackLd = launchdState("com.fildi.stack-ensure");
  const stackStatus: TaskStatus = stackLd === "missing" ? "missing" : "idle";
  return { pt, maintainHeal, maintainFull, maintain, healActions, fullActions, merged, rbh, PROCESS, failedChecks, derivedProcessFailed, derivedVendorFailed, processOk, vendorsOk, jobOk, maintainTs, maintainActionsList, maintainActions, maintainRanToday, retentionOk, morningPreOk, maintainActionFail, maintainLd, maintainStatus, rbhStarted, rbhOk, rbhDetail, rbhStage, rbhLd, csv, ingestRanToday, rbhPromptLd, rbhPrompt, rbhPromptDecision, rbhPromptAt, rbhExportStatus, rbhIngestStatus, enrichmentDisabled, degradedFlag, snapshotDegraded, utcHourAsPtLabel, ptHour24, suffix, h12, utcHourAsPtMinutes, cpByMin, regimeRows, cp, dueMin, label, due, recorded, status, lean, recordedToday, latestResolved, regimeCatalog, stackLd, stackStatus, checkpoints, researchReport };
}
