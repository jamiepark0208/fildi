import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./constants.mjs";
import { sh } from "./utils.mjs";

function daysSinceEnrichment() {
  // Prefer enrichment_runs; fall back to 99 days (force due).
  const sql = `SELECT EXTRACT(EPOCH FROM (now() - COALESCE((SELECT max(started_at) FROM enrichment_runs WHERE status IN ('success','partial')), now() - interval '99 days')))/86400`;
  const out = sh(`psql "$DATABASE_URL" -tAc "${sql}"`);
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 99;
}

/** scripts/watchlist_sync/daily.py --if-needed (own Python venv; loads .env.local itself). */
function runModelListDaily() {
  const t0 = Date.now();
  const dir = join(ROOT, "scripts/watchlist_sync");
  const r = spawnSync(join(dir, ".venv/bin/python"), ["daily.py", "--if-needed"], {
    encoding: "utf8",
    cwd: dir,
    // Hang guard only: steps carry their own 30-min limit and a killed run resumes at its unfinished step (11-03).
    timeout: 120 * 60 * 1000,
  });
  return {
    status: r.status,
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message || r.error) : null,
    stdoutTail: (r.stdout || "").slice(-800),
    stderrTail: (r.stderr || "").slice(-400),
    ms: Date.now() - t0,
  };
}

function runApiTsx(scriptRel, extraArgs = [], timeoutMin = 30) {
  const t0 = Date.now();
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
    timeout: timeoutMin * 60 * 1000,
  });
  return {
    status: r.status,
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message || r.error) : null,
    stdoutTail: (r.stdout || "").slice(-800),
    stderrTail: (r.stderr || "").slice(-400),
    ms: Date.now() - t0,
  };
}

/** Transient DNS/network (or null exit from killed/timeout child) — warn, don't hard-fail Maintain. */
const TRANSIENT_NET_RE =
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed|getaddrinfo/i;

function isTransientEnrichResult(r) {
  if (!r) return false;
  const blob = `${r.stdoutTail || ""}\n${r.stderrTail || ""}\n${r.error || ""}`;
  if (TRANSIENT_NET_RE.test(blob)) return true;
  // spawnSync timeout/signal → status null
  if (
    r.status == null &&
    (r.signal || /timed out|SIGTERM|SIGKILL/i.test(blob + String(r.signal || "")))
  ) {
    return true;
  }
  // null exit + vendor fetch noise already covered; bare null with empty tails stays hard
  return false;
}

/** Hard enrich fail = non-zero exit that is NOT a clear vendor DNS/network blip. */
function isHardEnrichFail(r) {
  if (!r) return false;
  if (r.status === 0) return false;
  if (isTransientEnrichResult(r)) return false;
  return r.status !== 0; // includes null when not classified transient
}

function runEnrichmentCatchup() {
  // Trigger label for Pipeline Health: maintain-driven full catch-up (not ad-hoc manual).
  return runApiTsx("src/scripts/nightly-enrichment.ts", ["--trigger=maintain_full"]);
}

/**
 * data_sources.calls_today only resets inside nightly-enrichment / SDM paths.
 * With DISABLE_SCHEDULER_ENRICHMENT + sparse full enrich, those counters rot for days
 * (seen: FactSet stuck at 463 from 2026-09-28 while api_usage correctly showed 0 today).
 * Maintain must reset before drain / budget decisions.
 */
function resetDataSourceCountersIfNeeded() {
  const out = sh(`psql "$DATABASE_URL" -tAc "
    UPDATE data_sources
    SET calls_today = 0,
        last_reset_date = to_char(CURRENT_DATE, 'YYYY-MM-DD')
    WHERE last_reset_date IS DISTINCT FROM to_char(CURRENT_DATE, 'YYYY-MM-DD')
    RETURNING name
  "`);
  return String(out || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Remaining FactSet budget — api_usage is SoT (same as Settings API Monitor). */
function factsetRemaining() {
  const out = sh(
    `psql "$DATABASE_URL" -tAc "
      SELECT d.daily_limit - COALESCE(u.calls_made, 0)
      FROM data_sources d
      LEFT JOIN api_usage u
        ON u.source = 'factset' AND u.date = CURRENT_DATE
      WHERE d.name = 'factset'
    "`,
  );
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 0;
}

function runDrainNr(max) {
  return runApiTsx("src/scripts/drain-needs-review.ts", [`--max=${max}`]);
}

export {
  daysSinceEnrichment, runModelListDaily, runApiTsx, TRANSIENT_NET_RE,
  isTransientEnrichResult, isHardEnrichFail, runEnrichmentCatchup,
  resetDataSourceCountersIfNeeded, factsetRemaining, runDrainNr,
};
