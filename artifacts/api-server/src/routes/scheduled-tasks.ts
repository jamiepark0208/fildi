/**
 * Admin scheduled-task manager: status + purpose + logs + run/enable/disable.
 * Covers LaunchAgents (maintain, RH ingest) and in-process API scheduler jobs.
 */
import { Router } from "express";
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAdmin } from "../middleware/requireAdmin.js";
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
  runModelSnapshotJob,
  runTradeExpiry,
  runOptionScoreJob,
  runRetentionPrune,
  runRegimeCheckpoints,
  runEventBulletsJob,
  runEarningsBackfillJob,
  runFmpAnalystFeedJob,
  runDeskIngestJob,
  runSchwabHealthJob,
} from "../lib/scheduler.js";
import { getSchwabAuthStatus } from "../lib/schwab-auth.js";
import { CHECKPOINTS_MIN, getTodaysCheckpoints, type RegimeCheckpoint } from "../lib/intraday-regime.js";

const router = Router();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOG_DIR = "/tmp/fildi-logs";
const LAUNCH_AGENTS = join(homedir(), "Library/LaunchAgents");
const RBH_LOG = join(homedir(), "rbh_scripts/logs/daily_export.log");
const RBH_LAST = join(homedir(), "rbh_scripts/logs/last_run.json");
const RBH_SCRIPT = join(homedir(), "rbh_scripts/daily_export.sh");

/** Same labels as Live RegimeBanner — keep in sync with regime-banner.tsx */
const CHECKPOINT_TIME_PT: Record<number, string> = {
  15: "6:45 AM PT",
  30: "7:00 AM PT",
  45: "7:15 AM PT",
  60: "7:30 AM PT",
  90: "8:00 AM PT",
  120: "8:30 AM PT",
  150: "9:00 AM PT",
  180: "9:30 AM PT",
  210: "10:00 AM PT",
  270: "11:00 AM PT",
  330: "12:00 PM PT",
};
/** Minutes from midnight PT = 6:30 open + minAfterOpen */
function checkpointDueMinutesPt(minAfterOpen: number): number {
  return 6 * 60 + 30 + minAfterOpen;
}

export type TaskRunner = "api-scheduler" | "launchd" | "supervised";
/** Status legend:
 *  ok      — last run succeeded (process healthy / success flag)
 *  warn    — ran, non-fatal issues (e.g. vendor APIs)
 *  failed  — last run failed or LaunchAgent missing when expected
 *  idle    — enabled, has run before, not currently running (no pass/fail signal)
 *  never   — enabled/scheduled but no recorded run yet
 *  off     — intentionally disabled (will not fire)
 *  running — in progress
 *  missing — LaunchAgent plist not loaded
 */
export type TaskStatus = "running" | "ok" | "warn" | "failed" | "idle" | "never" | "off" | "missing" | "waiting" | "degraded";
export type TodayState = "pending" | "done" | "overdue" | "running" | "skipped" | "waiting" | "degraded";

export interface VerifyCheck {
  ok: boolean;
  label: string;
  /** Plain-English fix when ok=false — often "Run now" which the UI already exposes */
  fix?: string | null;
}

export interface ScheduledTaskRow {
  id: string;
  name: string;
  /** One-line — shown in table */
  summary: string;
  /** Plain English — expand / popover */
  purpose: string;
  schedule: string;
  /** Lower = more frequent (sort key) */
  frequencyRank: number;
  /** e.g. "intraday", "daily", "weekdays", "weekly" */
  frequency: string;
  lastRun: string | null;
  running: boolean;
  runner: TaskRunner;
  status: TaskStatus;
  canRun: boolean;
  canToggle: boolean;
  enabled: boolean;
  detail?: string | null;
  logFiles: string[];
  /** Local PT ISO date YYYY-MM-DD this job is due (null = not today) */
  dueToday: boolean;
  /** Clock label in PT for today's fire, e.g. "7:00 AM PT" */
  dueTimeLabel: string | null;
  /** Minutes from midnight PT when due (sort); null if all-day/intraday window */
  dueMinutesPt: number | null;
  todayState: TodayState | null;
  /** Goal-specific checks; Done requires all ok */
  verified: boolean | null;
  verifyChecks: VerifyCheck[];
}

function vcheck(ok: boolean, label: string, fix?: string | null): VerifyCheck {
  return { ok, label, fix: ok ? null : (fix ?? null) };
}

function ranPtToday(iso: string | null, todayYmd: string): boolean {
  return ymdInTz(iso, "America/Los_Angeles") === todayYmd;
}

function todayStateFor(opts: {
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  dueToday: boolean;
  dueMinutesPt: number | null;
  nowMinutesPt: number;
  todayYmd: string;
  status?: TaskStatus;
  verified: boolean | null;
}): TodayState | null {
  if (!opts.dueToday) return null;
  if (!opts.enabled) return "skipped";
  if (opts.running) return "running";
  if (opts.status === "waiting") return "waiting";
  if (opts.status === "degraded") return "degraded";

  // Done only after goal-specific verification passes — never on lastRun alone.
  if (opts.verified === true) return "done";

  if (opts.status === "failed") {
    return opts.dueMinutesPt != null && opts.nowMinutesPt >= opts.dueMinutesPt ? "overdue" : "pending";
  }
  if (opts.verified === false) {
    if (opts.dueMinutesPt != null && opts.nowMinutesPt >= opts.dueMinutesPt) return "overdue";
    return "pending";
  }
  if (opts.dueMinutesPt === 0) {
    return opts.nowMinutesPt >= 22 * 60 ? "overdue" : "pending";
  }
  if (opts.dueMinutesPt != null && opts.nowMinutesPt >= opts.dueMinutesPt) return "overdue";
  return "pending";
}

function withToday(
  row: Omit<ScheduledTaskRow, "dueToday" | "dueTimeLabel" | "dueMinutesPt" | "todayState" | "verified" | "verifyChecks"> & {
    dueToday: boolean;
    dueTimeLabel: string | null;
    dueMinutesPt: number | null;
    verifyChecks?: VerifyCheck[];
  },
  pt: ReturnType<typeof ptParts>,
): ScheduledTaskRow {
  const verifyChecks = row.verifyChecks ?? [];
  const verified = verifyChecks.length === 0 ? null : verifyChecks.every((c) => c.ok);
  const { verifyChecks: _drop, ...rest } = row;
  return {
    ...rest,
    verifyChecks,
    verified,
    todayState: todayStateFor({
      enabled: row.enabled && row.status !== "off" && row.status !== "missing",
      running: row.running,
      lastRun: row.lastRun,
      dueToday: row.dueToday,
      dueMinutesPt: row.dueMinutesPt,
      nowMinutesPt: pt.minutes,
      todayYmd: pt.ymd,
      status: row.status,
      verified,
    }),
  };
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTail(path: string, maxBytes = 24_000): { path: string; exists: boolean; mtime: string | null; text: string } {
  if (!existsSync(path)) return { path, exists: false, mtime: null, text: "" };
  try {
    const st = statSync(path);
    const buf = readFileSync(path);
    const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    let text = slice.toString("utf8");
    if (buf.length > maxBytes) text = `…(truncated, last ${maxBytes} bytes)…\n` + text;
    return { path, exists: true, mtime: st.mtime.toISOString(), text };
  } catch (e) {
    return { path, exists: true, mtime: null, text: `read error: ${String(e)}` };
  }
}

function launchdState(label: string): "loaded" | "missing" | "unknown" {
  try {
    const uid = process.getuid?.() ?? 501;
    execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    return "loaded";
  } catch (err: unknown) {
    const msg = String((err as { stderr?: string })?.stderr ?? err);
    if (/Could not find|no such process|not found/i.test(msg)) return "missing";
    return existsSync(join(LAUNCH_AGENTS, `${label}.plist`)) ? "unknown" : "missing";
  }
}

function apiStatus(running: boolean, lastRun: string | null, enabled = true): TaskStatus {
  if (!enabled) return "off";
  if (running) return "running";
  if (lastRun) return "idle";
  return "never";
}

/** PT calendar helpers — LaunchAgents + "today" agenda use America/Los_Angeles. */
function ptParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const ymd = `${map.year}-${map.month}-${map.day}`;
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  const wd = map.weekday;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
  return { ymd, minutes, dow, weekday: dow >= 1 && dow <= 5 };
}

function ymdInTz(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function rhCsvReady(ptYmd: string): { ready: boolean; count: number; todayStamp: string } {
  const stamp = ptYmd.replace(/-/g, "");
  const root = join(homedir(), "rbh_scripts");
  const files = [
    join(root, `robinhood-holdings-${stamp}.csv`),
    join(root, `robinhood-transactions-${stamp}.csv`),
    join(root, `ticker-earnings-summary-${stamp}.csv`),
  ];
  const count = files.filter((f) => existsSync(f)).length;
  return { ready: count === 3, count, todayStamp: stamp };
}

function buildTasks(checkpoints: RegimeCheckpoint[] = []): ScheduledTaskRow[] {
  const pt = ptParts();
  const maintain = readJsonFile(join(LOG_DIR, "maintain-last.json"));
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
  const maintainLd = launchdState("com.fildi.maintain");

  let maintainStatus: TaskStatus = "never";
  if (maintainLd === "missing") maintainStatus = "missing";
  else if (jobOk === false || processOk === false) maintainStatus = "failed";
  else if (vendorsOk === false) maintainStatus = "warn";
  else if (jobOk === true || processOk === true) maintainStatus = "ok";
  else if (maintainTs) maintainStatus = "idle";

  const rbhStarted = typeof rbh?.started_at === "string" ? rbh.started_at : null;
  const rbhOk = typeof rbh?.success === "boolean" ? rbh.success : null;
  const rbhDetail = typeof rbh?.detail === "string" ? rbh.detail : null;
  const rbhStage = typeof rbh?.stage_reached === "string" ? rbh.stage_reached : null;
  const rbhLd = launchdState("com.fildi.rbh-daily-export");
  const csv = rhCsvReady(pt.ymd);
  const ingestRanToday = ymdInTz(rbhStarted, "America/Los_Angeles") === pt.ymd;

  // Export = supervised Claude MCP (no LaunchAgent). Status from CSV presence.
  let rbhExportStatus: TaskStatus = "off";
  if (pt.weekday) {
    if (csv.ready) rbhExportStatus = "ok";
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
  const resolvedCount = checkpoints.filter((c) => c.status === "resolved").length;
  const regimeRows: ScheduledTaskRow[] = CHECKPOINTS_MIN.map((min, i) => {
    const cp = cpByMin.get(min);
    const dueMin = checkpointDueMinutesPt(min);
    const label = CHECKPOINT_TIME_PT[min] ?? `+${min}m`;
    const resolved = cp?.status === "resolved";
    let status: TaskStatus = "never";
    if (!pt.weekday) status = "off";
    else if (resolved) status = "ok";
    else if (pt.minutes >= dueMin) status = "waiting";
    else status = "idle";

    return withToday({
      id: `regime-${min}`,
      name: `Session regime · ${label}`,
      summary: resolved
        ? `${cp?.direction ?? "—"} ${cp?.confidence != null ? `${cp.confidence}%` : ""}`.trim()
        : "SPY/QQQ checkpoint (auto while market open)",
      purpose: `Intraday session checkpoint at ${label} (${min} min after open). Written by the API while the market is open — same slots as the Live Regime banner.`,
      schedule: `Weekdays ${label}`,
      frequencyRank: 10 + i * 0.01,
      frequency: "intraday",
      lastRun: resolved && cp?.timestamp ? new Date(cp.timestamp).toISOString() : null,
      running: false,
      runner: "api-scheduler",
      status,
      canRun: false,
      canToggle: false,
      enabled: pt.weekday,
      detail: resolved ? (cp?.factors?.[0] ?? null) : null,
      logFiles: [join(LOG_DIR, "api.log")],
      dueToday: pt.weekday,
      dueTimeLabel: label,
      dueMinutesPt: dueMin,
      verifyChecks: pt.weekday
        ? [
            vcheck(
              resolved,
              `Checkpoint recorded at ${label}`,
              pt.minutes >= dueMin
                ? "API must be up during market hours — Run Mac Maintain · heal, then wait for next checkpoint"
                : "Not due yet",
            ),
            vcheck(
              !resolved || (cp?.direction != null && cp?.confidence != null),
              "Direction + confidence present",
              "Check Live Regime banner / api.log for checkpoint errors",
            ),
          ]
        : [],
    }, pt);
  });

  // Single catalog row for All tasks (Today still lists each checkpoint time)
  const latestResolved = [...checkpoints]
    .filter((c) => c.status === "resolved" && c.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const regimeCatalog = withToday({
    id: "regime",
    name: "Session Regime",
    summary: `11 checkpoints / session · ${resolvedCount}/${CHECKPOINTS_MIN.length} recorded today`,
    purpose: "One job, many fires: SPY/QQQ session checkpoints at the same 11 times as Live (6:45 AM–12:00 PM PT). Today’s agenda shows each time; this row is the job itself.",
    schedule: "Weekdays · 11× (6:45 AM–12:00 PM PT)",
    frequencyRank: 10,
    frequency: "11× / session",
    lastRun: latestResolved?.timestamp ? new Date(latestResolved.timestamp).toISOString() : null,
    running: false,
    runner: "api-scheduler",
    status: !pt.weekday ? "off" : resolvedCount > 0 ? "ok" : "idle",
    canRun: true,
    canToggle: false,
    enabled: true,
    logFiles: [join(LOG_DIR, "api.log")],
    dueToday: false,
    dueTimeLabel: null,
    dueMinutesPt: null,
  }, pt);

  const stackLd = launchdState("com.fildi.stack-ensure");
  const stackStatus: TaskStatus = stackLd === "missing" ? "missing" : "idle";

  const rows: ScheduledTaskRow[] = [
    ...regimeRows,
    regimeCatalog,
    withToday({
      id: "maintain",
      name: "Mac Maintain",
      summary: "7:00 AM full · 12:00/2:45 PM heal",
      purpose: "Two LaunchAgents, one purpose (keep the Mac stack up before you open ~8 AM): (1) 7:00 AM PT full — heal API/Vite, lean enrich, scores, retention prune (api_usage = vendor call counters; ai_usage_log = Anthropic explain calls; old intraday app_config keys; /tmp/fildi-logs). Then morning precompute. (2) 12:00 PM + 2:45 PM PT heal-only. Does NOT shrink Cursor chat tokens.",
      schedule: "7:00 AM full · 12:00 PM + 2:45 PM heal",
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
      logFiles: [
        join(LOG_DIR, "maintain-last.json"),
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
        vcheck(!maintainRanToday || retentionOk, "Retention prune in today’s full pass", "Run Mac Maintain · full"),
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
    // Retention is NOT a separate product task — folded into Mac Maintain (and API day backup).
    // It only deletes old ai_usage_log / api_usage / stale intraday app_config keys — never fundamentals.
    withToday({
      id: "rbh-export",
      name: "RH Portfolio Export",
      summary: "Claude MCP → today’s CSVs (supervised)",
      purpose: "Stage 1: ask Claude to run the daily Robinhood export after the close. Not a LaunchAgent (requires supervised MCP/Bash).",
      schedule: "Weekdays after close (~1:00+ PM PT)",
      frequencyRank: 29,
      frequency: "weekdays",
      lastRun: csv.ready
        ? (() => {
            try {
              return statSync(join(homedir(), "rbh_scripts", `robinhood-holdings-${csv.todayStamp}.csv`)).mtime.toISOString();
            } catch { return null; }
          })()
        : null,
      running: false,
      runner: "supervised",
      status: rbhExportStatus,
      canRun: false,
      canToggle: false,
      enabled: pt.weekday,
      detail: csv.ready ? `CSVs ready (${csv.count}/3)` : `CSVs ${csv.count}/3 — run Claude export`,
      logFiles: [],
      dueToday: pt.weekday,
      dueTimeLabel: "~1:00 PM PT+",
      dueMinutesPt: 13 * 60,
      verifyChecks: pt.weekday
        ? [
            vcheck(csv.ready, `Today’s RH CSVs present (${csv.count}/3)`, "Ask Claude to run the Robinhood daily export after close"),
          ]
        : [],
    }, pt),
    withToday({
      id: "rbh-ingest",
      name: "RH Portfolio Ingest",
      summary: "CSVs → Postgres (LaunchAgent)",
      purpose: "Stage 2: weekdays 3:00 PM PT + file-watch. Waits on Export CSVs.",
      schedule: "Weekdays 3:00 PM PT (+ WatchPaths)",
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
      logFiles: [RBH_LAST, RBH_LOG],
      dueToday: pt.weekday,
      dueTimeLabel: "3:00 PM PT",
      dueMinutesPt: 15 * 60,
      verifyChecks: pt.weekday
        ? [
            vcheck(csv.ready, "Export CSVs ready", "Finish RH Portfolio Export first"),
            vcheck(ingestRanToday && rbhOk === true, "Ingest succeeded today", "Run now once CSVs exist; check rbh last_run.json"),
          ]
        : [],
    }, pt),
    withToday({
      id: "option-scores",
      name: "Option Score Snapshots",
      summary: "Save Overall options rankings",
      purpose: "Mon–Thu ~12:00 PM PT. Friday dual-written by Model Snapshot.",
      schedule: "Mon–Thu ~12:00 PM PT",
      frequencyRank: 35,
      frequency: "weekdays",
      lastRun: lastOptionScoreRun?.toISOString() ?? null,
      running: optionScoreRunning,
      runner: "api-scheduler",
      status: apiStatus(optionScoreRunning, lastOptionScoreRun?.toISOString() ?? null),
      canRun: true,
      canToggle: false,
      enabled: true,
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

  return rows.sort((a, b) => a.frequencyRank - b.frequencyRank || a.name.localeCompare(b.name));
}

function findTask(id: string, checkpoints: RegimeCheckpoint[] = []) {
  return buildTasks(checkpoints).find((t) => t.id === id) ?? null;
}

router.get("/admin/scheduled-tasks", requireAdmin, async (_req, res) => {
  const pt = ptParts();
  const checkpoints = await getTodaysCheckpoints().catch(() => [] as RegimeCheckpoint[]);
  const tasks = buildTasks(checkpoints);
  const today = tasks
    .filter((t) => t.dueToday)
    .map((t) => (t.id === "maintain" ? { ...t, name: "Mac Maintain · full" } : t))
    .sort((a, b) => {
      const am = a.dueMinutesPt ?? 9999;
      const bm = b.dueMinutesPt ?? 9999;
      return am - bm || a.frequencyRank - b.frequencyRank;
    });
  // All-tasks catalog: one row per logical job
  // - collapse regime-* → keep "regime"
  // - collapse stack-ensure* into Maintain (already described on maintain)
  // - retention folded into Maintain (not listed)
  const catalog = tasks.filter((t) => {
    if (t.id.startsWith("regime-")) return false;
    if (t.id === "stack-ensure" || t.id === "stack-ensure-1445") return false;
    return true;
  });
  res.json({
    generatedAt: Date.now(),
    todayDate: pt.ymd,
    todayLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date()),
    legend: {
      ok: "Last run succeeded / checkpoint recorded",
      warn: "Ran with non-fatal issues",
      failed: "Last run failed",
      idle: "Enabled, not yet due or waiting for window",
      never: "Enabled, but no recorded run yet",
      off: "Intentionally disabled / weekend",
      missing: "LaunchAgent not loaded",
      running: "In progress",
      waiting: "Blocked on upstream (export CSVs) or checkpoint due but missing",
      degraded: "Ran but data quality is poor",
    },
    summary: {
      failed: tasks.filter((t) => t.status === "failed" || t.status === "missing").length,
      warn: tasks.filter((t) => t.status === "warn").length,
      todayPending: today.filter((t) => t.todayState === "pending" || t.todayState === "overdue" || t.todayState === "waiting").length,
      todayDone: today.filter((t) => t.todayState === "done").length,
    },
    today,
    tasks: catalog,
  });
});

router.get("/admin/scheduled-tasks/:id/logs", requireAdmin, async (req, res) => {
  const checkpoints = await getTodaysCheckpoints().catch(() => [] as RegimeCheckpoint[]);
  const task = findTask(String(req.params.id), checkpoints);
  if (!task) {
    res.status(404).json({ error: "unknown task" });
    return;
  }
  res.json({
    id: task.id,
    name: task.name,
    logs: task.logFiles.map((p) => readTail(p)),
  });
});

router.post("/admin/scheduled-tasks/:id/run", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const checkpoints = await getTodaysCheckpoints().catch(() => [] as RegimeCheckpoint[]);
  const task = findTask(id, checkpoints);
  if (!task) {
    res.status(404).json({ error: "unknown task" });
    return;
  }
  if (!task.canRun) {
    res.status(400).json({ error: "task cannot be run manually", id });
    return;
  }
  if (task.running) {
    res.status(409).json({ error: "already running", id });
    return;
  }

  try {
    if (id === "maintain" || id === "stack-ensure" || id === "stack-ensure-1445") {
      const args =
        id === "maintain"
          ? [
              join(ROOT, "scripts/maintain.mjs"),
              "--enrich-if-due",
              "--drain-nr=40",
              "--restart-if-unhealthy",
              "--restart-stale-days=7",
            ]
          : [join(ROOT, "scripts/maintain.mjs"), "--restart-if-unhealthy"];
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      res.json({ ok: true, id, started: true, pid: child.pid, mode: "detached" });
      return;
    }
    if (id === "rbh-ingest") {
      if (!existsSync(RBH_SCRIPT)) {
        res.status(500).json({ error: "daily_export.sh missing", path: RBH_SCRIPT });
        return;
      }
      const child = spawn("bash", [RBH_SCRIPT], {
        cwd: join(homedir(), "rbh_scripts"),
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      res.json({ ok: true, id, started: true, pid: child.pid, mode: "detached" });
      return;
    }
    if (id === "ai-workflow-review") {
      const script = join(ROOT, ".cursor/scripts/ai-workflow-review.mjs");
      if (!existsSync(script)) {
        res.status(500).json({ error: "ai-workflow-review.mjs missing", path: script });
        return;
      }
      const child = spawn(process.execPath, [script], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      res.json({ ok: true, id, started: true, pid: child.pid, mode: "detached", next: "node .cursor/scripts/ai-workflow-review.mjs --verify" });
      return;
    }

    // In-process — fire and return; client polls list for running/lastRun.
    const starters: Record<string, () => Promise<void>> = {
      "model-snapshot": runModelSnapshotJob,
      "model-grade": runTradeExpiry,
      "option-scores": runOptionScoreJob,
      retention: runRetentionPrune,
      regime: runRegimeCheckpoints,
      "event-bullets": runEventBulletsJob,
      "earnings-backfill": runEarningsBackfillJob,
      "fmp-analyst-feed": runFmpAnalystFeedJob,
      "desk-ingest": runDeskIngestJob,
      "schwab-health": runSchwabHealthJob,
    };
    const start = starters[id];
    if (!start) {
      res.status(400).json({ error: "no runner wired", id });
      return;
    }
    void start().catch(() => {});
    res.json({ ok: true, id, started: true, mode: "in-process" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/scheduled-tasks/:id/enable", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const label =
    id === "maintain" ? "com.fildi.maintain"
      : id === "stack-ensure" ? "com.fildi.stack-ensure"
      : id === "rbh-ingest" ? "com.fildi.rbh-daily-export"
        : null;
  if (!label) {
    res.status(400).json({ error: "only LaunchAgent tasks can be toggled" });
    return;
  }
  const plist = join(LAUNCH_AGENTS, `${label}.plist`);
  if (!existsSync(plist)) {
    res.status(404).json({ error: "plist missing", plist });
    return;
  }
  try {
    const uid = process.getuid?.() ?? 501;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
    } catch { /* not loaded */ }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    res.json({ ok: true, id, enabled: true, state: launchdState(label) });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    res.status(500).json({ error: e.stderr || e.message || String(err) });
  }
});

router.post("/admin/scheduled-tasks/:id/disable", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const label =
    id === "maintain" ? "com.fildi.maintain"
      : id === "stack-ensure" ? "com.fildi.stack-ensure"
      : id === "rbh-ingest" ? "com.fildi.rbh-daily-export"
        : null;
  if (!label) {
    res.status(400).json({ error: "only LaunchAgent tasks can be toggled" });
    return;
  }
  try {
    const uid = process.getuid?.() ?? 501;
    execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    res.json({ ok: true, id, enabled: false, state: launchdState(label) });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    // Already unloaded is fine
    if (/Could not find|no such process|not found/i.test(String(e.stderr || e.message))) {
      res.json({ ok: true, id, enabled: false, state: "missing" });
      return;
    }
    res.status(500).json({ error: e.stderr || e.message || String(err) });
  }
});

export default router;
