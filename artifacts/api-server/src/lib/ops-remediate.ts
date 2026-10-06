/**
 * Safe ops auto-remediate — whitelist only (Maintain heal/full, stack-ensure, regime).
 * Proof: /tmp/fildi-logs/ops-remediate-last.json (alert Δ + actions), same vocabulary as
 * weekly-data-ops value log (IMPROVED | NO MATERIAL CHANGE | STARTED | NEEDS_YOU).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpsAlert } from "./scheduled-tasks-inventory.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOG_DIR = "/tmp/fildi-logs";
const REPORT = join(LOG_DIR, "ops-remediate-last.json");

/** Task ids that may be auto/manual-remediated without Duo/OAuth/score writes. */
export const REMEDIATE_WHITELIST = new Set([
  "maintain",
  "stack-ensure",
  "stack-ensure-1445",
  "regime",
]);

export type RemediateTrigger = "heal-cadence" | "manual-nucleus" | "api";

export type RemediateValue =
  | "IMPROVED"
  | "NO MATERIAL CHANGE"
  | "STARTED"
  | "NEEDS_YOU"
  | "FAILED";

export interface OpsRemediateReport {
  at: string;
  trigger: RemediateTrigger;
  taskIds: string[];
  alertsBefore: number;
  alertsAfter: number | null;
  alertDelta: number | null;
  value: RemediateValue;
  ok: boolean;
  actions: string[];
  exits?: Record<string, number | null>;
  note?: string;
  /** When STARTED, finalize once maintain-last.ts >= this */
  pendingUntilMaintainTs?: string;
}

export function countOpenAlerts(alerts: OpsAlert[]): number {
  return alerts.filter((a) => a.severity === "critical" || a.severity === "warn").length;
}

/** Whitelist task ids implied by open alerts (critical/warn only). */
export function remediateTaskIdsFromAlerts(alerts: OpsAlert[]): string[] {
  const ids = new Set<string>();
  for (const a of alerts) {
    if (a.severity !== "critical" && a.severity !== "warn") continue;
    for (const tid of a.taskIds) {
      if (REMEDIATE_WHITELIST.has(tid)) ids.add(tid);
    }
    // Overdue / heal copy often points at Maintain without listing stack-ensure
    if (/maintain|heal stack|Run now/i.test(a.fix ?? "") || /maintain|heal stack/i.test(a.detail)) {
      if (a.taskIds.some((t) => t === "maintain" || t.startsWith("stack"))) {
        ids.add(a.taskIds.includes("stack-ensure") ? "stack-ensure" : "maintain");
      } else if (/Maintain|heal stack/i.test(a.fix ?? a.detail)) {
        ids.add("maintain");
      }
    }
    if (a.taskIds.some((t) => t === "regime" || t.startsWith("regime-"))) ids.add("regime");
  }
  // Prefer heal-only stack-ensure over full maintain when both present and only process issues
  if (ids.has("stack-ensure") && ids.has("maintain")) {
    const onlyProcess = alerts.every(
      (a) =>
        a.severity === "info" ||
        a.taskIds.every((t) => t === "maintain" || t.startsWith("stack") || t === "enrichment-api"),
    );
    // Keep both — maintain covers enrich drift; stack-ensure is fast heal. Dedupe to maintain if both.
    // Actually running both is wasteful; prefer maintain (includes heal) when listed.
    ids.delete("stack-ensure");
    ids.delete("stack-ensure-1445");
  }
  return [...ids].filter((id) => REMEDIATE_WHITELIST.has(id));
}

export function readRemediateReport(): OpsRemediateReport | null {
  try {
    if (!existsSync(REPORT)) return null;
    return JSON.parse(readFileSync(REPORT, "utf8")) as OpsRemediateReport;
  } catch {
    return null;
  }
}

export function writeRemediateReport(report: OpsRemediateReport): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
}

function spawnMaintain(full: boolean): { pid: number | undefined; action: string } {
  const args = full
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
  return { pid: child.pid, action: full ? "maintain_full_detached" : "maintain_heal_detached" };
}

function spawnLocalStackHeal(): { status: number | null; action: string } {
  const script = join(ROOT, "scripts/local-stack.mjs");
  if (!existsSync(script)) return { status: 1, action: "local_stack_heal_missing" };
  const r = spawnSync(process.execPath, [script, "heal", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  return { status: r.status, action: `local_stack_heal_exit_${r.status ?? 1}` };
}

export interface RemediateDeps {
  /** Count open alerts right now */
  getAlertCount: () => number | Promise<number>;
  /** Start in-process regime catch-up */
  runRegime: () => Promise<void>;
}

/**
 * Execute whitelist remediations. Detached Maintain → STARTED until finalize on next poll.
 */
export async function runOpsRemediate(opts: {
  trigger: RemediateTrigger;
  taskIds: string[];
  alertsBefore: number;
  deps: RemediateDeps;
}): Promise<OpsRemediateReport> {
  const taskIds = [...new Set(opts.taskIds)].filter((id) => REMEDIATE_WHITELIST.has(id));
  const actions: string[] = [];
  const exits: Record<string, number | null> = {};

  if (taskIds.length === 0) {
    const report: OpsRemediateReport = {
      at: new Date().toISOString(),
      trigger: opts.trigger,
      taskIds: [],
      alertsBefore: opts.alertsBefore,
      alertsAfter: opts.alertsBefore,
      alertDelta: 0,
      value: "NEEDS_YOU",
      ok: true,
      actions: ["no_whitelist_tasks"],
      note: "Open alerts need Duo/OAuth/manual fix — nothing in the safe whitelist.",
    };
    writeRemediateReport(report);
    return report;
  }

  let detachedMaintain = false;
  const at = new Date().toISOString();

  for (const id of taskIds) {
    if (id === "maintain") {
      const { pid, action } = spawnMaintain(true);
      actions.push(`${action}_pid_${pid ?? "?"}`);
      exits[id] = null;
      detachedMaintain = true;
    } else if (id === "stack-ensure" || id === "stack-ensure-1445") {
      const heal = spawnLocalStackHeal();
      actions.push(heal.action);
      exits[id] = heal.status;
      const { pid, action } = spawnMaintain(false);
      actions.push(`${action}_pid_${pid ?? "?"}`);
      exits.maintain_heal = null;
      detachedMaintain = true;
    } else if (id === "regime") {
      try {
        await opts.deps.runRegime();
        actions.push("regime_catchup_ok");
        exits[id] = 0;
      } catch (err) {
        actions.push(`regime_catchup_fail:${String(err).slice(0, 80)}`);
        exits[id] = 1;
      }
    }
  }

  if (detachedMaintain) {
    const report: OpsRemediateReport = {
      at,
      trigger: opts.trigger,
      taskIds,
      alertsBefore: opts.alertsBefore,
      alertsAfter: null,
      alertDelta: null,
      value: "STARTED",
      ok: true,
      actions,
      exits,
      pendingUntilMaintainTs: at,
      note: "Maintain/heal started detached — Ops Sync will finalize alert Δ when maintain-last.json updates.",
    };
    writeRemediateReport(report);
    return report;
  }

  const alertsAfter = await opts.deps.getAlertCount();
  const delta = alertsAfter - opts.alertsBefore;
  const failed = Object.values(exits).some((e) => e != null && e !== 0);
  const report: OpsRemediateReport = {
    at,
    trigger: opts.trigger,
    taskIds,
    alertsBefore: opts.alertsBefore,
    alertsAfter,
    alertDelta: delta,
    value: failed ? "FAILED" : delta < 0 ? "IMPROVED" : "NO MATERIAL CHANGE",
    ok: !failed,
    actions,
    exits,
  };
  writeRemediateReport(report);
  return report;
}

/** If last report is STARTED and maintain-last is newer, stamp alertsAfter + value. */
export async function finalizeRemediateIfPending(
  getAlertCount: () => number | Promise<number>,
): Promise<OpsRemediateReport | null> {
  const prev = readRemediateReport();
  if (!prev || prev.value !== "STARTED" || !prev.pendingUntilMaintainTs) return prev;

  let maintainTs: string | null = null;
  for (const name of ["maintain-last.json", "maintain-full-last.json"]) {
    try {
      const p = join(LOG_DIR, name);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8")) as { ts?: string };
      if (typeof j.ts === "string" && (!maintainTs || j.ts > maintainTs)) maintainTs = j.ts;
    } catch { /* ignore */ }
  }
  if (!maintainTs || maintainTs < prev.pendingUntilMaintainTs) return prev;

  const alertsAfter = await getAlertCount();
  const delta = alertsAfter - prev.alertsBefore;
  const next: OpsRemediateReport = {
    ...prev,
    alertsAfter,
    alertDelta: delta,
    value: delta < 0 ? "IMPROVED" : "NO MATERIAL CHANGE",
    ok: true,
    actions: [...prev.actions, `finalized_maintain_ts_${maintainTs}`],
    note: undefined,
    pendingUntilMaintainTs: undefined,
  };
  writeRemediateReport(next);
  return next;
}

/** Heal-cadence proof when Maintain heal runs outside the API (LaunchAgent). */
export function recordHealCadenceRemediate(opts: {
  processHealed: boolean;
  actions: string[];
  ok: boolean;
}): void {
  const report: OpsRemediateReport = {
    at: new Date().toISOString(),
    trigger: "heal-cadence",
    taskIds: ["maintain"],
    alertsBefore: -1,
    alertsAfter: -1,
    alertDelta: null,
    value: opts.processHealed ? "IMPROVED" : opts.ok ? "NO MATERIAL CHANGE" : "FAILED",
    ok: opts.ok,
    actions: opts.actions.slice(0, 12),
    note: "Written by maintain.mjs heal path (no Nucleus alert count — see maintain-last.json).",
  };
  writeRemediateReport(report);
}
