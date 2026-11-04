import { Router } from "express";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import {
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
} from "../../lib/scheduler.js";
import { getResearchOpsReport } from "../../lib/research-ops.js";
import { type RegimeCheckpoint } from "../../lib/intraday-regime.js";
import { buildInventory, buildNucleus, detectOpsAlerts } from "../../lib/scheduled-tasks-inventory.js";
import {
  countOpenAlerts,
  finalizeRemediateIfPending,
  readRemediateReport,
  remediateTaskIdsFromAlerts,
  REMEDIATE_WHITELIST,
  runOpsRemediate,
} from "../../lib/ops-remediate.js";
import { priceCoverage } from "../../lib/price-coverage.js";
import { getOptionsChainSourceStats } from "../../lib/options-chain-source-stats.js";
import { buildTasks, findTask } from "./inventory.js";
import {
  checkpointsForAgenda,
  LOG_DIR,
  ptParts,
  readJsonFile,
  readMacResources,
  readTail,
  RBH_SCRIPT,
  ROOT,
  PM_PY,
  LAUNCH_AGENTS,
  launchdState,
} from "./helpers.js";
import { execFileSync } from "node:child_process";

const router = Router();

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
