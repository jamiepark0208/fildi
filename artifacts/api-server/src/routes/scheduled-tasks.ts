/**
 * Admin scheduled-task manager: status + purpose + logs + run/enable/disable.
 * Covers LaunchAgents (maintain, RH ingest) and in-process API scheduler jobs.
 */
import { priceCoverage } from "../lib/price-coverage.js";
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
  lastSchwab1mPollRun, schwab1mPollRunning,
  lastResearchOpsRun, researchOpsRunning,
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
  runSchwab1mPoll,
  runResearchOpsJob,
} from "../lib/scheduler.js";
import { getSchwabAuthStatus } from "../lib/schwab-auth.js";
import {
  getResearchOpsReport,
  type ResearchOpsReport,
} from "../lib/research-ops.js";
import { etDateKey } from "../lib/market-hours.js";
import {
  CHECKPOINTS_MIN,
  getCheckpointsForDate,
  getTodaysCheckpoints,
  type RegimeCheckpoint,
} from "../lib/intraday-regime.js";
import { buildInventory, buildNucleus, detectOpsAlerts } from "../lib/scheduled-tasks-inventory.js";
import {
  countOpenAlerts,
  finalizeRemediateIfPending,
  readRemediateReport,
  remediateTaskIdsFromAlerts,
  REMEDIATE_WHITELIST,
  runOpsRemediate,
} from "../lib/ops-remediate.js";
import { getOptionsChainSourceStats } from "../lib/options-chain-source-stats.js";

/**
 * Session checkpoints for the Scheduled Tasks Today agenda (PT calendar day).
 * After ~9pm PT, ET has already rolled to the next date — `getTodaysCheckpoints`
 * would load an empty next-day key while Monday’s leans still sit under Monday’s
 * ET key. Prefer the PT agenda date when ET is ahead.
 */
async function checkpointsForAgenda(ptYmd: string): Promise<RegimeCheckpoint[]> {
  const et = etDateKey();
  const key = et > ptYmd ? ptYmd : et;
  if (key === et) return getTodaysCheckpoints();
  const existing = await getCheckpointsForDate(key);
  const byMin = new Map(existing.map((c) => [c.minAfterOpen, c]));
  return CHECKPOINTS_MIN.map((min) => byMin.get(min) ?? {
    minAfterOpen: min,
    timestamp: 0,
    status: "pending" as const,
    direction: null,
    confidence: null,
    spy: null,
    qqq: null,
    breadth: null,
    label: "",
    computedLate: false,
    factors: ["Not reached that session."],
  });
}

const router = Router();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOG_DIR = "/tmp/fildi-logs";
const LAUNCH_AGENTS = join(homedir(), "Library/LaunchAgents");
const RBH_LOG = join(homedir(), "rbh_scripts/logs/daily_export.log");
const RBH_LAST = join(homedir(), "rbh_scripts/logs/last_run.json");
const RBH_SCRIPT = join(homedir(), "rbh_scripts/daily_export.sh");
const RBH_EXPORT_PROMPT_LAST = join(homedir(), "rbh_scripts/logs/export_prompt_last.json");
/** PM jobs (Claude, PM role): each writes {ts, ok, detail} after a run. */
const PM_ALERTS_LAST = "/tmp/fildi-logs/pm-alerts-last.json";
const TRANSCRIPTS_LAST = "/tmp/fildi-logs/transcripts-last.json";
const OPENJEV_LAST = "/tmp/fildi-logs/openjev-last.json";
const PM_PY = join(ROOT, "scripts/watchlist_sync/.venv/bin/python");
function readLast(path: string): { ts: string; ok: boolean; detail: string } | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function pmJobStatus(last: { ts: string; ok: boolean } | null, maxAgeH: number, label: string): TaskStatus {
  if (launchdState(label) !== "loaded") return "off";
  if (!last) return "never";
  if (!last.ok) return "failed";
  return Date.now() - new Date(last.ts).getTime() > maxAgeH * 3_600_000 ? "warn" : "ok";
}

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

/** True when this slot was actually written (not a getTodaysCheckpoints placeholder). */
function isRegimeRecorded(cp: RegimeCheckpoint | undefined): boolean {
  if (!cp) return false;
  if (cp.status === "resolved") return true;
  // Persisted rows with a real timestamp but missing/odd status still count.
  if (cp.status === "pending") return false;
  return typeof cp.timestamp === "number" && cp.timestamp > 0;
}

/**
 * Compact lean for Today: Bull 72% / Bear 40% / Mixed 20% / OR / 0% / —.
 * `due` = slot time has passed (past-due miss → 0%; not-yet-due → —).
 */
function regimeLeanLabel(cp: RegimeCheckpoint | undefined, due = false): string {
  if (!isRegimeRecorded(cp)) return due ? "0%" : "—";
  const pct = cp!.confidence ?? 0;
  // 15m baseline: OR established, no directional call yet.
  if (!cp!.direction) return pct > 0 ? `${pct}%` : "OR";
  const lean = cp!.direction === "bullish" ? "Bull" : cp!.direction === "bearish" ? "Bear" : "Mixed";
  return `${lean} ${pct}%`;
}

function ageLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
  /** What changed / improved when last successful — shown on Done rows */
  outcome?: string | null;
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
    outcome?: string | null;
  },
  pt: ReturnType<typeof ptParts>,
): ScheduledTaskRow {
  const verifyChecks = row.verifyChecks ?? [];
  const verified = verifyChecks.length === 0 ? null : verifyChecks.every((c) => c.ok);
  const { verifyChecks: _drop, ...rest } = row;
  return {
    ...rest,
    outcome: row.outcome ?? null,
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

/** Mac resource line (Jamie 10-16) — written weekly by scripts/resource-audit.py (Maintain, Sunday). */
function readMacResources() {
  const snap = readJsonFile(join(homedir(), ".fildi", "resource-latest.json"));
  if (!snap) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const disk = (snap.disk ?? {}) as Record<string, unknown>;
  const fildi = (snap.fildi ?? {}) as Record<string, unknown>;
  const ram = (snap.ram ?? {}) as Record<string, unknown>;
  const growth = Array.isArray(snap.growth) ? (snap.growth as { item?: string; mb_per_day?: number }[]) : [];
  const repoMb = num(fildi.repo);
  const dbMb = num(((snap.db ?? {}) as Record<string, unknown>).total_mb);
  const fildiGrowthPerDay = growth
    .filter((g) => typeof g.item === "string" && (g.item === "fildi:repo" || g.item === "db:total"))
    .reduce((a, g) => a + (g.mb_per_day ?? 0), 0);
  return {
    ts: typeof snap.ts === "string" ? snap.ts : null,
    diskFreeGb: num(disk.free_gb),
    fildiGb: repoMb != null ? Math.round(((repoMb + (dbMb ?? 0)) / 1024) * 10) / 10 : null,
    growthMbPerWeek: growth.length ? Math.round(fildiGrowthPerDay * 7) : null,
    ramFreePct: num(ram.free_pct),
    swapGb: num(ram.swap_gb),
    findings: Array.isArray(snap.findings) ? (snap.findings as string[]).slice(0, 8) : [],
  };
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

function buildTasks(
  checkpoints: RegimeCheckpoint[] = [],
  researchReport: ResearchOpsReport | null = null,
): ScheduledTaskRow[] {
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

  const rows: ScheduledTaskRow[] = [
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
        summary: "WRDS/LSEG cache freshness + LSEG desktop :9000 (no vendor sync)",
        purpose:
          "Every ~6h: probe local wrds_research/lseg_research.sync_state age and TCP to LSEG Workspace (127.0.0.1:9000). Never calls WRDS Cloud or opens an LSEG session — refreshes stay manual (lane contract). Analog of Schwab Auth Health. CLI: python research/common/health.py",
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
            "Weekday refresh of lseg_research.signals_daily + events. Requires Workspace logged in on :9000. Not LaunchAgent — lane contract forbids vendor cron.",
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

  return rows.sort((a, b) => a.frequencyRank - b.frequencyRank || a.name.localeCompare(b.name));
}

function findTask(
  id: string,
  checkpoints: RegimeCheckpoint[] = [],
  researchReport: ResearchOpsReport | null = null,
) {
  return buildTasks(checkpoints, researchReport).find((t) => t.id === id) ?? null;
}

router.get("/admin/scheduled-tasks", requireAdmin, async (_req, res) => {
  const pt = ptParts();
  const checkpoints = await checkpointsForAgenda(pt.ymd).catch(() => [] as RegimeCheckpoint[]);
  // Fresh probe so LSEG/WRDS Done isn't stuck on a stale in-memory cache.
  const researchReport = await getResearchOpsReport().catch(() => null);
  const tasks = buildTasks(checkpoints, researchReport);
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
  const enrichmentDisabled =
    process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" ||
    process.env.DISABLE_SCHEDULER_ENRICHMENT === "true";
  const inventory = buildInventory(catalog);
  const digSnap = readJsonFile(join(LOG_DIR, "weekly-data-ops-last.json"));
  const digTs = typeof digSnap?.ts === "string" ? digSnap.ts : null;
  const digAgeDays = digTs ? (Date.now() - new Date(digTs).getTime()) / 86_400_000 : null;
  const researchAlert = researchReport
    ? {
        wrdsOverall: researchReport.wrds.overall,
        lsegOverall: researchReport.lseg.overall,
        desktopReachable: researchReport.lseg.desktopProxy.reachable,
        fixHints: researchReport.fixHints,
      }
    : null;
  const alerts = detectOpsAlerts({
    tasks,
    enrichmentDisabled,
    todayYmd: pt.ymd,
    ptDow: pt.dow,
    nowMinutesPt: pt.minutes,
    research: researchAlert,
    opsDigest: { lastTs: digTs, ageDays: digAgeDays },
    priceCoverage: await priceCoverage().catch(() => null),
  });
  const getAlertCount = () => countOpenAlerts(alerts);
  const remediateLast = await finalizeRemediateIfPending(getAlertCount);
  const nucleus = buildNucleus({
    tasks,
    alerts,
    inventory,
    research: researchAlert,
    enrichmentDisabled,
  });
  const chainSrc = getOptionsChainSourceStats();
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
      alertsCritical: alerts.filter((a) => a.severity === "critical").length,
      alertsWarn: alerts.filter((a) => a.severity === "warn").length,
    },
    today,
    tasks: catalog,
    inventory,
    alerts,
    nucleus,
    enrichmentDisabled,
    remediateLast: remediateLast ?? readRemediateReport(),
    optionsChainSource: chainSrc,
    macResources: readMacResources(),
  });
});

router.get("/admin/scheduled-tasks/:id/logs", requireAdmin, async (req, res) => {
  const pt = ptParts();
  const checkpoints = await checkpointsForAgenda(pt.ymd).catch(() => [] as RegimeCheckpoint[]);
  const researchReport = await getResearchOpsReport().catch(() => null);
  const task = findTask(String(req.params.id), checkpoints, researchReport);
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

/**
 * Whitelist auto-remediate: Maintain / stack heal / regime only.
 * Proof → /tmp/fildi-logs/ops-remediate-last.json (alert Δ).
 * Body: { taskIds?: string[], trigger?: "manual-nucleus"|"api" } — omit taskIds to derive from open alerts.
 */
router.post("/admin/ops/remediate", requireAdmin, async (req, res) => {
  try {
    const pt = ptParts();
    const checkpoints = await checkpointsForAgenda(pt.ymd).catch(() => [] as RegimeCheckpoint[]);
    const researchReport = await getResearchOpsReport().catch(() => null);
    const tasks = buildTasks(checkpoints, researchReport);
    const enrichmentDisabled =
      process.env.DISABLE_SCHEDULER_ENRICHMENT === "1" ||
      process.env.DISABLE_SCHEDULER_ENRICHMENT === "true";
    const digSnap = readJsonFile(join(LOG_DIR, "weekly-data-ops-last.json"));
    const digTs = typeof digSnap?.ts === "string" ? digSnap.ts : null;
    const digAgeDays = digTs ? (Date.now() - new Date(digTs).getTime()) / 86_400_000 : null;
    const researchAlert = researchReport
      ? {
          wrdsOverall: researchReport.wrds.overall,
          lsegOverall: researchReport.lseg.overall,
          desktopReachable: researchReport.lseg.desktopProxy.reachable,
          fixHints: researchReport.fixHints,
        }
      : null;
    const alerts = detectOpsAlerts({
      tasks,
      enrichmentDisabled,
      todayYmd: pt.ymd,
      ptDow: pt.dow,
      nowMinutesPt: pt.minutes,
      research: researchAlert,
      opsDigest: { lastTs: digTs, ageDays: digAgeDays },
      priceCoverage: await priceCoverage().catch(() => null),
    });
    const alertsBefore = countOpenAlerts(alerts);
    const body = (req.body ?? {}) as { taskIds?: unknown; trigger?: unknown };
    const trigger =
      body.trigger === "api" || body.trigger === "manual-nucleus" ? body.trigger : "manual-nucleus";
    let taskIds: string[];
    if (Array.isArray(body.taskIds) && body.taskIds.length > 0) {
      taskIds = body.taskIds.map(String).filter((id) => REMEDIATE_WHITELIST.has(id));
      if (taskIds.length === 0) {
        res.status(400).json({
          error: "no whitelist taskIds",
          allowed: [...REMEDIATE_WHITELIST],
        });
        return;
      }
    } else {
      taskIds = remediateTaskIdsFromAlerts(alerts);
    }

    const report = await runOpsRemediate({
      trigger,
      taskIds,
      alertsBefore,
      deps: {
        getAlertCount: async () => {
          const freshCp = await checkpointsForAgenda(pt.ymd).catch(() => [] as RegimeCheckpoint[]);
          const freshResearch = await getResearchOpsReport().catch(() => null);
          const freshTasks = buildTasks(freshCp, freshResearch);
          const freshAlerts = detectOpsAlerts({
            tasks: freshTasks,
            enrichmentDisabled,
            todayYmd: pt.ymd,
            ptDow: pt.dow,
            nowMinutesPt: ptParts().minutes,
            research: researchAlert,
            opsDigest: { lastTs: digTs, ageDays: digAgeDays },
            priceCoverage: await priceCoverage().catch(() => null),
          });
          return countOpenAlerts(freshAlerts);
        },
        runRegime: () => runRegimeCheckpoints(),
      },
    });
    res.json({ ok: report.ok, report });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/scheduled-tasks/:id/run", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const pt = ptParts();
  const checkpoints = await checkpointsForAgenda(pt.ymd).catch(() => [] as RegimeCheckpoint[]);
  const researchReport = await getResearchOpsReport().catch(() => null);
  const task = findTask(id, checkpoints, researchReport);
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
    if (id === "openjev") {
      // Run now = freeze today's inputs (idempotent) + answer under the RAM guard (never forces past it).
      const child = spawn("/usr/bin/caffeinate", ["-s", PM_PY, join(ROOT, "scripts/watchlist_sync/openjev_local.py"),
        "--freeze", "--answer"], { cwd: join(ROOT, "scripts/watchlist_sync"), detached: true, stdio: "ignore", env: process.env });
      child.unref();
      res.json({ ok: true, id, started: true, pid: child.pid, mode: "detached" });
      return;
    }
    if (id === "pm-alerts" || id === "transcripts") {
      const script = join(ROOT, "scripts/watchlist_sync", id === "pm-alerts" ? "pm_alerts.py" : "transcripts.py");
      const child = spawn(PM_PY, id === "pm-alerts" ? [script, "--now"] : [script], {
        cwd: join(ROOT, "scripts/watchlist_sync"),
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
    if (id === "ops-digest") {
      const script = join(ROOT, "scripts/weekly-data-ops-check.mjs");
      if (!existsSync(script)) {
        res.status(500).json({ error: "weekly-data-ops-check.mjs missing", path: script });
        return;
      }
      const child = spawn(process.execPath, [script, "--digest-only"], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      res.json({ ok: true, id, started: true, pid: child.pid, mode: "detached", args: ["--digest-only"] });
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
      "schwab-1m": () => runSchwab1mPoll({ force: true }).then(() => undefined),
      "research-ops-health": runResearchOpsJob,
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
      : id === "rbh-export" ? "com.fildi.rbh-export-prompt"
      : id === "pm-alerts" ? "com.fildi.pm-alerts"
      : id === "transcripts" ? "com.fildi.transcripts"
      : id === "openjev" ? "com.fildi.openjev"
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
      : id === "rbh-export" ? "com.fildi.rbh-export-prompt"
      : id === "pm-alerts" ? "com.fildi.pm-alerts"
      : id === "transcripts" ? "com.fildi.transcripts"
      : id === "openjev" ? "com.fildi.openjev"
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
