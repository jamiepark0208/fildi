import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { etDateKey } from "../../lib/market-hours.js";
import {
  CHECKPOINTS_MIN,
  getCheckpointsForDate,
  getTodaysCheckpoints,
  type RegimeCheckpoint,
} from "../../lib/intraday-regime.js";
import type { TaskStatus, VerifyCheck, ScheduledTaskRow, TodayState } from "./types.js";
import { LAUNCH_AGENTS } from "./paths.js";

export async function checkpointsForAgenda(ptYmd: string): Promise<RegimeCheckpoint[]> {
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

export function readLast(path: string): { ts: string; ok: boolean; detail: string } | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
export function pmJobStatus(last: { ts: string; ok: boolean } | null, maxAgeH: number, label: string): TaskStatus {
  if (launchdState(label) !== "loaded") return "off";
  if (!last) return "never";
  if (!last.ok) return "failed";
  return Date.now() - new Date(last.ts).getTime() > maxAgeH * 3_600_000 ? "warn" : "ok";
}

/** Same labels as Live RegimeBanner — keep in sync with regime-banner.tsx */
export const CHECKPOINT_TIME_PT: Record<number, string> = {
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
export function checkpointDueMinutesPt(minAfterOpen: number): number {
  return 6 * 60 + 30 + minAfterOpen;
}

/** True when this slot was actually written (not a getTodaysCheckpoints placeholder). */
export function isRegimeRecorded(cp: RegimeCheckpoint | undefined): boolean {
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
export function regimeLeanLabel(cp: RegimeCheckpoint | undefined, due = false): string {
  if (!isRegimeRecorded(cp)) return due ? "0%" : "—";
  const pct = cp!.confidence ?? 0;
  // 15m baseline: OR established, no directional call yet.
  if (!cp!.direction) return pct > 0 ? `${pct}%` : "OR";
  const lean = cp!.direction === "bullish" ? "Bull" : cp!.direction === "bearish" ? "Bear" : "Mixed";
  return `${lean} ${pct}%`;
}

export function ageLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function vcheck(ok: boolean, label: string, fix?: string | null): VerifyCheck {
  return { ok, label, fix: ok ? null : (fix ?? null) };
}

export function ranPtToday(iso: string | null, todayYmd: string): boolean {
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

export function withToday(
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

export function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Mac resource line (Jamie 10-16) — written weekly by scripts/resource-audit.py (Maintain, Sunday). */
export function readMacResources() {
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

export function readTail(path: string, maxBytes = 24_000): { path: string; exists: boolean; mtime: string | null; text: string } {
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

export function launchdState(label: string): "loaded" | "missing" | "unknown" {
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

export function apiStatus(running: boolean, lastRun: string | null, enabled = true): TaskStatus {
  if (!enabled) return "off";
  if (running) return "running";
  if (lastRun) return "idle";
  return "never";
}

/** PT calendar helpers — LaunchAgents + "today" agenda use America/Los_Angeles. */
export function ptParts(d = new Date()) {
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

export function ymdInTz(iso: string | null, timeZone: string): string | null {
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

export function rhCsvReady(ptYmd: string): { ready: boolean; count: number; todayStamp: string } {
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
