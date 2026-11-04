/**
 * A331 Backtest Lab — spawn Python runner, hash cache, single-flight queue (120 s).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WS = resolve(ROOT, "scripts/watchlist_sync");
const PY = resolve(WS, ".venv/bin/python");
const SCRIPT = resolve(WS, "analysis/backtest_lab.py");
const RUN_CACHE = resolve(process.env.HOME ?? "", ".fildi/cache/backtest_lab/runs");

const DEADLINE_MS = 120_000;

export type BacktestRunParams = {
  preset?: string;
  presetId?: string;
  tickers?: string[];
  start?: string;
  end?: string;
  holdoutUnlocked?: boolean;
};

export type BacktestJobResult = {
  id: string;
  paramHash: string;
  cached: boolean;
  summary: Record<string, unknown>;
  trades: unknown[];
};

let chain: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

function stableHash(params: BacktestRunParams): string {
  const norm = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

async function runPython(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(PY, [SCRIPT, ...args], {
    cwd: WS,
    timeout: DEADLINE_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: resolve(WS, "analysis") },
  });
  return stdout.trim();
}

async function cachePath(hash: string): Promise<string> {
  await mkdir(RUN_CACHE, { recursive: true });
  return resolve(RUN_CACHE, `${hash}.json`);
}

async function readDiskCache(hash: string): Promise<BacktestJobResult | null> {
  try {
    const raw = await readFile(await cachePath(hash), "utf8");
    const parsed = JSON.parse(raw) as BacktestJobResult;
    return parsed.paramHash === hash ? parsed : null;
  } catch {
    return null;
  }
}

async function writeDiskCache(result: BacktestJobResult): Promise<void> {
  await writeFile(await cachePath(result.paramHash), JSON.stringify(result));
}

async function ensureRunsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS watchlist_sync.backtest_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      param_hash text NOT NULL,
      params jsonb NOT NULL,
      summary jsonb NOT NULL,
      trades jsonb,
      created_by text,
      holdout_unlocked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_backtest_runs_param_hash ON watchlist_sync.backtest_runs (param_hash)`);
}

export async function getBacktestCatalog(): Promise<Record<string, unknown>> {
  const out = await runPython(["catalog"]);
  return JSON.parse(out) as Record<string, unknown>;
}

export async function inspectBacktest(
  ticker: string,
  date: string,
  preset = "put_climax_spy_oversold",
): Promise<Record<string, unknown>> {
  const out = await runPython(["inspect", "--ticker", ticker, "--date", date, "--preset", preset]);
  return JSON.parse(out) as Record<string, unknown>;
}

async function persistRun(
  params: BacktestRunParams,
  hash: string,
  summary: Record<string, unknown>,
  trades: unknown[],
  createdBy: string | undefined,
): Promise<string> {
  await ensureRunsTable();
  const { rows } = (await db.execute(sql`
    INSERT INTO watchlist_sync.backtest_runs (param_hash, params, summary, trades, created_by, holdout_unlocked)
    VALUES (${hash}, ${JSON.stringify(params)}::jsonb, ${JSON.stringify(summary)}::jsonb,
            ${JSON.stringify(trades)}::jsonb, ${createdBy ?? null}, ${!!params.holdoutUnlocked})
    RETURNING id::text AS id`)) as { rows?: { id: string }[] };
  return rows?.[0]?.id ?? hash;
}

async function executeRun(params: BacktestRunParams, createdBy?: string): Promise<BacktestJobResult> {
  const hash = stableHash(params);
  const cached = await readDiskCache(hash);
  if (cached) return { ...cached, cached: true };

  const out = await runPython(["run", "--json", JSON.stringify(params)]);
  const parsed = JSON.parse(out) as { summary: Record<string, unknown>; trades: unknown[] };
  const id = await persistRun(params, hash, parsed.summary, parsed.trades, createdBy);
  const result: BacktestJobResult = {
    id,
    paramHash: hash,
    cached: false,
    summary: parsed.summary,
    trades: parsed.trades,
  };
  await writeDiskCache(result);
  return result;
}

/** One job at a time; later callers wait on the same chain. */
export function enqueueBacktestRun(params: BacktestRunParams, createdBy?: string): Promise<BacktestJobResult> {
  queueDepth += 1;
  const job = chain.then(async () => {
    try {
      return await executeRun(params, createdBy);
    } finally {
      queueDepth -= 1;
    }
  });
  chain = job.catch(() => undefined);
  return job;
}

export async function listBacktestRuns(limit = 30): Promise<unknown[]> {
  await ensureRunsTable();
  const { rows } = (await db.execute(sql`
    SELECT id::text AS id, param_hash, params, summary, created_by, holdout_unlocked, created_at
    FROM watchlist_sync.backtest_runs ORDER BY created_at DESC LIMIT ${limit}`)) as {
    rows?: unknown[];
  };
  return rows ?? [];
}

export async function getBacktestRun(id: string, withTrades = false): Promise<unknown | null> {
  await ensureRunsTable();
  const { rows } = (await db.execute(withTrades
    ? sql`SELECT id::text AS id, param_hash, params, summary, trades, created_by, holdout_unlocked, created_at
          FROM watchlist_sync.backtest_runs WHERE id = ${id}::uuid OR param_hash = ${id} LIMIT 1`
    : sql`SELECT id::text AS id, param_hash, params, summary, created_by, holdout_unlocked, created_at
          FROM watchlist_sync.backtest_runs WHERE id = ${id}::uuid OR param_hash = ${id} LIMIT 1`)) as {
    rows?: unknown[];
  };
  return rows?.[0] ?? null;
}

export async function getBacktestRunTrades(id: string): Promise<unknown[]> {
  const row = (await getBacktestRun(id, true)) as { trades?: unknown[] } | null;
  return row?.trades ?? [];
}

export async function storeReady(): Promise<boolean> {
  try {
    await access(resolve(process.env.HOME ?? "", ".fildi/cache/backtest_lab/trades"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function buildStoreIfNeeded(): Promise<void> {
  if (await storeReady()) return;
  logger.info("backtest_lab: building trade/feature store (one-time)");
  await runPython(["build-store"]);
}

export function queueStatus(): { depth: number; deadlineMs: number } {
  return { depth: queueDepth, deadlineMs: DEADLINE_MS };
}

export async function runSelfTest(): Promise<Record<string, unknown>> {
  const out = await runPython(["self-test"]);
  return JSON.parse(out) as Record<string, unknown>;
}

export { stableHash as backtestParamHash };
