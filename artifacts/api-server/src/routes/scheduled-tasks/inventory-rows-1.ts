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

export function inventoryRows1(inv: Inv): ScheduledTaskRow[] {
  const { pt, maintainHeal, maintainFull, maintain, healActions, fullActions, merged, rbh, PROCESS, failedChecks, derivedProcessFailed, derivedVendorFailed, processOk, vendorsOk, jobOk, maintainTs, maintainActionsList, maintainActions, maintainRanToday, retentionOk, morningPreOk, maintainActionFail, maintainLd, maintainStatus, rbhStarted, rbhOk, rbhDetail, rbhStage, rbhLd, csv, ingestRanToday, rbhPromptLd, rbhPrompt, rbhPromptDecision, rbhPromptAt, rbhExportStatus, rbhIngestStatus, enrichmentDisabled, degradedFlag, snapshotDegraded, utcHourAsPtLabel, ptHour24, suffix, h12, utcHourAsPtMinutes, cpByMin, regimeRows, cp, dueMin, label, due, recorded, status, lean, recordedToday, latestResolved, regimeCatalog, stackLd, stackStatus, checkpoints, researchReport } = inv as Inv & Record<string, unknown>;
  return [
    ...regimeRows,
    regimeCatalog,
    withToday({
      id: "maintain",
      name: "Mac Maintain",
      summary: "7:00 AM full · 12:00/2:45 PM heal",
      purpose: "Two LaunchAgents, one purpose (keep the Mac stack up before you open ~8 AM): (1) 7:00 AM PT full — heal API/Vite, lean enrich, scores, retention prune, morning precompute; Sundays also run Weekly Ops Digest (audit + value-log, no second FactSet drain). Hard-fail fires a macOS notification. (2) 12:00 PM + 2:45 PM PT heal-only. Does NOT shrink Cursor chat tokens.",
      schedule: "7:00 AM full · Sun digest · 12:00/2:45 heal",
      frequencyRank: 20,
      frequency: "3× / day",
      lastRun: maintainTs,
      running: false,
      runner: "launchd",
      status: maintainStatus === "missing" && stackLd === "missing" ? "missing" : maintainStatus,
      canRun: true,
      canToggle: true,
      enabled: maintainLd === "loaded",
      detail: maintainActions,
      outcome: (() => {
        const b = maintain?.budget as Record<string, unknown> | null | undefined;
        const parts: string[] = [];
        if (processOk) parts.push("stack OK");
        if (retentionOk) parts.push("retention");
        if (morningPreOk) parts.push("precompute");
        if (b?.goldCoverage) parts.push(`gold ${String(b.goldCoverage)}`);
        if (b?.fieldFillPct != null) parts.push(`fill ${b.fieldFillPct}%`);
        if (b?.fundScoreCoverage) parts.push(`scores ${String(b.fundScoreCoverage)}`);
        if (b?.unscoredActive != null) parts.push(`${b.unscoredActive} unscored`);
        return parts.length ? parts.join(" · ") : (maintainActions ? String(maintainActions).slice(0, 48) : null);
      })(),
      logFiles: [
        join(LOG_DIR, "maintain-last.json"),
        join(LOG_DIR, "maintain-full-last.json"),
        join(LOG_DIR, "maintain-launchd.out"),
        join(LOG_DIR, "maintain-launchd.err"),
        join(LOG_DIR, "stack-ensure-launchd.out"),
        join(LOG_DIR, "stack-ensure-launchd.err"),
      ],
      dueToday: true,
      dueTimeLabel: "7:00 AM PT",
      dueMinutesPt: 7 * 60,
      verifyChecks: [
        vcheck(maintainLd === "loaded", "LaunchAgent loaded", "Run scripts/install-maintenance-launchd.sh"),
        vcheck(maintainRanToday, "Maintain report written today", "Run now (or open Mac by ~7 so launchd fires)"),
        vcheck(processOk === true, "API / Vite / Postgres healthy", "Run now — heals local stack"),
        vcheck(jobOk !== false, "Maintain job did not hard-fail", "Open maintain-last.json; Run now"),
        vcheck(
          !maintainRanToday || retentionOk || morningPreOk,
          "Full pass today (retention and/or morning precompute)",
          "Run Mac Maintain · full (7 AM enrich path)",
        ),
        vcheck(
          !maintainActionFail,
          "Maintain actions exited cleanly",
          "Open maintain-last.json actions[]; Run Maintain or Remediate",
        ),
      ],
    }, pt),
    // Today agenda slots for midday heal (hidden from All catalog — merged into Maintain)
    withToday({
      id: "stack-ensure",
      name: "Mac Maintain · heal",
      summary: "Midday API/Vite heal only (no enrich)",
      purpose: "12:00 PM PT heal-only LaunchAgent — keep API/Vite up for trading without re-running enrich.",
      schedule: "Daily · 12:00 PM PT",
      frequencyRank: 21,
      frequency: "heal",
      lastRun: null,
      running: false,
      runner: "launchd",
      status: stackStatus,
      canRun: true,
      canToggle: true,
      enabled: stackLd === "loaded",
      detail: "maintain.mjs --restart-if-unhealthy",
      logFiles: [
        join(LOG_DIR, "stack-ensure-launchd.out"),
        join(LOG_DIR, "stack-ensure-launchd.err"),
      ],
      dueToday: true,
      dueTimeLabel: "12:00 PM PT",
      dueMinutesPt: 12 * 60,
      verifyChecks: [
        vcheck(stackLd === "loaded", "Stack-ensure LaunchAgent loaded", "Run scripts/install-stack-ensure-launchd.sh"),
        vcheck(processOk === true, "API / Vite / Postgres healthy now", "Run this heal slot now"),
      ],
    }, pt),
    withToday({
      id: "stack-ensure-1445",
      name: "Mac Maintain · heal",
      summary: "Afternoon API/Vite heal only",
      purpose: "2:45 PM PT heal-only — keep stack warm into the afternoon / Friday snapshot window.",
      schedule: "Daily · 2:45 PM PT",
      frequencyRank: 21.5,
      frequency: "heal",
      lastRun: null,
      running: false,
      runner: "launchd",
      status: stackStatus,
      canRun: true,
      canToggle: false,
      enabled: stackLd === "loaded",
      logFiles: [join(LOG_DIR, "stack-ensure-launchd.out")],
      dueToday: true,
      dueTimeLabel: "2:45 PM PT",
      dueMinutesPt: 14 * 60 + 45,
      verifyChecks: [
        vcheck(processOk === true, "API / Vite / Postgres healthy now", "Run Mac Maintain · heal"),
      ],
    }, pt),
    withToday({
      id: "event-bullets",
      name: "Event Bullets",
      summary: "Watchlist-only bull/bear lines (DB, no API)",
      purpose: "Runs ~7:00 AM PT via Mac Maintain morning precompute (scheduler backup 7–9 AM PT). Watchlist union only — template bullets for stock breakdown.",
      schedule: "Daily · ~7:00 AM PT (with Maintain)",
      frequencyRank: 22,
      frequency: "once daily",
      lastRun: lastEventBulletsRun?.toISOString() ?? null,
      running: eventBulletsRunning,
      runner: "api-scheduler",
      status: apiStatus(eventBulletsRunning, lastEventBulletsRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      outcome: ranPtToday(lastEventBulletsRun?.toISOString() ?? null, pt.ymd)
        ? "bullets refreshed"
        : morningPreOk
          ? "via Maintain"
          : null,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: true,
      dueTimeLabel: utcHourAsPtLabel(14),
      dueMinutesPt: utcHourAsPtMinutes(14),
      verifyChecks: [
        vcheck(
          ranPtToday(lastEventBulletsRun?.toISOString() ?? null, pt.ymd) || morningPreOk,
          "Event-bullets job stamped today",
          "Run now, or Run Mac Maintain · full",
        ),
      ],
    }, pt),
    withToday({
      id: "earnings-backfill",
      name: "Earnings History Backfill",
      summary: "Warm ≤60 stale tickers/day (not all names)",
      purpose: "Runs ~7:00 AM PT with Maintain morning precompute. Only tickers whose reported EPS history is >30d stale (≤60/day drip). Most days write 0 — earnings actuals rarely change; this is backlog warm, not a daily re-fetch of the universe.",
      schedule: "Daily · ~7:00 AM PT (with Maintain)",
      frequencyRank: 23,
      frequency: "once daily",
      lastRun: lastEarningsBackfillRun?.toISOString() ?? null,
      running: earningsBackfillRunning,
      runner: "api-scheduler",
      status: apiStatus(earningsBackfillRunning, lastEarningsBackfillRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      outcome: ranPtToday(lastEarningsBackfillRun?.toISOString() ?? null, pt.ymd)
        ? "≤60 stale EPS warmed"
        : null,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: true,
      dueTimeLabel: utcHourAsPtLabel(14),
      dueMinutesPt: utcHourAsPtMinutes(14),
      verifyChecks: [
        vcheck(
          ranPtToday(lastEarningsBackfillRun?.toISOString() ?? null, pt.ymd) || morningPreOk,
          "Earnings backfill stamped today",
          "Run now, or Run Mac Maintain · full",
        ),
      ],
    }, pt),
    withToday({
      id: "fmp-analyst-feed",
      name: "FMP Analyst Feed",
      summary: "One global tape poll (not per-ticker)",
      purpose: "Runs ~7:00 AM PT with Maintain morning precompute. Archives FMP’s locked global grades/PT tape.",
      schedule: "Daily · ~7:00 AM PT (with Maintain)",
      frequencyRank: 24,
      frequency: "once daily",
      lastRun: lastFmpAnalystFeedRun?.toISOString() ?? null,
      running: fmpAnalystFeedRunning,
      runner: "api-scheduler",
      status: apiStatus(fmpAnalystFeedRunning, lastFmpAnalystFeedRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      outcome: ranPtToday(lastFmpAnalystFeedRun?.toISOString() ?? null, pt.ymd)
        ? "FMP tape archived"
        : null,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: true,
      dueTimeLabel: utcHourAsPtLabel(14),
      dueMinutesPt: utcHourAsPtMinutes(14),
      verifyChecks: [
        vcheck(
          ranPtToday(lastFmpAnalystFeedRun?.toISOString() ?? null, pt.ymd) || morningPreOk,
          "FMP analyst feed stamped today",
          "Run now, or Run Mac Maintain · full",
        ),
      ],
    }, pt),
    withToday({
      id: "desk-ingest",
      name: "Desk Commentary Ingest",
      summary: "Drive FactSet briefs → desk_commentaries",
      purpose: "Polls TradeDash Briefs Drive folder every ~25m for new Gmail→Drive JSON. Incremental (mtime ≥ last run). No market-data RPM.",
      schedule: "Every ~25 min (api-scheduler)",
      frequencyRank: 25,
      frequency: "every 25m",
      lastRun: lastDeskIngestRun?.toISOString() ?? null,
      running: deskIngestRunning,
      runner: "api-scheduler",
      status: apiStatus(deskIngestRunning, lastDeskIngestRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: true,
      dueTimeLabel: "ongoing",
      dueMinutesPt: null,
      outcome:
        lastDeskIngestRun != null
          ? `desk ${ageLabel(lastDeskIngestRun.toISOString())}`
          : null,
      verifyChecks: [
        vcheck(
          lastDeskIngestRun != null && Date.now() - lastDeskIngestRun.getTime() < 2 * 60 * 60 * 1000,
          "Desk ingest ran within 2h",
          "Run now",
        ),
      ],
    }, pt),
    (() => {
      const schwab = getSchwabAuthStatus();
      const days = schwab.refreshDaysLeft;
      const warn = days != null && days < 2;
      const failed = schwab.configured && schwab.hasTokens && Boolean(schwab.lastError) && !schwab.accessValid;
      return withToday({
        id: "schwab-health",
        name: "Schwab Auth Health",
        summary: "Refresh access token + warn before 7d re-auth",
        purpose: "Every ~6h: refresh Schwab access token (keeps ~/.tradedash/schwab-tokens.json warm) and log if the 7-day refresh token is nearing expiry. No chains/quotes — zero market-data RPM. Re-auth: node --env-file=.env.local scripts/schwab-oauth.mjs",
        schedule: "Every ~6h (api-scheduler)",
        frequencyRank: 26,
        frequency: "every 6h",
        lastRun: lastSchwabHealthRun?.toISOString() ?? null,
        running: schwabHealthRunning,
        runner: "api-scheduler",
        status: schwabHealthRunning
          ? "running"
          : failed
            ? "failed"
            : warn
              ? "warn"
              : apiStatus(false, lastSchwabHealthRun?.toISOString() ?? null),
        canRun: true,
        canToggle: false,
        enabled: schwab.configured,
        detail: days != null ? `refresh token ~${days.toFixed(1)}d left` : schwab.hasTokens ? null : "not linked",
        outcome: !schwab.configured
          ? "not configured"
          : failed
            ? "token fail"
            : days != null
              ? `refresh ${days.toFixed(1)}d`
              : schwab.hasTokens
                ? "linked"
                : "not linked",
        logFiles: [join(LOG_DIR, "api.log")],
        dueToday: schwab.configured,
        dueTimeLabel: "every 6h",
        dueMinutesPt: null,
        verifyChecks: [
          vcheck(
            !schwab.configured || (schwab.hasTokens && (days == null || days >= 1)),
            schwab.configured
              ? days != null && days < 1
                ? "Refresh token <24h — re-run oauth"
                : "Schwab tokens present"
              : "Schwab credentials not configured (ok)",
            "node --env-file=.env.local scripts/schwab-oauth.mjs",
          ),
        ],
      }, pt);
    })(),
    withToday({
      id: "schwab-1m",
      name: "Schwab 1m Bars",
      summary: "RTH 1m → intraday_bars_1m (source=schwab)",
      purpose:
        "A194: every ~5 min in RTH after 07:05 PT, pull 1m OHLCV for ~20 symbols via Schwab /pricehistory and upsert watchlist_sync.intraday_bars_1m. Soft-skips if shared Schwab RPM ≥ 60. Manual Run forces one cycle (2h lookback). Backfill ≤10d: POST with force via admin or runSchwab1mBackfill.",
      schedule: "Every ~5 min RTH after 07:05 PT (api-scheduler)",
      frequencyRank: 28,
      frequency: "every 5m RTH",
      lastRun: lastSchwab1mPollRun?.toISOString() ?? null,
      running: schwab1mPollRunning,
      runner: "api-scheduler",
      status: apiStatus(schwab1mPollRunning, lastSchwab1mPollRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: getSchwabAuthStatus().configured,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: true,
      dueTimeLabel: "RTH 5m",
      dueMinutesPt: null,
      outcome:
        lastSchwab1mPollRun != null
          ? `1m ${ageLabel(lastSchwab1mPollRun.toISOString())}`
          : null,
      verifyChecks: [
        vcheck(
          lastSchwab1mPollRun != null && Date.now() - lastSchwab1mPollRun.getTime() < 30 * 60 * 1000,
          "Schwab 1m poll stamped within 30m (during RTH)",
          "Run now (market hours)",
        ),
      ],
    }, pt),
    (() => {
      const r = researchReport;
      const deskDown = r != null && !r.lseg.desktopProxy.reachable;
      const wrdsBad = r != null && (r.wrds.overall === "down" || r.wrds.overall === "missing");
      const localBad = r != null && !r.localDb.ok;
      return withToday({
        id: "research-ops-health",
        name: "Research Ops Health",
        summary: "WRDS/LSEG cache freshness + LSEG desktop proxy (no vendor sync)",
        purpose:
          "Every ~6h: probe local wrds_research/lseg_research.sync_state age and TCP to LSEG Workspace (.portInUse, else :9000/:9001/:9060). Never calls WRDS Cloud or opens an LSEG session — refreshes stay manual (lane contract). Analog of Schwab Auth Health. CLI: python research/common/health.py",
        schedule: "Every ~6h (api-scheduler)",
        frequencyRank: 27,
        frequency: "every 6h",
        lastRun: lastResearchOpsRun?.toISOString() ?? r?.checkedAt ?? null,
        running: researchOpsRunning,
        runner: "api-scheduler",
        status: researchOpsRunning
          ? "running"
          : localBad || wrdsBad
            ? "failed"
            : deskDown || (r != null && (r.wrds.overall === "warn" || r.lseg.overall === "warn"))
              ? "warn"
              : apiStatus(false, lastResearchOpsRun?.toISOString() ?? r?.checkedAt ?? null),
        canRun: true,
        canToggle: false,
        enabled: true,
        detail: r
          ? `wrds=${r.wrds.overall} lseg=${r.lseg.overall} desktop=${r.lseg.desktopProxy.reachable ? "up" : "down"}`
          : "not probed yet",
        outcome: r
          ? `WRDS ${r.wrds.overall} · LSEG ${r.lseg.overall} · desk ${r.lseg.desktopProxy.reachable ? "up" : "down"}`
          : null,
        logFiles: [join(LOG_DIR, "api.log")],
        dueToday: true,
        dueTimeLabel: "every 6h",
        dueMinutesPt: null,
        verifyChecks: [
          vcheck(
            !localBad,
            localBad ? "Local Postgres down" : "Local Postgres reachable",
            "Check DATABASE_URL / Postgres",
          ),
          vcheck(
            !wrdsBad,
            wrdsBad ? "WRDS research cache missing/stale" : "WRDS cache present",
            "cd research/wrds && .venv/bin/python sync_ibes.py",
          ),
          vcheck(
            r == null || r.lseg.overall !== "down",
            r?.lseg.overall === "down" ? "LSEG cache down/stale" : "LSEG cache OK (or warn)",
            "Open Workspace + run LSEG daily sync",
          ),
        ],
      }, pt);
    })(),
  ];
}
