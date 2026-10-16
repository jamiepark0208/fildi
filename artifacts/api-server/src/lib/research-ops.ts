/**
 * Research lane ops health (WRDS + LSEG).
 *
 * Contract: API never calls WRDS Cloud or LSEG Workspace live for scoring.
 * This module only probes local Postgres caches + optional TCP to LSEG desktop
 * proxy (127.0.0.1:9000). Auto-heal is limited to what we can fix without a GUI:
 * warn on staleness; never start Workspace or burn WRDS quota from the scheduler.
 */
import net from "net";
import { pool } from "@workspace/db";
import { logger } from "./logger.js";

const LSEG_HOST = "127.0.0.1";
const LSEG_PORT = 9000;
const STALE_MS = {
  // WRDS — monthly / infrequent pulls (false-stale at default 7d was noisy in API Monitor)
  ibes_statsum: 40 * 24 * 60 * 60 * 1000,
  ibes_surpsum: 40 * 24 * 60 * 60 * 1000,
  crsp_dsf: 45 * 24 * 60 * 60 * 1000,
  security_map_wrds: 40 * 24 * 60 * 60 * 1000,
  calibrate_starmine: 40 * 24 * 60 * 60 * 1000,
  reconcile_consensus: 40 * 24 * 60 * 60 * 1000,
  event_windows: 40 * 24 * 60 * 60 * 1000,
  finratio_snapshot: 40 * 24 * 60 * 60 * 1000,
  // LSEG — weekday vs weekly
  signals_daily: 36 * 60 * 60 * 1000,
  daily_history: 36 * 60 * 60 * 1000,
  events: 14 * 24 * 60 * 60 * 1000, // macro calendar; weekly refresh (was 10d — false Conn orange)
  security_map_ids: 35 * 24 * 60 * 60 * 1000,
  starmine_history: 90 * 24 * 60 * 60 * 1000,
  earnings_moves: 8 * 24 * 60 * 60 * 1000,
  holders_top: 14 * 24 * 60 * 60 * 1000,
  coverage: 14 * 24 * 60 * 60 * 1000,
  gold_audit: 14 * 24 * 60 * 60 * 1000,
} as const;

export type PullError = {
  dataset: string;
  error: string;
  finishedAt: string | null;
};

export type LaneStatus = "ok" | "warn" | "down" | "missing";

export type DatasetHealth = {
  dataset: string;
  lastOkAt: string | null;
  watermark: string | null;
  lastRows: number | null;
  ageMs: number | null;
  status: LaneStatus;
  hint: string | null;
};

export type ResearchOpsReport = {
  checkedAt: string;
  appImpact: {
    scoresNeedLiveVendor: false;
    scoresUseLocalCache: true;
    note: string;
  };
  localDb: { ok: boolean; error: string | null };
  wrds: {
    schema: boolean;
    envHint: string | null;
    datasets: DatasetHealth[];
    overall: LaneStatus;
    lastError: PullError | null;
  };
  lseg: {
    schema: boolean;
    desktopProxy: { reachable: boolean; host: string; port: number; hint: string | null };
    datasets: DatasetHealth[];
    overall: LaneStatus;
    lastError: PullError | null;
  };
  fixHints: string[];
};

function ageStatus(dataset: string, lastOkAt: Date | null): LaneStatus {
  if (!lastOkAt) return "missing";
  const max = STALE_MS[dataset as keyof typeof STALE_MS] ?? 7 * 24 * 60 * 60 * 1000;
  const age = Date.now() - lastOkAt.getTime();
  if (age > max * 2) return "down";
  if (age > max) return "warn";
  return "ok";
}

export function probeTcp(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function schemaExists(name: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) AS exists`,
    [name],
  );
  return !!r.rows[0]?.exists;
}

async function loadSyncState(schema: "wrds_research" | "lseg_research"): Promise<DatasetHealth[]> {
  const r = await pool.query<{
    dataset: string;
    watermark: string | null;
    last_ok_at: Date | null;
    last_rows: number | null;
  }>(
    `SELECT dataset, watermark, last_ok_at, last_rows
     FROM ${schema}.sync_state
     ORDER BY dataset`,
  );
  return r.rows.map((row) => {
    const last = row.last_ok_at ? new Date(row.last_ok_at) : null;
    const status = ageStatus(row.dataset, last);
    const ageMs = last ? Date.now() - last.getTime() : null;
    let hint: string | null = null;
    if (status === "missing") {
      hint =
        schema === "wrds_research"
          ? `Run research/wrds sync for ${row.dataset}`
          : `Run research/lseg sync for ${row.dataset} (Workspace desktop required)`;
    } else if (status === "warn" || status === "down") {
      hint = `${row.dataset} last ok ${last?.toISOString() ?? "never"} — refresh when vendor is up`;
    }
    return {
      dataset: row.dataset,
      lastOkAt: last?.toISOString() ?? null,
      watermark: row.watermark,
      lastRows: row.last_rows,
      ageMs,
      status,
      hint,
    };
  });
}

function rollup(schemaOk: boolean, datasets: DatasetHealth[], extraDown = false): LaneStatus {
  if (!schemaOk) return "missing";
  if (extraDown) return "warn"; // desktop down ≠ wipe cache
  if (datasets.length === 0) return "missing";
  if (datasets.some((d) => d.status === "down")) return "down";
  if (datasets.some((d) => d.status === "warn" || d.status === "missing")) return "warn";
  return "ok";
}

async function latestPullError(schema: "wrds_research" | "lseg_research"): Promise<PullError | null> {
  try {
    // Only surface hard errors that are NEWER than that dataset's last_ok_at.
    // Soft unresolved (e.g. one foreign ticker) and superseded bugs (pends column,
    // later-resolved POET) must not poison Settings forever.
    const r = await pool.query<{ dataset: string; error: string | null; finished_at: Date | null }>(
      `SELECT p.dataset, p.error, p.finished_at
       FROM ${schema}.pull_log p
       LEFT JOIN ${schema}.sync_state s ON s.dataset = p.dataset
       WHERE p.status = 'error'
         AND p.error IS NOT NULL AND p.error <> ''
         AND p.error NOT ILIKE 'unresolved:%'
         AND (s.last_ok_at IS NULL OR p.finished_at > s.last_ok_at)
       ORDER BY p.finished_at DESC NULLS LAST
       LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row?.error) return null;
    return {
      dataset: row.dataset,
      error: row.error.slice(0, 280),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    };
  } catch {
    return null;
  }
}

/** Snapshot for Settings / panels — safe to call often; no vendor RPM. */
export async function getResearchOpsReport(): Promise<ResearchOpsReport> {
  const fixHints: string[] = [];
  let localDbOk = true;
  let localDbErr: string | null = null;

  let wrdsSchema = false;
  let lsegSchema = false;
  let wrdsDatasets: DatasetHealth[] = [];
  let lsegDatasets: DatasetHealth[] = [];
  let wrdsLastError: PullError | null = null;
  let lsegLastError: PullError | null = null;

  try {
    await pool.query("SELECT 1");
    wrdsSchema = await schemaExists("wrds_research");
    lsegSchema = await schemaExists("lseg_research");
    if (wrdsSchema) {
      wrdsDatasets = await loadSyncState("wrds_research");
      wrdsLastError = await latestPullError("wrds_research");
    } else fixHints.push("Apply research/wrds/schema.sql (wrds_research missing)");
    if (lsegSchema) {
      lsegDatasets = await loadSyncState("lseg_research");
      lsegLastError = await latestPullError("lseg_research");
    } else fixHints.push("Apply research/lseg/schema.sql (lseg_research missing)");
  } catch (err) {
    localDbOk = false;
    localDbErr = err instanceof Error ? err.message : String(err);
    fixHints.push("Local DATABASE_URL / Postgres is down — app scores and research caches unavailable");
    logger.warn({ err: localDbErr }, "research-ops: local db probe failed");
  }

  const desktopUp = await probeTcp(LSEG_HOST, LSEG_PORT);
  if (!desktopUp) {
    fixHints.push(
      "LSEG Workspace desktop not reachable on 127.0.0.1:9000 — open Workspace + stay logged in before any LSEG sync. App still serves last lseg_research snapshot.",
    );
  }

  if (wrdsDatasets.some((d) => d.status === "warn" || d.status === "down" || d.status === "missing")) {
    fixHints.push(
      "WRDS cache stale/missing — from research/wrds venv: python sync_ibes.py (needs WRDS_USERNAME + network/Duo). App keeps using last IBES rows until then.",
    );
  }
  if (wrdsLastError) {
    fixHints.push(`WRDS last pull error (${wrdsLastError.dataset}): ${wrdsLastError.error}`);
  }
  if (lsegLastError) {
    fixHints.push(`LSEG last pull error (${lsegLastError.dataset}): ${lsegLastError.error}`);
  }

  const wrdsOverall = rollup(wrdsSchema, wrdsDatasets);
  const lsegOverall = rollup(lsegSchema, lsegDatasets, !desktopUp);

  return {
    checkedAt: new Date().toISOString(),
    appImpact: {
      scoresNeedLiveVendor: false,
      scoresUseLocalCache: true,
      note:
        "Fund/options scores read wrds_research (and soft LSEG chips) from local Postgres only. Vendor outages block refreshes, not the running app.",
    },
    localDb: { ok: localDbOk, error: localDbErr },
    wrds: {
      schema: wrdsSchema,
      envHint: "WRDS_USERNAME / WRDS_PASSWORD (or ~/.pgpass) required only for sync scripts — not the API process",
      datasets: wrdsDatasets,
      overall: wrdsOverall,
      lastError: wrdsLastError,
    },
    lseg: {
      schema: lsegSchema,
      desktopProxy: {
        reachable: desktopUp,
        host: LSEG_HOST,
        port: LSEG_PORT,
        hint: desktopUp
          ? null
          : "Start LSEG Workspace (desktop API). Sync scripts cannot auto-launch the GUI.",
      },
      datasets: lsegDatasets,
      overall: lsegOverall,
      lastError: lsegLastError,
    },
    fixHints,
  };
}

/** Last probe result cached for scheduled-tasks UI (updated by scheduler job). */
export let lastResearchOpsReport: ResearchOpsReport | null = null;
export let lastResearchOpsRun: Date | null = null;
export let researchOpsRunning = false;

export async function runResearchOpsHealthJob(): Promise<ResearchOpsReport> {
  if (researchOpsRunning && lastResearchOpsReport) return lastResearchOpsReport;
  researchOpsRunning = true;
  try {
    const report = await getResearchOpsReport();
    lastResearchOpsReport = report;
    lastResearchOpsRun = new Date();
    const bad =
      !report.localDb.ok ||
      report.wrds.overall === "down" ||
      report.lseg.overall === "down" ||
      (!report.lseg.desktopProxy.reachable && report.lseg.schema);
    if (bad) {
      logger.warn(
        {
          wrds: report.wrds.overall,
          lseg: report.lseg.overall,
          desktop: report.lseg.desktopProxy.reachable,
          hints: report.fixHints.slice(0, 3),
        },
        "research-ops: degraded",
      );
    } else {
      logger.info(
        { wrds: report.wrds.overall, lseg: report.lseg.overall, desktop: report.lseg.desktopProxy.reachable },
        "research-ops: healthy",
      );
    }
    return report;
  } finally {
    researchOpsRunning = false;
  }
}
