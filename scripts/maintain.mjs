#!/usr/bin/env node
/**
 * Lean TradeDash maintenance — run periodically (LaunchAgent / cron), NOT forever.
 *
 * Default (safe, no process kills):
 *   node scripts/maintain.mjs
 *     1) one-shot health check (reuses health-check.mjs)
 *     2) rotate/compress oversized logs under /tmp/fildi-logs
 *     3) write status report → /tmp/fildi-logs/maintain-last.json
 *
 * Optional:
 *   node scripts/maintain.mjs --restart-if-unhealthy
 *     restart API (tsx) / Vite only if health failed
 *   node scripts/maintain.mjs --restart-stale-days=7
 *     restart API if process uptime ≥ N days (weekly hygiene)
 *   node scripts/maintain.mjs --enrich-if-due
 *     if enrichment_runs last success > 4 days ago, spawn nightly-enrichment once
 *   node scripts/maintain.mjs --drain-nr[=40]
 *     FactSet referee + merge if factset remaining ≥ max+20 (no free-source re-fetch)
 *
 * Always-on for local Mac preview should stay at TWO node processes:
 *   API :8080 + Vite :8081  (+ Postgres.app). Nothing else.
 */
import { spawnSync, execSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, statSync, renameSync,
  createReadStream, createWriteStream, writeFileSync, readFileSync, unlinkSync,
} from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = "/tmp/fildi-logs";
const REPORT = join(LOG_DIR, "maintain-last.json");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB → gzip + keep .1.gz
const ENRICH_DUE_DAYS = 4;

const args = new Set(process.argv.slice(2));
const restartIfUnhealthy = args.has("--restart-if-unhealthy");
const enrichIfDue = args.has("--enrich-if-due");
const staleArg = [...args].find((a) => a.startsWith("--restart-stale-days="));
const staleDays = staleArg ? Number(staleArg.split("=")[1]) : 0;
const drainArg = [...args].find((a) => a === "--drain-nr" || a.startsWith("--drain-nr="));
const drainNr = drainArg
  ? (drainArg.includes("=") ? Number(drainArg.split("=")[1]) : 40)
  : 0;

function sh(cmd) {
  try {
    const pgBin = `${process.env.HOME}/Applications/Postgres.app/Contents/Versions/16/bin`;
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${pgBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
    }).trim();
  } catch {
    return "";
  }
}

function listenerPid(port) {
  const out = sh(`/usr/sbin/lsof -tiTCP:${port} -sTCP:LISTEN`);
  if (!out) return null;
  return Number(out.split("\n")[0]) || null;
}

function procStartEpoch(pid) {
  if (!pid) return null;
  // macOS: ps -o lstart=
  const lstart = sh(`ps -p ${pid} -o lstart=`);
  if (!lstart) return null;
  const t = Date.parse(lstart);
  return Number.isFinite(t) ? t : null;
}

async function compressLog(path) {
  const gz = `${path}.${Date.now()}.gz`;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(gz));
  unlinkSync(path);
  writeFileSync(path, ""); // keep empty live file for appenders
  return gz;
}

async function rotateLogs() {
  mkdirSync(LOG_DIR, { recursive: true });
  const rotated = [];
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith(".log")) continue;
    const path = join(LOG_DIR, name);
    const st = statSync(path);
    if (st.size < MAX_LOG_BYTES) continue;
    const gz = await compressLog(path);
    rotated.push({ from: name, to: gz, bytes: st.size });
  }
  // prune gzipped logs older than 14 days
  const cutoff = Date.now() - 14 * 86400_000;
  let pruned = 0;
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith(".gz")) continue;
    const path = join(LOG_DIR, name);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      pruned++;
    }
  }
  return { rotated, pruned };
}

function runHealth() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/health-check.mjs"), "--json"], {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
  });
  try {
    return JSON.parse(r.stdout || "{}");
  } catch {
    return { ok: false, parseError: true, stderr: (r.stderr || "").slice(0, 400) };
  }
}

function restartApi() {
  const pid = listenerPid(8080);
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }
  // Parent pnpm/tsx watch usually relaunches; if not, start fresh
  setTimeout(() => {
    if (!listenerPid(8080)) {
      spawnSync("bash", ["-lc", `
        source /tmp/fildi-env-export.sh 2>/dev/null || true
        export PATH="$HOME/Applications/Postgres.app/Contents/Versions/16/bin:/usr/local/bin:$PATH"
        export PORT=8080 NODE_ENV=development
        export DATABASE_URL="\${DATABASE_URL:-postgresql://jamiepark@127.0.0.1:5432/tradedash}"
        cd "${ROOT}/artifacts/api-server" && nohup pnpm run dev:watch >> /tmp/fildi-logs/api.log 2>&1 &
      `], { stdio: "ignore", detached: true });
    }
  }, 2000);
}

function daysSinceEnrichment() {
  // Prefer enrichment_runs; fall back to 99 days (force due).
  const sql = `SELECT EXTRACT(EPOCH FROM (now() - COALESCE((SELECT max(started_at) FROM enrichment_runs WHERE status IN ('success','partial')), now() - interval '99 days')))/86400`;
  const out = sh(`psql "$DATABASE_URL" -tAc "${sql}"`);
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 99;
}

function runApiTsx(scriptRel, extraArgs = []) {
  const envFile = "/tmp/fildi-env-export.sh";
  const cmd = `
    set -a
    [ -f "${envFile}" ] && . "${envFile}"
    [ -f "${ROOT}/.env.local" ] && . "${ROOT}/.env.local"
    set +a
    export PATH="$HOME/Applications/Postgres.app/Contents/Versions/16/bin:/usr/local/bin:$PATH"
    export DATABASE_URL="\${DATABASE_URL:-postgresql://jamiepark@127.0.0.1:5432/tradedash}"
    cd "${ROOT}/artifacts/api-server" && pnpm exec tsx ${scriptRel} ${extraArgs.join(" ")}
  `;
  const r = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 30 * 60 * 1000,
  });
  return {
    status: r.status,
    stdoutTail: (r.stdout || "").slice(-800),
    stderrTail: (r.stderr || "").slice(-400),
  };
}

function runEnrichmentCatchup() {
  return runApiTsx("src/scripts/nightly-enrichment.ts");
}

function factsetRemaining() {
  const out = sh(
    `psql "$DATABASE_URL" -tAc "SELECT daily_limit - calls_today FROM data_sources WHERE name='factset'"`,
  );
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 0;
}

function runDrainNr(max) {
  return runApiTsx("src/scripts/drain-needs-review.ts", [`--max=${max}`]);
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  // Load .env.local into process for psql DATABASE_URL
  const envLocal = join(ROOT, ".env.local");
  if (existsSync(envLocal) && !process.env.DATABASE_URL) {
    for (const raw of readFileSync(envLocal, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      let [k, ...rest] = line.split("=");
      k = k.trim();
      let v = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://jamiepark@127.0.0.1:5432/tradedash";
  }

  const started = Date.now();
  const health = runHealth();
  const logs = await rotateLogs();

  const apiPid = listenerPid(8080);
  const vitePid = listenerPid(8081);
  const apiStart = procStartEpoch(apiPid);
  const apiAgeDays = apiStart != null ? (Date.now() - apiStart) / 86400_000 : null;

  const actions = [];
  if (restartIfUnhealthy && health && health.ok === false) {
    const apiFail = (health.results || []).some((r) => r.name === "api_healthz" && !r.ok);
    if (apiFail) {
      restartApi();
      actions.push("restarted_api_unhealthy");
    }
  }
  if (staleDays > 0 && apiAgeDays != null && apiAgeDays >= staleDays) {
    restartApi();
    actions.push(`restarted_api_stale_${staleDays}d`);
  }

  let enrich = null;
  if (enrichIfDue) {
    const age = daysSinceEnrichment();
    if (age >= ENRICH_DUE_DAYS) {
      enrich = runEnrichmentCatchup();
      actions.push(`enrichment_catchup_age_${age.toFixed(1)}d_exit_${enrich.status}`);
    } else {
      actions.push(`enrichment_ok_age_${age.toFixed(1)}d`);
    }
  }

  let drain = null;
  if (drainNr > 0) {
    const rem = factsetRemaining();
    if (rem >= drainNr + 20) {
      drain = runDrainNr(drainNr);
      actions.push(`drain_nr_${drainNr}_rem_${rem}_exit_${drain.status}`);
    } else {
      actions.push(`drain_nr_skipped_rem_${rem}_need_${drainNr + 20}`);
    }
  }

  const report = {
    ts: new Date().toISOString(),
    ms: Date.now() - started,
    healthOk: !!health.ok,
    healthPass: health.pass ?? null,
    healthFail: health.fail ?? null,
    failedChecks: (health.results || []).filter((r) => !r.ok).map((r) => r.name),
    apiPid,
    vitePid,
    apiAgeDays: apiAgeDays != null ? Number(apiAgeDays.toFixed(2)) : null,
    logs,
    actions,
    enrich,
    drain,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log(`[maintain] ${report.ts}`);
  console.log(`  health: ${report.healthOk ? "OK" : "FAIL"} (${report.healthPass ?? "?"} pass / ${report.healthFail ?? "?"} fail)`);
  if (report.failedChecks.length) console.log(`  failed: ${report.failedChecks.join(", ")}`);
  console.log(`  api pid=${apiPid ?? "—"} age_days=${report.apiAgeDays ?? "—"}  vite pid=${vitePid ?? "—"}`);
  console.log(`  logs rotated=${logs.rotated.length} pruned_gz=${logs.pruned}`);
  if (actions.length) console.log(`  actions: ${actions.join(", ")}`);
  console.log(`  report: ${REPORT}`);

  process.exit(report.healthOk ? 0 : 1);
}

main().catch((e) => {
  console.error("[maintain] fatal", e);
  process.exit(2);
});
