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

export function inventoryRows3(inv: Inv): ScheduledTaskRow[] {
  const { pt, maintainHeal, maintainFull, maintain, healActions, fullActions, merged, rbh, PROCESS, failedChecks, derivedProcessFailed, derivedVendorFailed, processOk, vendorsOk, jobOk, maintainTs, maintainActionsList, maintainActions, maintainRanToday, retentionOk, morningPreOk, maintainActionFail, maintainLd, maintainStatus, rbhStarted, rbhOk, rbhDetail, rbhStage, rbhLd, csv, ingestRanToday, rbhPromptLd, rbhPrompt, rbhPromptDecision, rbhPromptAt, rbhExportStatus, rbhIngestStatus, enrichmentDisabled, degradedFlag, snapshotDegraded, utcHourAsPtLabel, ptHour24, suffix, h12, utcHourAsPtMinutes, cpByMin, regimeRows, cp, dueMin, label, due, recorded, status, lean, recordedToday, latestResolved, regimeCatalog, stackLd, stackStatus, checkpoints, researchReport } = inv as Inv & Record<string, unknown>;
  return [
    // Retention is NOT a separate product task — folded into Mac Maintain (and API day backup).
    // It only deletes old ai_usage_log / api_usage / stale intraday app_config keys — never fundamentals.
    withToday({
      id: "rbh-export",
      name: "RH Portfolio Export",
      summary: "Ask-first dialog → Claude session → today’s CSVs",
      purpose:
        "Stage 1: LaunchAgent com.fildi.rbh-export-prompt (weekdays after close) asks first; Run opens a Claude session that writes RH CSVs. Status from export_prompt_last.json + CSV presence.",
      schedule: "Weekdays after close · asks first (hourly catch-up)",
      frequencyRank: 29,
      frequency: "weekdays",
      lastRun: csv.ready
        ? (() => {
            try {
              return statSync(join(homedir(), "rbh_scripts", `robinhood-holdings-${csv.todayStamp}.csv`)).mtime.toISOString();
            } catch { return rbhPromptAt; }
          })()
        : rbhPromptAt,
      running: rbhPromptDecision === "in_progress" || rbhPromptDecision === "launched",
      runner: "launchd",
      status: rbhExportStatus,
      canRun: false,
      canToggle: true,
      enabled: rbhPromptLd === "loaded",
      detail: csv.ready
        ? `CSVs ready (${csv.count}/3)`
        : `CSVs ${csv.count}/3 · prompt=${rbhPromptDecision ?? "—"}`,
      outcome: csv.ready
        ? `CSVs ${csv.count}/3`
        : rbhPromptDecision
          ? `prompt ${rbhPromptDecision}`
          : null,
      logFiles: [RBH_EXPORT_PROMPT_LAST],
      dueToday: pt.weekday,
      dueTimeLabel: "~1:15 PM PT+",
      dueMinutesPt: 13 * 60 + 15,
      verifyChecks: pt.weekday
        ? [
            vcheck(rbhPromptLd === "loaded", "Ask-first LaunchAgent loaded", "Install com.fildi.rbh-export-prompt from ~/rbh_scripts"),
            vcheck(csv.ready, `Today’s RH CSVs present (${csv.count}/3)`, "Respond to the export dialog (Run) after close"),
          ]
        : [],
    }, pt),
    withToday({
      id: "rbh-ingest",
      name: "RH Portfolio Ingest",
      summary: "CSVs → Postgres (LaunchAgent)",
      purpose: "Stage 2: weekdays 3:00 PM PT (catch-up on wake, 7-day window). Waits on Export CSVs.",
      schedule: "Weekdays 3:00 PM PT (catch-up on wake)",
      frequencyRank: 30,
      frequency: "weekdays",
      lastRun: rbhStarted,
      running: false,
      runner: "launchd",
      status: rbhIngestStatus,
      canRun: true,
      canToggle: true,
      enabled: rbhLd === "loaded",
      detail: csv.ready
        ? `export ready · ${rbhDetail ?? rbhStage ?? ""}`
        : `blocked on export (${csv.count}/3) · ${rbhDetail ?? ""}`,
      outcome: ingestRanToday && rbhOk
        ? rbhStage === "no-op"
          ? "no-op · current"
          : `${rbhStage ?? "ok"}${rbhDetail ? ` · ${String(rbhDetail).slice(0, 28)}` : ""}`
        : null,
      logFiles: [RBH_LAST, RBH_LOG],
      dueToday: pt.weekday,
      dueTimeLabel: "3:00 PM PT",
      dueMinutesPt: 15 * 60,
      verifyChecks: pt.weekday
        ? [
            vcheck(csv.ready, "Export CSVs ready", "Finish RH Portfolio Export first"),
            // no-op success after export already ingested earlier same day still counts
            vcheck(
              ingestRanToday && rbhOk === true,
              rbhStage === "no-op" ? "Ingest ran (no-op — already current)" : "Ingest succeeded today",
              "Run now once CSVs exist; check rbh last_run.json",
            ),
          ]
        : [],
    }, pt),
    withToday({
      id: "option-scores",
      name: "Option Score Snapshots",
      summary: "Save Overall options rankings",
      purpose: "Weekdays ~7:00 AM PT inside the Model List run (live quotes, feeds that day's picks). Noon Mon–Thu = fallback only if the morning scan failed. Friday also dual-written by Model Snapshot.",
      schedule: "Weekdays ~7:00 AM PT (noon fallback)",
      frequencyRank: 35,
      frequency: "weekdays",
      lastRun: lastOptionScoreRun?.toISOString() ?? null,
      running: optionScoreRunning,
      runner: "api-scheduler",
      status: apiStatus(optionScoreRunning, lastOptionScoreRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      detail: null as string | null,
      outcome: (() => {
        const stamped = ranPtToday(lastOptionScoreRun?.toISOString() ?? null, pt.ymd);
        if (!stamped) return null;
        const src = getOptionsChainSourceStats();
        if (src.total === 0) return "option scores saved";
        return `option scores · chains ${src.schwabSharePct}% Schwab / ${100 - (src.schwabSharePct ?? 0)}% Yahoo (n=${src.total})`;
      })(),
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: pt.weekday && pt.dow !== 5,
      dueTimeLabel: pt.weekday && pt.dow !== 5 ? utcHourAsPtLabel(19) : null,
      dueMinutesPt: pt.weekday && pt.dow !== 5 ? utcHourAsPtMinutes(19) : null,
      verifyChecks: pt.weekday && pt.dow !== 5
        ? [
            vcheck(
              ranPtToday(lastOptionScoreRun?.toISOString() ?? null, pt.ymd),
              "Option score snapshot stamped today",
              "Run now (needs API + Yahoo chains)",
            ),
          ]
        : [],
    }, pt),
    withToday({
      id: "model-snapshot",
      name: "Model Snapshot",
      summary: "Save best option picks for the track record",
      purpose: "Friday live-bid freeze (+ dual-writes option score snapshots).",
      schedule: "Fri ~12:00 PM PT",
      frequencyRank: 50,
      frequency: "weekly",
      lastRun: lastModelSnapshotRun?.toISOString() ?? null,
      running: modelSnapshotRunning,
      runner: "api-scheduler",
      status: snapshotDegraded
        ? "degraded"
        : apiStatus(modelSnapshotRunning, lastModelSnapshotRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      outcome: ranPtToday(lastModelSnapshotRun?.toISOString() ?? null, pt.ymd)
        ? snapshotDegraded
          ? "saved · degraded"
          : "picks frozen"
        : null,
      logFiles: [join(LOG_DIR, "api.log"), join(LOG_DIR, "model-snapshot-last.json")],
      dueToday: pt.dow === 5,
      dueTimeLabel: pt.dow === 5 ? utcHourAsPtLabel(19) : null,
      dueMinutesPt: pt.dow === 5 ? utcHourAsPtMinutes(19) : null,
      verifyChecks: pt.dow === 5
        ? [
            vcheck(
              ranPtToday(lastModelSnapshotRun?.toISOString() ?? null, pt.ymd),
              "Model snapshot stamped today",
              "Run now; ensure stack is up at noon Friday",
            ),
            vcheck(!snapshotDegraded, "Snapshot not degraded (live bids)", "Re-run after market open with healthy Yahoo"),
          ]
        : [],
    }, pt),
    withToday({
      id: "model-grade",
      name: "Model Grade + Expiry",
      summary: "Score last week’s picks; close expired trades",
      purpose: "Grades saved picks and settles expired option trade ideas.",
      schedule: "Fri evening / Sat early",
      frequencyRank: 55,
      frequency: "weekly",
      lastRun: lastTradeExpiryRun?.toISOString() ?? null,
      running: tradeExpiryRunning,
      runner: "api-scheduler",
      status: apiStatus(tradeExpiryRunning, lastTradeExpiryRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      outcome: ranPtToday(lastTradeExpiryRun?.toISOString() ?? null, pt.ymd)
        ? "graded / expired"
        : null,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: pt.dow === 5 || pt.dow === 6,
      dueTimeLabel: pt.dow === 5 ? "~7:00 PM PT" : pt.dow === 6 ? "Sat early" : null,
      dueMinutesPt: pt.dow === 5 ? 19 * 60 : pt.dow === 6 ? 0 : null,
      verifyChecks: pt.dow === 5 || pt.dow === 6
        ? [
            vcheck(
              ranPtToday(lastTradeExpiryRun?.toISOString() ?? null, pt.ymd),
              "Grade / expiry job stamped today",
              "Run now",
            ),
          ]
        : [],
    }, pt),
    withToday({
      id: "ai-workflow-review",
      name: "AI / Cursor Workflow Review",
      summary: "Weekly token/context audit with measurable before→after",
      purpose: "Supervised Sunday review: snapshot hot context + skills + oversized MD, act on checklist, then --verify. Proves help via hotContextEstTokens Δ (bytes/4). Not DB retention — that stays under Mac Maintain.",
      schedule: "Weekly · Sun ~6:00 PM PT",
      frequencyRank: 70,
      frequency: "weekly",
      lastRun: (() => {
        try {
          const p = join(ROOT, ".cursor/context/ai-workflow-reviews/baseline.json");
          if (!existsSync(p)) return null;
          return statSync(p).mtime.toISOString();
        } catch { return null; }
      })(),
      running: false,
      runner: "supervised",
      status: (() => {
        try {
          const p = join(ROOT, ".cursor/context/ai-workflow-reviews/baseline.json");
          if (!existsSync(p)) return "never";
          const ran = ranPtToday(statSync(p).mtime.toISOString(), pt.ymd);
          return ran ? "ok" : "idle";
        } catch { return "never"; }
      })(),
      canRun: true,
      canToggle: false,
      enabled: true,
      detail: "node .cursor/scripts/ai-workflow-review.mjs → --verify",
      logFiles: [
        join(ROOT, ".cursor/context/ai-workflow-reviews/baseline.json"),
      ],
      dueToday: pt.dow === 0,
      dueTimeLabel: pt.dow === 0 ? "6:00 PM PT" : null,
      dueMinutesPt: pt.dow === 0 ? 18 * 60 : null,
      verifyChecks: pt.dow === 0
        ? [
            vcheck(
              (() => {
                try {
                  const p = join(ROOT, ".cursor/context/ai-workflow-reviews/baseline.json");
                  return existsSync(p) && ranPtToday(statSync(p).mtime.toISOString(), pt.ymd);
                } catch { return false; }
              })(),
              "Baseline snapshot refreshed today",
              "Run now (writes report under .cursor/context/ai-workflow-reviews/)",
            ),
            vcheck(
              (() => {
                try {
                  const day = pt.ymd;
                  return existsSync(join(ROOT, `.cursor/context/ai-workflow-reviews/${day}-verify.json`));
                } catch { return false; }
              })(),
              "Verify JSON present for today (prove Δ)",
              "After cleanup: node .cursor/scripts/ai-workflow-review.mjs --verify",
            ),
          ]
        : [],
    }, pt),
    (() => {
      const digPath = join(LOG_DIR, "weekly-data-ops-last.json");
      const dig = readJsonFile(digPath);
      const digTs = typeof dig?.ts === "string" ? dig.ts : null;
      const digAgeDays = digTs ? (Date.now() - new Date(digTs).getTime()) / 86_400_000 : null;
      const digFresh = digAgeDays != null && digAgeDays <= 8;
      const digToday = ranPtToday(digTs, pt.ymd);
      let digStatus: TaskStatus = "never";
      if (digToday) digStatus = "ok";
      else if (digFresh) digStatus = "idle";
      else if (digTs) digStatus = "warn";
      return withToday({
        id: "ops-digest",
        name: "Weekly Ops Digest",
        summary: "Scoreboard → value-log (no second FactSet drain)",
        purpose:
          "Sunday spine via Mac Maintain (--digest-only): audit gold/NR/peers and append .cursor/context/data-ops-value-log.md. Skips drain/peer when Maintain already covered them ≤7d. Manual Run now uses the same digest-only path.",
        schedule: "Sunday · with Maintain 7:00 AM PT",
        frequencyRank: 49,
        frequency: "weekly",
        lastRun: digTs,
        running: false,
        runner: "launchd",
        status: digStatus,
        canRun: true,
        canToggle: false,
        enabled: true,
        detail: "node scripts/weekly-data-ops-check.mjs --digest-only",
        outcome: digTs
          ? `${dig?.improved === true ? "improved" : dig?.improved === false ? "no change" : "logged"} · ${ageLabel(digTs)}`
          : null,
        logFiles: [
          digPath,
          join(LOG_DIR, "data-ops-value"),
          join(ROOT, ".cursor/context/data-ops-value-log.md"),
        ],
        dueToday: pt.dow === 0,
        dueTimeLabel: pt.dow === 0 ? "7:00 AM PT" : null,
        dueMinutesPt: pt.dow === 0 ? 7 * 60 : null,
        verifyChecks: pt.dow === 0
          ? [
              vcheck(
                digToday || maintainActionsList.some((a) => /^ops_digest_exit_0$/.test(a)),
                "Ops digest written today",
                "Run now, or Run Mac Maintain · full (Sunday)",
              ),
            ]
          : [],
      }, pt);
    })(),
    (() => {
      const last = readLast(PM_ALERTS_LAST);
      const ld = launchdState("com.fildi.pm-alerts");
      return withToday({
        id: "pm-alerts",
        name: "Portfolio Alerts",
        summary: "Book odds → Live › Portfolio Alerts",
        purpose: "pm_book --live (Schwab quotes) → Monte Carlo odds of margin call / assignment > cash / crash budget → bullets only when a level changes. Also stores the Book card (pm_book_latest).",
        schedule: "Every 15 min 6:30 AM–1:15 PM PT · every 2 h otherwise",
        frequencyRank: 5,
        frequency: "intraday",
        lastRun: last?.ts ?? null,
        running: false,
        runner: "launchd",
        status: pmJobStatus(last, 3, "com.fildi.pm-alerts"),
        canRun: true,
        canToggle: true,
        enabled: ld === "loaded",
        detail: last?.detail ?? null,
        outcome: last?.detail ?? null,
        logFiles: [PM_ALERTS_LAST, "/tmp/fildi-logs/pm-alerts.err"],
        dueToday: true,
        dueTimeLabel: "every 15 min",
        dueMinutesPt: null,
        verifyChecks: [vcheck(ld === "loaded", "LaunchAgent loaded", "scripts/install-pm-alerts-launchd.sh")],
      }, pt);
    })(),
    (() => {
      const last = readLast(TRANSCRIPTS_LAST);
      const ld = launchdState("com.fildi.transcripts");
      return withToday({
        id: "transcripts",
        name: "Earnings Call Transcripts",
        summary: "AV transcripts → Haiku summary (≤ 20/day)",
        purpose: "Rotates book names → plan names → model universe through the Alpha Vantage 25/day budget; summarizes guidance, model inputs, tone. Feeds Breakdown › Earnings calls and Portfolio Alerts › Your names.",
        schedule: "Daily 8:00 AM PT (after the Model List)",
        frequencyRank: 20,
        frequency: "daily",
        lastRun: last?.ts ?? null,
        running: false,
        runner: "launchd",
        status: pmJobStatus(last, 30, "com.fildi.transcripts"),
        canRun: true,
        canToggle: true,
        enabled: ld === "loaded",
        detail: last?.detail ?? null,
        outcome: last?.detail ?? null,
        logFiles: [TRANSCRIPTS_LAST, "/tmp/fildi-logs/transcripts.err"],
        dueToday: true,
        dueTimeLabel: "8:00 AM PT",
        dueMinutesPt: 8 * 60,
        verifyChecks: [vcheck(ld === "loaded", "LaunchAgent loaded", "scripts/install-transcripts-launchd.sh")],
      }, pt);
    })(),
    (() => {
      const last = readLast(OPENJEV_LAST);
      const ld = launchdState("com.fildi.openjev");
      return withToday({
        id: "openjev",
        name: "OpenJev Forecasts (local)",
        summary: "Local 26B model answers the forecast-ledger questions (A129)",
        purpose: "Freezes each day's stock states + questions at 5:30 AM, then answers them with the local OpenJev model when RAM allows (load → answer → unload). Graded vs market odds in the forecast ledger.",
        schedule: "Freeze 5:30 AM PT · answer 5:30–9:00 AM or 9:00–11:30 PM PT",
        frequencyRank: 21,
        frequency: "daily",
        lastRun: last?.ts ?? null,
        running: false,
        runner: "launchd",
        status: pmJobStatus(last, 30, "com.fildi.openjev"),
        canRun: true,
        canToggle: true,
        enabled: ld === "loaded",
        detail: last?.detail ?? null,
        outcome: last?.detail ?? null,
        logFiles: [OPENJEV_LAST, "/tmp/fildi-logs/openjev.err", "/tmp/fildi-logs/openjev-server.log"],
        dueToday: true,
        dueTimeLabel: "5:30 AM PT",
        dueMinutesPt: 5 * 60 + 30,
        verifyChecks: [vcheck(ld === "loaded", "LaunchAgent loaded", "scripts/install-openjev-launchd.sh")],
      }, pt);
    })(),
    withToday({
      id: "enrichment-api",
      name: "In-process Enrichment",
      summary: enrichmentDisabled ? "Off — Maintain does this" : "Full fundamentals refresh",
      purpose: enrichmentDisabled
        ? "Off on purpose. Mac Maintain owns enrichment."
        : "Legacy full enrich. Prefer Maintain on Mac.",
      schedule: enrichmentDisabled ? "Off" : "Sun/Thu",
      frequencyRank: 90,
      frequency: enrichmentDisabled ? "off" : "twice-weekly",
      lastRun: lastEnrichmentRun?.toISOString() ?? null,
      running: enrichmentRunning,
      runner: "api-scheduler",
      status: enrichmentDisabled
        ? "off"
        : apiStatus(enrichmentRunning, lastEnrichmentRun?.toISOString() ?? null),
      canRun: false,
      canToggle: false,
      enabled: !enrichmentDisabled,
      logFiles: [],
      dueToday: false,
      dueTimeLabel: null,
      dueMinutesPt: null,
    }, pt),
  ];
}
