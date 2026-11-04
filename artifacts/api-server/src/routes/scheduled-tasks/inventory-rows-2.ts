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

export function inventoryRows2(inv: Inv): ScheduledTaskRow[] {
  const { pt, maintainHeal, maintainFull, maintain, healActions, fullActions, merged, rbh, PROCESS, failedChecks, derivedProcessFailed, derivedVendorFailed, processOk, vendorsOk, jobOk, maintainTs, maintainActionsList, maintainActions, maintainRanToday, retentionOk, morningPreOk, maintainActionFail, maintainLd, maintainStatus, rbhStarted, rbhOk, rbhDetail, rbhStage, rbhLd, csv, ingestRanToday, rbhPromptLd, rbhPrompt, rbhPromptDecision, rbhPromptAt, rbhExportStatus, rbhIngestStatus, enrichmentDisabled, degradedFlag, snapshotDegraded, utcHourAsPtLabel, ptHour24, suffix, h12, utcHourAsPtMinutes, cpByMin, regimeRows, cp, dueMin, label, due, recorded, status, lean, recordedToday, latestResolved, regimeCatalog, stackLd, stackStatus, checkpoints, researchReport } = inv as Inv & Record<string, unknown>;
  return [
    // Supervised research refreshes — never LaunchAgent (LSEG needs Workspace GUI; WRDS is session/Duo limited).
    ...(() => {
      const r = researchReport;
      const ds = (lane: "wrds" | "lseg", name: string) =>
        r?.[lane].datasets.find((d) => d.dataset === name) ?? null;
      const freshest = (...names: { lane: "wrds" | "lseg"; name: string }[]) => {
        const times = names
          .map((n) => ds(n.lane, n.name)?.lastOkAt)
          .filter((t): t is string => !!t)
          .map((t) => new Date(t).getTime());
        if (!times.length) return null;
        return new Date(Math.max(...times)).toISOString();
      };
      const ageOk = (iso: string | null, maxMs: number) =>
        iso != null && Date.now() - new Date(iso).getTime() <= maxMs;
      const day = 24 * 60 * 60 * 1000;
      const lsegDailyAt = freshest(
        { lane: "lseg", name: "signals_daily" },
        { lane: "lseg", name: "events" },
      );
      const lsegWeeklyAt = freshest(
        { lane: "lseg", name: "coverage" },
        { lane: "lseg", name: "security_map_ids" },
        { lane: "lseg", name: "earnings_moves" },
        { lane: "lseg", name: "holders_top" },
        { lane: "lseg", name: "starmine_history" },
        { lane: "lseg", name: "gold_audit" },
      );
      const wrdsIbesAt = freshest(
        { lane: "wrds", name: "ibes_statsum" },
        { lane: "wrds", name: "ibes_surpsum" },
      );
      const wrdsCrspAt = freshest({ lane: "wrds", name: "crsp_dsf" });
      const deskOk = r?.lseg.desktopProxy.reachable !== false;
      const dayOfMonth = Number(pt.ymd.slice(8, 10));

      return [
        withToday({
          id: "lseg-daily-sync",
          name: "LSEG Daily Sync",
          summary: "signals + events (Workspace GUI · supervised)",
          purpose:
            "Weekday refresh of lseg_research.signals_daily + events. Requires Workspace logged in (desktop proxy). Not LaunchAgent — lane contract forbids vendor cron.",
          schedule: "Weekdays after open (supervised)",
          frequencyRank: 28,
          frequency: "weekdays",
          lastRun: lsegDailyAt,
          running: false,
          runner: "supervised" as const,
          status: !r
            ? ("never" as const)
            : ageOk(lsegDailyAt, 2 * day)
              ? ("ok" as const)
              : deskOk
                ? ("idle" as const)
                : ("waiting" as const),
          canRun: false,
          canToggle: false,
          enabled: true,
          detail:
            "cd research/lseg && .venv/bin/python sync_signals.py && .venv/bin/python sync_events.py",
          outcome: lsegDailyAt
            ? `signals ${ageLabel(lsegDailyAt)}${deskOk ? "" : " · desk down"}`
            : null,
          logFiles: [],
          dueToday: pt.weekday,
          dueTimeLabel: pt.weekday ? "~after open" : null,
          dueMinutesPt: pt.weekday ? 7 * 60 : null,
          verifyChecks: pt.weekday
            ? [
                // Fresh cache = Done even if Workspace is closed now.
                vcheck(
                  ageOk(lsegDailyAt, 2 * day),
                  "signals/events refreshed <2d",
                  deskOk
                    ? "cd research/lseg && .venv/bin/python sync_signals.py && .venv/bin/python sync_events.py"
                    : "Open LSEG Workspace (logged in), then run sync_signals + sync_events",
                ),
              ]
            : [],
        }, pt),
        withToday({
          id: "lseg-weekly-sync",
          name: "LSEG Weekly Sync",
          summary: "coverage · ids · moves · holders · StarMine hist · gold audit",
          purpose:
            "Weekly LSEG maintenance pack. Supervised only (Workspace GUI). Writes sync_state for each dataset.",
          schedule: "Weekly (supervised)",
          frequencyRank: 48,
          frequency: "weekly",
          lastRun: lsegWeeklyAt,
          running: false,
          runner: "supervised" as const,
          status: !r
            ? ("never" as const)
            : ageOk(lsegWeeklyAt, 10 * day)
              ? ("ok" as const)
              : ("idle" as const),
          canRun: false,
          canToggle: false,
          enabled: true,
          detail:
            "cd research/lseg && .venv/bin/python coverage.py && sync_ids.py && sync_earnings_moves.py && sync_holders.py && sync_starmine_history.py && audit_gold.py",
          logFiles: [],
          dueToday: pt.dow === 0,
          dueTimeLabel: pt.dow === 0 ? "Sun supervised" : null,
          dueMinutesPt: pt.dow === 0 ? 10 * 60 : null,
          verifyChecks: pt.dow === 0
            ? [
                vcheck(
                  ageOk(lsegWeeklyAt, 10 * day),
                  "Weekly LSEG pack <10d",
                  "Run coverage + sync_ids + earnings_moves + holders + starmine_history + audit_gold",
                ),
              ]
            : [],
        }, pt),
        withToday({
          id: "wrds-monthly-ibes",
          name: "WRDS Monthly IBES",
          summary: "sync_ibes → statsum/surpsum (supervised)",
          purpose:
            "Monthly IBES history refresh into wrds_research. Needs WRDS_USERNAME + Duo/network. Feeds fund growth extras + Street panel. Not LaunchAgent.",
          schedule: "Monthly (supervised)",
          frequencyRank: 65,
          frequency: "monthly",
          lastRun: wrdsIbesAt,
          running: false,
          runner: "supervised" as const,
          status: !r
            ? ("never" as const)
            : ageOk(wrdsIbesAt, 40 * day)
              ? ("ok" as const)
              : ("idle" as const),
          canRun: false,
          canToggle: false,
          enabled: true,
          detail: "cd research/wrds && .venv/bin/python sync_ibes.py",
          outcome: wrdsIbesAt ? `IBES ${ageLabel(wrdsIbesAt)}` : null,
          logFiles: [],
          dueToday: dayOfMonth <= 7,
          dueTimeLabel: dayOfMonth <= 7 ? "early month" : null,
          dueMinutesPt: dayOfMonth <= 7 ? 9 * 60 : null,
          verifyChecks: dayOfMonth <= 7
            ? [
                vcheck(
                  ageOk(wrdsIbesAt, 40 * day),
                  "IBES last_ok <40d",
                  "cd research/wrds && .venv/bin/python sync_ibes.py",
                ),
              ]
            : [],
        }, pt),
        withToday({
          id: "wrds-quarterly-crsp",
          name: "WRDS Quarterly CRSP",
          summary: "sync_crsp → dsf returns (supervised)",
          purpose:
            "Quarterly CRSP daily returns for calibration / event windows. WRDS session required. Not LaunchAgent.",
          schedule: "Quarterly (supervised)",
          frequencyRank: 80,
          frequency: "quarterly",
          lastRun: wrdsCrspAt,
          running: false,
          runner: "supervised" as const,
          status: !r
            ? ("never" as const)
            : ageOk(wrdsCrspAt, 100 * day)
              ? ("ok" as const)
              : ("idle" as const),
          canRun: false,
          canToggle: false,
          enabled: true,
          detail: "cd research/wrds && .venv/bin/python sync_crsp.py",
          logFiles: [],
          dueToday: false,
          dueTimeLabel: null,
          dueMinutesPt: null,
          verifyChecks: [],
        }, pt),
      ];
    })(),
  ];
}
