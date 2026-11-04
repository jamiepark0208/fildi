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
