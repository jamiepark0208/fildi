/**
 * Ops inventory + conflict/drift detection for Settings → Scheduled Tasks.
 * Static write-owner map + live status from buildTasks / LaunchAgents.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type OpsAlertSeverity = "critical" | "warn" | "info";
type TaskRunner = "api-scheduler" | "launchd" | "supervised";
type TaskStatus = "running" | "ok" | "warn" | "failed" | "idle" | "never" | "off" | "missing" | "waiting" | "degraded";

/** Minimal task shape needed for inventory / alerts / nucleus (avoids circular import with routes). */
export interface InventoryTaskInput {
  id: string;
  name: string;
  summary: string;
  detail?: string | null;
  runner: TaskRunner;
  status: TaskStatus;
  enabled: boolean;
  todayState: string | null;
  verifyChecks?: { ok: boolean; label: string; fix?: string | null }[];
  running?: boolean;
  /** For Ops Nucleus proof strip */
  lastRun?: string | null;
  outcome?: string | null;
  purpose?: string | null;
  verified?: boolean | null;
}

export interface OpsAlert {
  id: string;
  severity: OpsAlertSeverity;
  title: string;
  detail: string;
  taskIds: string[];
  fix?: string | null;
}

/** Lightweight research probe rollup for ops alerts (avoids importing research-ops). */
export interface ResearchOpsAlertInput {
  wrdsOverall: "ok" | "warn" | "down" | "missing" | string;
  lsegOverall: "ok" | "warn" | "down" | "missing" | string;
  desktopReachable: boolean;
  fixHints?: string[];
}

/** Weekly digest freshness for Sunday agenda / alerts. */
export interface OpsDigestAlertInput {
  /** ISO ts of weekly-data-ops-last.json (or null if missing) */
  lastTs: string | null;
  /** Age in days; null if never */
  ageDays: number | null;
}

export interface InventoryRow {
  taskId: string;
  name: string;
  runner: TaskRunner;
  /** Who is supposed to own this write path */
  owner: string;
  writes: string[];
  mutex: string | null;
  cadence: string;
  enabled: boolean;
  status: TaskStatus;
  /** Designated primary for its writes (vs legacy/backup) */
  primary: boolean;
}

/** Expected com.fildi.* LaunchAgents on this Mac. */
export const EXPECTED_LAUNCH_AGENTS = [
  "com.fildi.maintain",
  "com.fildi.stack-ensure",
  "com.fildi.rbh-daily-export",
  "com.fildi.rbh-export-prompt",
  "com.fildi.pm-alerts",
  "com.fildi.transcripts",
  "com.fildi.option-history",
  "com.fildi.openjev",
] as const;

/** Static catalog — keep in sync with buildTasks ids (catalog rows only). */
const INVENTORY_SPEC: Record<
  string,
  {
    owner: string;
    writes: string[];
    mutex: string | null;
    cadence: string;
    primary: boolean;
  }
> = {
  maintain: {
    owner: "launchd · com.fildi.maintain",
    writes: [
      "enrichment_runs",
      "fundamentals (lean)",
      "scores refresh",
      "retention prune",
      "morning precompute",
      "Sunday ops digest (value-log)",
      "Sunday Mac resource audit (watchlist_sync.resource_snapshots, ~/.fildi/resource-latest.json; trims fildi logs)",
    ],
    mutex: "enrichmentRunning / maintain lock",
    cadence: "7:00 AM full · 12:00/2:45 heal · Sun digest",
    primary: true,
  },
  "ops-digest": {
    owner: "launchd · com.fildi.maintain (Sun) / Run now",
    writes: ["data-ops-value-log.md", "weekly-data-ops-last.json"],
    mutex: "skip drain/peer when Maintain covered ≤7d",
    cadence: "Sunday with Maintain full · digest-only",
    primary: true,
  },
  "enrichment-api": {
    owner: "api-scheduler (legacy — off on Mac)",
    writes: ["enrichment_runs", "fundamentals (full)"],
    mutex: "enrichmentRunning",
    cadence: "Sun/Thu 02 UTC when enabled",
    primary: false,
  },
  "event-bullets": {
    owner: "api-scheduler (+ Maintain morning)",
    writes: ["event_bullets / watchlist bullets"],
    mutex: "eventBulletsRunning",
    cadence: "once daily ~7 AM PT",
    primary: true,
  },
  "earnings-backfill": {
    owner: "api-scheduler (+ Maintain morning)",
    writes: ["earnings history (≤60 stale/day)"],
    mutex: "earningsBackfillRunning",
    cadence: "once daily ~7 AM PT",
    primary: true,
  },
  "fmp-analyst-feed": {
    owner: "api-scheduler (+ Maintain morning)",
    writes: ["fmp analyst grades/PT archive"],
    mutex: "fmpAnalystFeedRunning",
    cadence: "once daily ~7 AM PT",
    primary: true,
  },
  "desk-ingest": {
    owner: "api-scheduler",
    writes: ["desk_commentaries"],
    mutex: "deskIngestRunning",
    cadence: "every ~25m",
    primary: true,
  },
  "schwab-health": {
    owner: "api-scheduler",
    writes: ["schwab token refresh (local file)"],
    mutex: "schwabHealthRunning",
    cadence: "every ~6h",
    primary: true,
  },
  "schwab-1m": {
    owner: "api-scheduler",
    writes: ["watchlist_sync.intraday_bars_1m (source=schwab)"],
    mutex: "schwab1mPollRunning",
    cadence: "every 5m RTH after 07:05 PT (~20 symbols)",
    primary: true,
  },
  "research-ops-health": {
    owner: "api-scheduler",
    writes: ["research ops probe report (memory)"],
    mutex: "researchOpsRunning",
    cadence: "every ~6h",
    primary: true,
  },
  "lseg-daily-sync": {
    owner: "supervised (Claude / you)",
    writes: ["lseg_research.signals_daily", "lseg_research.events"],
    mutex: "lane contract — no vendor cron",
    cadence: "weekdays after open",
    primary: true,
  },
  "lseg-weekly-sync": {
    owner: "supervised (Claude / you)",
    writes: ["lseg coverage/ids/moves/holders/starmine/gold"],
    mutex: "lane contract — no vendor cron",
    cadence: "weekly",
    primary: true,
  },
  "wrds-monthly-ibes": {
    owner: "supervised (Claude / you)",
    writes: ["wrds_research.ibes_*"],
    mutex: "Duo / WRDS session",
    cadence: "monthly",
    primary: true,
  },
  "wrds-quarterly-crsp": {
    owner: "supervised (Claude / you)",
    writes: ["wrds_research.crsp_dsf"],
    mutex: "Duo / WRDS session",
    cadence: "quarterly",
    primary: true,
  },
  "pm-alerts": {
    owner: "launchd · com.fildi.pm-alerts → pm_alerts.py (+ pm_book --live, + forecast_ledger log/resolve A129)",
    writes: ["watchlist_sync.pm_alerts", "watchlist_sync.pm_book_latest", "watchlist_sync.forecast_ledger"],
    mutex: "none (read-only Schwab quotes; self-throttles: 15 min market hours, 2 h otherwise)",
    cadence: "every 15 min (wakes) · runs 15 min 6:30–1:15 PT, 2 h otherwise",
    primary: true,
  },
  openjev: {
    owner: "launchd · com.fildi.openjev → openjev_local.py --tick (local 26B OpenJev, A129)",
    writes: ["watchlist_sync.openjev_batches", "watchlist_sync.forecast_ledger", "watchlist_sync.openjev_runs"],
    mutex: "RAM guard (free ≥ measured peak + 8 GB, on AC); one server at a time on 127.0.0.1:8080",
    cadence: "tick every 15 min · freeze 5:30 AM PT · answer 5:30–9:00 / 9:00–11:30 PM PT windows",
    primary: true,
  },
  transcripts: {
    owner: "launchd · com.fildi.transcripts → transcripts.py",
    writes: ["watchlist_sync.earnings_transcripts", "watchlist_sync.transcript_checks", "api_usage (av/finnhub/anthropic)"],
    mutex: "AV budget 25/day (reserve 5)",
    cadence: "daily 5:30 AM PT",
    primary: true,
  },
  "option-history": {
    owner: "launchd · com.fildi.option-history → analysis/option_history.py",
    writes: ["optlab.* (contracts, bars, legs, earnings_moves, iv30, trades, findings)", "api_usage (polygon)"],
    mutex: "file lock /tmp/fildi-logs/option-history.lock; Polygon 5 calls/min",
    cadence: "nightly 3:00 AM PT (resumable; minutes once backfilled)",
    primary: false,
  },
  "rbh-export": {
    owner: "launchd · com.fildi.rbh-export-prompt → Claude session",
    writes: ["~/rbh_scripts/*.csv (holdings/orders/…)"],
    mutex: "export_prompt lock (≤4 prompts / close)",
    cadence: "weekdays after close · ask-first",
    primary: true,
  },
  "rbh-ingest": {
    owner: "launchd · com.fildi.rbh-daily-export",
    writes: ["portfolio_* from RH CSVs"],
    mutex: "CSV presence + ingest lock",
    cadence: "weekdays 3:00 PM PT · catch-up on wake (7d)",
    primary: true,
  },
  "option-scores": {
    owner: "api-scheduler",
    writes: ["option_score_snapshots"],
    mutex: "optionScoreRunning · skip Fri (model-snapshot dual-writes)",
    cadence: "Mon–Thu ~12:00 PM PT",
    primary: true,
  },
  "model-snapshot": {
    owner: "api-scheduler",
    writes: ["model_recs", "option_score_snapshots (Fri dual-write)"],
    mutex: "modelSnapshotRunning",
    cadence: "Fri ~12:00 PM PT",
    primary: true,
  },
  "model-grade": {
    owner: "api-scheduler",
    writes: ["model grades / trade expiry"],
    mutex: "tradeExpiryRunning",
    cadence: "Fri evening / Sat",
    primary: true,
  },
  regime: {
    owner: "api-scheduler",
    writes: ["intraday regime checkpoints"],
    mutex: "market-hours only",
    cadence: "11× / session",
    primary: true,
  },
  "ai-workflow-review": {
    owner: "supervised",
    writes: [".cursor/context/ai-workflow-reviews/*"],
    mutex: null,
    cadence: "Sun ~6 PM PT",
    primary: true,
  },
};

function listFildiLaunchAgents(): string[] {
  const dir = join(homedir(), "Library/LaunchAgents");
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith("com.fildi.") && f.endsWith(".plist"))
      .map((f) => f.replace(/\.plist$/, ""));
  } catch {
    return [];
  }
}

function taskById(tasks: InventoryTaskInput[], id: string): InventoryTaskInput | undefined {
  return tasks.find((t) => t.id === id);
}

export function buildInventory(tasks: InventoryTaskInput[]): InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const [taskId, spec] of Object.entries(INVENTORY_SPEC)) {
    const t = taskById(tasks, taskId);
    if (!t) continue;
    rows.push({
      taskId,
      name: t.name,
      runner: t.runner,
      owner: spec.owner,
      writes: spec.writes,
      mutex: spec.mutex,
      cadence: spec.cadence,
      enabled: t.enabled && t.status !== "off" && t.status !== "missing",
      status: t.status,
      primary: spec.primary,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function detectOpsAlerts(opts: {
  tasks: InventoryTaskInput[];
  enrichmentDisabled: boolean;
  todayYmd: string;
  /** PT day-of-week 0=Sun … 6=Sat (for Sunday digest drift) */
  ptDow?: number;
  /** Minutes from midnight PT */
  nowMinutesPt?: number;
  /** Test seam — defaults to scanning ~/Library/LaunchAgents */
  installedLaunchAgents?: string[];
  research?: ResearchOpsAlertInput | null;
  opsDigest?: OpsDigestAlertInput | null;
  /** Daily-bar coverage (lib/price-coverage.ts); null/omitted = not checked */
  priceCoverage?: {
    expected: string; fresh: number; active: number; pct: number; staleSample: string[];
    noBar5d?: number; noBar5dSample?: string[];
  } | null;
}): OpsAlert[] {
  const { tasks, enrichmentDisabled } = opts;
  const alerts: OpsAlert[] = [];
  const byId = (id: string) => taskById(tasks, id);

  const maintain = byId("maintain");
  const enrich = byId("enrichment-api");
  const maintainLoaded = maintain?.status !== "missing" && maintain?.enabled === true;
  const enrichOn = enrich != null && enrich.status !== "off" && enrich.enabled;

  // Duplicate enrichment: LaunchAgent Maintain + in-process scheduler both live
  if (maintainLoaded && enrichOn && !enrichmentDisabled) {
    alerts.push({
      id: "dup-enrichment",
      severity: "critical",
      title: "Duplicate enrichment owners",
      detail:
        "Mac Maintain LaunchAgent is loaded and in-process Enrichment is still enabled. Both can write enrichment_runs / fundamentals.",
      taskIds: ["maintain", "enrichment-api"],
      fix: "Set DISABLE_SCHEDULER_ENRICHMENT=1 on the API (Mac SoT) so Maintain owns enrich.",
    });
  }

  // Nobody owns enrich
  if (!maintainLoaded && enrichmentDisabled) {
    alerts.push({
      id: "no-enrich-owner",
      severity: "warn",
      title: "No enrichment owner",
      detail: "In-process enrichment is off and Mac Maintain LaunchAgent is not loaded.",
      taskIds: ["maintain", "enrichment-api"],
      fix: "Run scripts/install-maintenance-launchd.sh (or re-enable API enrichment only if not on Mac).",
    });
  }

  // Expected LaunchAgents missing / unexpected
  const installed = opts.installedLaunchAgents ?? listFildiLaunchAgents();
  const expected = new Set<string>(EXPECTED_LAUNCH_AGENTS);
  for (const label of EXPECTED_LAUNCH_AGENTS) {
    if (!installed.includes(label)) {
      alerts.push({
        id: `missing-la-${label}`,
        severity: label === "com.fildi.maintain" ? "critical" : "warn",
        title: `LaunchAgent missing · ${label}`,
        detail: `${label}.plist not found under ~/Library/LaunchAgents.`,
        taskIds: label.includes("rbh-export-prompt")
          ? ["rbh-export"]
          : label.includes("pm-alerts")
            ? ["pm-alerts"]
            : label.includes("transcripts")
              ? ["transcripts"]
            : label.includes("openjev")
              ? ["openjev"]
            : label.includes("option-history")
              ? ["option-history"]
          : label.includes("rbh-daily")
            ? ["rbh-ingest"]
            : label.includes("stack")
              ? ["maintain"]
              : ["maintain"],
        fix:
          label === "com.fildi.stack-ensure"
            ? "scripts/install-stack-ensure-launchd.sh"
            : label === "com.fildi.maintain"
              ? "scripts/install-maintenance-launchd.sh"
              : label === "com.fildi.pm-alerts"
                ? "scripts/install-pm-alerts-launchd.sh"
                : label === "com.fildi.transcripts"
                  ? "scripts/install-transcripts-launchd.sh"
                : label === "com.fildi.openjev"
                  ? "scripts/install-openjev-launchd.sh"
                : label === "com.fildi.option-history"
                  ? "scripts/install-option-history-launchd.sh"
              : "Reinstall from ~/rbh_scripts / install scripts",
      });
    }
  }
  for (const label of installed) {
    if (!expected.has(label)) {
      alerts.push({
        id: `unexpected-la-${label}`,
        severity: "info",
        title: `Uncatalogued LaunchAgent · ${label}`,
        detail: "Present on disk but not in the Scheduled Tasks inventory map. Add it or remove the plist.",
        taskIds: [],
        fix: "Document in scheduled-tasks inventory or unload: launchctl bootout gui/$UID/" + label,
      });
    }
  }

  // Drift: overdue today agenda items
  const overdue = tasks.filter((t) => t.todayState === "overdue");
  if (overdue.length > 0) {
    alerts.push({
      id: "drift-overdue",
      severity: overdue.length >= 3 ? "critical" : "warn",
      title: `${overdue.length} task(s) overdue today`,
      detail: overdue.map((t) => t.name).slice(0, 6).join(" · ") + (overdue.length > 6 ? "…" : ""),
      taskIds: overdue.map((t) => t.id).slice(0, 8),
      fix: "Open Today agenda — Run now on overdue rows, or heal stack if API was down.",
    });
  }

  // Drift: primary catalog tasks never ran / failed
  const failed = tasks.filter(
    (t) =>
      (t.status === "failed" || t.status === "missing") &&
      !t.id.startsWith("regime-") &&
      t.id !== "stack-ensure" &&
      t.id !== "stack-ensure-1445",
  );
  for (const t of failed) {
    alerts.push({
      id: `failed-${t.id}`,
      severity: t.status === "missing" ? "critical" : "warn",
      title: `${t.name} · ${t.status}`,
      detail: t.detail ?? t.summary,
      taskIds: [t.id],
      fix: t.verifyChecks?.find((c) => !c.ok)?.fix ?? "Expand task · check logs",
    });
  }

  // Write-target collisions among enabled primaries (static pairs we care about)
  const optionScores = byId("option-scores");
  const modelSnap = byId("model-snapshot");
  if (
    optionScores?.running &&
    modelSnap?.running
  ) {
    alerts.push({
      id: "overlap-option-model",
      severity: "warn",
      title: "Option scores + model snapshot both running",
      detail: "Both write option_score_snapshots. Friday is dual-write by design; concurrent runs other days may race.",
      taskIds: ["option-scores", "model-snapshot"],
      fix: "Wait for one to finish; avoid manual Run on both.",
    });
  }

  // Research cache drift (supervised syncs) — surface in Ops health, not only the Research row.
  const research = opts.research;
  if (research) {
    const hints = (research.fixHints ?? []).slice(0, 2).join(" · ");
    if (research.wrdsOverall === "down" || research.wrdsOverall === "missing") {
      alerts.push({
        id: "research-wrds-stale",
        severity: "critical",
        title: "WRDS research cache down/missing",
        detail: hints || `wrds overall=${research.wrdsOverall}`,
        taskIds: ["research-ops-health", "wrds-monthly-ibes"],
        fix: "cd research/wrds && .venv/bin/python sync_ibes.py (Duo/network)",
      });
    } else if (research.wrdsOverall === "warn") {
      alerts.push({
        id: "research-wrds-warn",
        severity: "warn",
        title: "WRDS research cache stale",
        detail: hints || "IBES/CRSP past freshness threshold — Street/fund growth may lag",
        taskIds: ["research-ops-health", "wrds-monthly-ibes"],
        fix: "cd research/wrds && .venv/bin/python sync_ibes.py",
      });
    }
    if (research.lsegOverall === "down") {
      alerts.push({
        id: "research-lseg-down",
        severity: "critical",
        title: "LSEG research cache down",
        detail: hints || `lseg overall=${research.lsegOverall}`,
        taskIds: ["research-ops-health", "lseg-daily-sync"],
        fix: "Open Workspace (:9000) → cd research/lseg && sync_signals.py && sync_events.py",
      });
    } else if (research.lsegOverall === "warn" || research.lsegOverall === "missing") {
      alerts.push({
        id: "research-lseg-warn",
        severity: "warn",
        title: "LSEG research cache stale/missing",
        detail:
          hints ||
          `lseg=${research.lsegOverall} · Workspace ${research.desktopReachable ? "up" : "closed"}`,
        taskIds: ["research-ops-health", "lseg-daily-sync", "lseg-weekly-sync"],
        fix: research.desktopReachable
          ? "cd research/lseg && .venv/bin/python sync_signals.py && sync_events.py"
          : "Open LSEG Workspace (logged in), then run daily sync",
      });
    } else if (!research.desktopReachable && (opts.ptDow ?? 1) >= 1 && (opts.ptDow ?? 1) <= 5) {
      alerts.push({
        id: "research-lseg-desktop",
        severity: "info",
        title: "LSEG Workspace closed (weekday)",
        detail: "Caches may still be fresh — reopen Workspace before the next supervised sync.",
        taskIds: ["research-ops-health", "lseg-daily-sync"],
        fix: "Launch Refinitiv Workspace and confirm :9000",
      });
    }
  }

  // Sunday ops digest: Maintain should write weekly-data-ops-last by ~8 AM PT.
  const dig = opts.opsDigest;
  const isSunday = opts.ptDow === 0;
  const afterDigestWindow = (opts.nowMinutesPt ?? 0) >= 8 * 60;
  if (isSunday && afterDigestWindow) {
    const fresh = dig?.ageDays != null && dig.ageDays <= 1.5;
    if (!fresh) {
      alerts.push({
        id: "ops-digest-missing",
        severity: "warn",
        title: "Weekly ops digest missing today",
        detail: dig?.lastTs
          ? `Last digest ${dig.lastTs} (age ${dig.ageDays?.toFixed(1) ?? "?"}d)`
          : "No weekly-data-ops-last.json yet",
        taskIds: ["ops-digest", "maintain"],
        fix: "Run Mac Maintain · full, or Run Weekly Ops Digest (digest-only)",
      });
    }
  }

  const pc = opts.priceCoverage;
  if (pc && pc.active > 0 && pc.pct < 0.95) {
    alerts.push({
      id: "prices-coverage",
      severity: pc.pct < 0.8 ? "critical" : "warn",
      title: "Daily price bars missing",
      detail: `${pc.fresh}/${pc.active} names have the ${pc.expected} bar (${Math.round(pc.pct * 100)}%). ` +
        `Oldest: ${pc.staleSample.join(", ")}`,
      taskIds: ["maintain"],
      fix: "cd artifacts/api-server && pnpm exec tsx src/scripts/backfill-stale-prices.ts (Schwab → Yahoo)",
    });
  }
  // A87 Maintain: active with no bar in ≥5 calendar days
  if (pc && typeof pc.noBar5d === "number" && pc.noBar5d > 0) {
    alerts.push({
      id: "prices-no-bar-5d",
      severity: pc.noBar5d > 20 ? "warn" : "info",
      title: "Active tickers with no bar in 5+ days",
      detail: `${pc.noBar5d} active · sample: ${(pc.noBar5dSample ?? []).join(", ")}`,
      taskIds: ["maintain"],
      fix: "backfill-stale-prices.ts (now includes Polygon soft-fill via fetchAndStoreOHLCV)",
    });
  }

  // Sort critical → warn → info
  const rank = { critical: 0, warn: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
}

/* ── Ops Nucleus (Phase A: L0/L1 gates + 7 workers) ─────────────────── */

export type NucleusStatus = "ok" | "warn" | "critical" | "idle" | "running" | "off" | "missing";

export interface NucleusProof {
  lastAt: string | null;
  outcome: string | null;
  writes: string[];
  actions?: { label: string; href?: string; taskId?: string }[];
}

export interface NucleusNode {
  id: string;
  label: string;
  status: NucleusStatus;
  summary: string;
  taskIds: string[];
  proof: NucleusProof;
}

export interface NucleusPayload {
  summary: { critical: number; warn: number; info: number; clean: boolean };
  gates: NucleusNode[];
  workers: NucleusNode[];
}

function worstStatus(statuses: NucleusStatus[]): NucleusStatus {
  const rank: Record<NucleusStatus, number> = {
    critical: 0,
    warn: 1,
    missing: 2,
    running: 3,
    idle: 4,
    off: 5,
    ok: 6,
  };
  let best = statuses[0] ?? "idle";
  for (const s of statuses) {
    if (rank[s] < rank[best]) best = s;
  }
  return best;
}

function taskToNucleusStatus(t: InventoryTaskInput | undefined): NucleusStatus {
  if (!t) return "missing";
  if (t.running) return "running";
  if (t.status === "failed" || t.status === "missing") return t.status === "missing" ? "missing" : "critical";
  if (t.status === "warn") return "warn";
  if (t.status === "off") return "off";
  if (t.status === "idle") return "idle";
  if (t.todayState === "overdue") return "warn";
  if (t.verified === false) return "warn";
  return "ok";
}

function inventoryWrites(inventory: InventoryRow[] | undefined, taskId: string): string[] {
  return inventory?.find((r) => r.taskId === taskId)?.writes ?? [];
}

function nodeFromTask(
  id: string,
  label: string,
  taskIds: string[],
  tasks: InventoryTaskInput[],
  inventory: InventoryRow[] | undefined,
  opts?: { summary?: string; status?: NucleusStatus; actions?: NucleusProof["actions"] },
): NucleusNode {
  const ts = taskIds.map((tid) => taskById(tasks, tid)).filter(Boolean) as InventoryTaskInput[];
  const primary = ts[0];
  const status = opts?.status ?? worstStatus(ts.map(taskToNucleusStatus));
  const writes = taskIds.flatMap((tid) => inventoryWrites(inventory, tid));
  const lastAt = ts.map((t) => t.lastRun).find(Boolean) ?? null;
  const outcome = ts.map((t) => t.outcome).find(Boolean) ?? null;
  const failChecks = ts.flatMap((t) => (t.verifyChecks ?? []).filter((c) => !c.ok).map((c) => c.label));
  const summary =
    opts?.summary ??
    (failChecks.length > 0
      ? failChecks.slice(0, 2).join(" · ")
      : primary?.summary ?? label);
  return {
    id,
    label,
    status,
    summary,
    taskIds,
    proof: {
      lastAt: lastAt ?? null,
      outcome: outcome ?? null,
      writes: [...new Set(writes)],
      actions: opts?.actions,
    },
  };
}

/**
 * Phase A Ops Nucleus — compose L0/L1 gates + 7 workers from existing tasks/alerts/research.
 * No extra I/O; pure rollup for GET /admin/scheduled-tasks.
 */
export function buildNucleus(opts: {
  tasks: InventoryTaskInput[];
  alerts: OpsAlert[];
  inventory?: InventoryRow[];
  research?: ResearchOpsAlertInput | null;
  enrichmentDisabled?: boolean;
}): NucleusPayload {
  const { tasks, alerts, inventory, research } = opts;
  const byId = (id: string) => taskById(tasks, id);

  const maintain = byId("maintain");
  const stack = byId("stack-ensure");
  const researchTask = byId("research-ops-health");
  const schwab = byId("schwab-health");
  const optionScores = byId("option-scores");
  const modelSnap = byId("model-snapshot");
  const modelGrade = byId("model-grade");
  const rbhIngest = byId("rbh-ingest");
  const rbhExport = byId("rbh-export");

  // L0 Process: Maintain LaunchAgent + stack ensure + Postgres (via maintain verify)
  const maintainOk = maintain != null && maintain.status !== "missing" && maintain.enabled;
  const stackOk = stack != null && stack.status !== "missing" && stack.status !== "failed";
  const processChecks = [
    ...(maintain?.verifyChecks ?? []).filter((c) => /postgres|process|stack|api|vite/i.test(c.label)),
  ];
  const processFail = processChecks.some((c) => !c.ok) || !maintainOk || (stack != null && stack.status === "failed");
  const processWarn =
    !processFail &&
    (maintain?.status === "warn" || stack?.status === "warn" || processChecks.some((c) => !c.ok));
  const l0Status: NucleusStatus = !maintainOk
    ? "critical"
    : processFail
      ? "critical"
      : processWarn
        ? "warn"
        : stackOk || stack == null
          ? "ok"
          : "warn";
  const l0: NucleusNode = {
    id: "L0_process",
    label: "L0 Process",
    status: l0Status,
    summary: !maintainOk
      ? "Maintain LaunchAgent missing or unloaded"
      : processFail
        ? processChecks.filter((c) => !c.ok).map((c) => c.label).join(" · ") || "Process check failed"
        : "API · Vite · Postgres · Maintain",
    taskIds: ["maintain", "stack-ensure"].filter((id) => byId(id)),
    proof: {
      lastAt: maintain?.lastRun ?? stack?.lastRun ?? null,
      outcome: maintain?.outcome ?? stack?.outcome ?? null,
      writes: inventoryWrites(inventory, "maintain"),
      actions: [
        { label: "Run Maintain", taskId: "maintain" },
        { label: "Ensure stack", taskId: "stack-ensure" },
      ],
    },
  };

  // L1 Data: Maintain verified (incl. actions[] exits) + research not down + no critical data alerts
  const dataCritical = alerts.filter(
    (a) =>
      a.severity === "critical" &&
      (a.id.includes("enrich") || a.id.includes("research") || a.id.includes("drift")),
  );
  const researchDown = research?.wrdsOverall === "down" || researchTask?.status === "failed";
  const researchWarn =
    research?.wrdsOverall === "warn" ||
    research?.lsegOverall === "warn" ||
    research?.lsegOverall === "down" ||
    researchTask?.status === "warn";
  const maintainActionFail = (maintain?.verifyChecks ?? []).some(
    (c) => !c.ok && /actions exited/i.test(c.label),
  );
  const maintainVerified =
    maintain?.verified !== false && maintain?.status !== "failed" && !maintainActionFail;
  const l1Status: NucleusStatus =
    dataCritical.length > 0 || researchDown
      ? "critical"
      : !maintainVerified || researchWarn || maintain?.status === "warn" || maintainActionFail
        ? "warn"
        : "ok";
  const l1: NucleusNode = {
    id: "L1_data",
    label: "L1 Data",
    status: l1Status,
    summary:
      dataCritical[0]?.title ??
      (researchDown
        ? "Research / WRDS down"
        : maintainActionFail
          ? "Maintain actions[] had non-zero exits"
          : researchWarn
            ? "Research stale or warn"
            : maintainVerified
              ? "Enrich · retention · research OK"
              : "Maintain not verified"),
    taskIds: ["maintain", "research-ops-health", "enrichment-api"].filter((id) => byId(id)),
    proof: {
      lastAt: maintain?.lastRun ?? researchTask?.lastRun ?? null,
      outcome: maintain?.outcome ?? null,
      writes: [
        ...inventoryWrites(inventory, "maintain"),
        ...inventoryWrites(inventory, "research-ops-health"),
      ],
      actions: [
        { label: "Stock DB", href: "settings:stockdb" },
        { label: "API Monitor", href: "settings:api-monitor" },
        { label: "Run Maintain", taskId: "maintain" },
      ],
    },
  };

  const vendorTasks = ["schwab-health", "schwab-1m", "maintain"].filter((id) => byId(id));
  const vendorStatus = worstStatus([
    taskToNucleusStatus(schwab),
    alerts.some((a) => a.id === "dup-enrichment") ? "critical" : "ok",
    opts.enrichmentDisabled === false && maintainOk ? "warn" : "ok",
  ]);

  const scoreTasks = ["option-scores"].filter((id) => byId(id));
  const modelTasks = ["model-snapshot", "model-grade"].filter((id) => byId(id));
  const rhTasks = ["rbh-ingest", "rbh-export"].filter((id) => byId(id));

  const workers: NucleusNode[] = [
    nodeFromTask("maintain", "Maintain", ["maintain"], tasks, inventory, {
      actions: [
        { label: "Run", taskId: "maintain" },
        { label: "Logs", taskId: "maintain" },
      ],
    }),
    nodeFromTask("stack", "Stack", ["stack-ensure"], tasks, inventory, {
      summary: stack?.summary ?? "Ensure API + Vite",
      actions: [{ label: "Ensure stack", taskId: "stack-ensure" }],
    }),
    nodeFromTask("vendors", "Vendors", vendorTasks.length ? vendorTasks : ["maintain"], tasks, inventory, {
      status: vendorStatus === "ok" && schwab == null ? taskToNucleusStatus(maintain) : vendorStatus,
      summary:
        schwab?.summary ??
        (opts.enrichmentDisabled
          ? "Maintain owns enrich · vendor budgets in Maintain"
          : "Check enrichment ownership / Schwab"),
      actions: [
        { label: "API Monitor", href: "settings:api-monitor" },
        { label: "Schwab health", taskId: "schwab-health" },
        { label: "Schwab 1m bars", taskId: "schwab-1m" },
      ],
    }),
    nodeFromTask("research", "Research", ["research-ops-health"], tasks, inventory, {
      status: researchDown ? "critical" : researchWarn ? "warn" : taskToNucleusStatus(researchTask),
      summary:
        researchDown || researchWarn
          ? [research?.wrdsOverall && `WRDS ${research.wrdsOverall}`, research?.lsegOverall && `LSEG ${research.lsegOverall}`]
              .filter(Boolean)
              .join(" · ") || researchTask?.summary || "Research ops"
          : researchTask?.summary ?? "WRDS · LSEG · desk",
      actions: [
        { label: "Refresh health", taskId: "research-ops-health" },
        { label: "Stock DB", href: "settings:stockdb" },
      ],
    }),
    nodeFromTask("scores", "Scores", scoreTasks.length ? scoreTasks : ["option-scores"], tasks, inventory, {
      summary: optionScores?.summary ?? "Option score snapshots (fund/tech via Maintain)",
      actions: [{ label: "Run option scores", taskId: "option-scores" }],
    }),
    nodeFromTask("model", "Model", modelTasks.length ? modelTasks : ["model-snapshot"], tasks, inventory, {
      summary: [modelSnap, modelGrade].filter(Boolean).map((t) => t!.summary).join(" · ") || "Snapshots · grades",
      actions: [{ label: "Run snapshot", taskId: "model-snapshot" }],
    }),
    nodeFromTask("rh", "RH", rhTasks.length ? rhTasks : ["rbh-ingest"], tasks, inventory, {
      summary: [rbhIngest, rbhExport].filter(Boolean).map((t) => t!.summary).join(" · ") || "Robinhood ingest / export",
      actions: [{ label: "Ingest", taskId: "rbh-ingest" }],
    }),
  ];

  const critical = alerts.filter((a) => a.severity === "critical").length;
  const warn = alerts.filter((a) => a.severity === "warn").length;
  const info = alerts.filter((a) => a.severity === "info").length;
  const gateCritical = [l0, l1].filter((g) => g.status === "critical").length;
  const gateWarn = [l0, l1].filter((g) => g.status === "warn").length;

  return {
    summary: {
      critical: critical + gateCritical,
      warn: warn + gateWarn,
      info,
      clean: critical + gateCritical + warn + gateWarn === 0,
    },
    gates: [l0, l1],
    workers,
  };
}
