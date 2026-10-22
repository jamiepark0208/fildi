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
 *     Daily (bounded, not full-universe):
 *       (a) missing-gold tickers (--max=30)
 *       (b) earnings-window stale (±1/+2d, --max=40)
 *       (c) FactSet drain-nr ≤40 when remaining ≥60 (default with --enrich-if-due)
 *       (d) peer-health-check heal
 *       (e) merge-trusted + fund_score recompute (0 API)
 *       (f) budget / anomaly snapshot → report
 *     Full nightly-enrichment ONLY if last enrichment_runs success ≥ 4 days
 *   node scripts/maintain.mjs --drain-nr[=40]
 *     FactSet referee + merge if factset remaining ≥ max+20 (override / force)
 *   node scripts/maintain.mjs --no-drain-nr
 *     Disable default drain when using --enrich-if-due
 *
 * Sunday (PT) with --enrich-if-due also runs a lean weekly ops digest
 * (`weekly-data-ops-check.mjs --digest-only`) — audit + value-log only, no second FactSet drain —
 * then `ai-workflow-review.mjs` + `--verify` (token/context proof; no silent refactors).
 * Failures (process/enrich hard-fail) fire a macOS notification via osascript.
 *
 * Technicals / options: NOT in this job — ad-hoc on UI click (correct).
 *
 * Always-on for local Mac preview should stay at TWO node processes:
 *   API :8080 + Vite :8081  (+ Postgres.app). Nothing else.
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, statSync, renameSync,
  createReadStream, createWriteStream, writeFileSync, readFileSync, unlinkSync, openSync,
} from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = "/tmp/fildi-logs";
const REPORT = join(LOG_DIR, "maintain-last.json");
const DAY_STATE = join(LOG_DIR, "maintain-day.json");
const LOCK = join(LOG_DIR, "maintain.lock");

/** Resumable research fetches run after production: [name, script (from scripts/watchlist_sync), args, needs LSEG Workspace]. */
const RESEARCH_QUEUE = [
  ["s078_bars5m", "analysis/s078_orb_in_play.py", ["--fetch"], false],
  ["s077_implied_tail", "analysis/s077_implied_tail.py", ["--fetch", "--names=50"], true],
];
/** Agentic plan reviews (Jamie 10-21): scripts/plan-review-queue.py at most every 6 h while awake, detached so the day's
 *  chain and its lock never wait on it. No rows → no reviewer launch ($0). Stamp written before spawn = its own throttle. */
const PLAN_REVIEW_STAMP = join(process.env.HOME || "/tmp", ".fildi/plan-review-last-run");
function maybePlanReviews() {
  try { if (Date.now() - statSync(PLAN_REVIEW_STAMP).mtimeMs < 6 * 3600_000) return; } catch { /* never ran */ }
  try {
    writeFileSync(PLAN_REVIEW_STAMP, new Date().toISOString());
    const out = openSync(join(LOG_DIR, "plan-review.log"), "a");
    spawn("python3", [join(ROOT, "scripts/plan-review-queue.py")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref();
  } catch (e) { console.warn("[maintain] plan reviews not started:", e.message); }
}
function portOpen(port) {
  return spawnSync("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(port)]).status === 0;
}

function etDay(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function etHour(d = new Date()) {
  return Number(d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }));
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
/** Exclusive lock; a lock left by a dead process is taken over. Released on exit. */
function takeLock() {
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    // Alive AND still a maintain run (lock lives in /tmp across reboots; a reused PID must not block the day).
    if (pid && pid !== process.pid && /maintain\.mjs/.test(sh(`ps -p ${pid} -o command=`))) return false;
  } catch { /* no lock */ }
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => { try { if (Number(readFileSync(LOCK, "utf8")) === process.pid) unlinkSync(LOCK); } catch {} });
  return true;
}
/** Model List counts as done for the day only if daily.py built/skipped for a final reason — not "market not open yet". */
function modelListDoneToday(r) {
  if (!r || r.status !== 0) return false;
  const out = r.stdoutTail || "";
  if (/market closed/.test(out)) return etHour() >= 16;   // before the open → retry next slot; after the close → done
  return true;
}
/** Full 7 AM enrich pass — heal-only midday runs must not erase this. */
const REPORT_FULL = join(LOG_DIR, "maintain-full-last.json");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB → gzip + keep .1.gz
const ENRICH_DUE_DAYS = 4;
const DEFAULT_DRAIN_NR = 40;

/** Action markers that prove today’s full pass (UI verifyChecks). */
const FULL_PASS_ACTION_RE =
  /^(retention_prune_exit_|morning_precompute_exit_|enrichment_ok_age_|enrichment_catchup_|enrich_missing_|post_merge_scores_|ops_digest_exit_|ai_workflow_)/;

function isPtSunday(d = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(d);
  return wd === "Sun";
}

/** macOS banner when Maintain hard-fails — closes silent-failure gap for LaunchAgent runs. */
function notifyMac(title, body) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  try {
    execSync(
      `osascript -e 'display notification "${esc(body)}" with title "${esc(title)}"'`,
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    /* headless / denied — ignore */
  }
}

function readPriorReport(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function samePtDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  const fmt = (iso) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  try {
    return fmt(isoA) === fmt(isoB);
  } catch {
    return false;
  }
}

const args = new Set(process.argv.slice(2));
const restartIfUnhealthy = args.has("--restart-if-unhealthy");
const enrichIfDue = args.has("--enrich-if-due");
const noDrainNr = args.has("--no-drain-nr");
const staleArg = [...args].find((a) => a.startsWith("--restart-stale-days="));
const staleDays = staleArg ? Number(staleArg.split("=")[1]) : 0;
const drainArg = [...args].find((a) => a === "--drain-nr" || a.startsWith("--drain-nr="));
let drainNr = drainArg
  ? (drainArg.includes("=") ? Number(drainArg.split("=")[1]) : DEFAULT_DRAIN_NR)
  : 0;
// Daily enrich path includes a bounded FactSet drain unless explicitly disabled.
if (enrichIfDue && !noDrainNr && drainNr === 0) {
  drainNr = DEFAULT_DRAIN_NR;
}

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

function restartStack(reason, { ifDown = false } = {}) {
  // Synchronous: setTimeout-based relaunch never ran — maintain exits before the timer fires.
  // Prefer --if-down when only one process is missing so we don't kill a healthy API.
  const script = join(ROOT, "scripts/dev-restart.sh");
  const args = ifDown ? [script, "--if-down"] : [script];
  const r = spawnSync("bash", args, {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 120_000,
    env: process.env,
  });
  return {
    reason: ifDown ? `${reason}_if_down` : reason,
    status: r.status,
    stdoutTail: (r.stdout || "").slice(-500),
    stderrTail: (r.stderr || "").slice(-400),
  };
}

function processFlags(health) {
  const results = health?.results || [];
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const PROCESS = new Set(["api_healthz", "vite", "postgres"]);
  return {
    processOk: typeof health?.processOk === "boolean"
      ? health.processOk
      : !failed.some((n) => PROCESS.has(n)),
    apiFail: failed.includes("api_healthz"),
    viteFail: failed.includes("vite"),
    pgFail: failed.includes("postgres"),
    processFailed: failed.filter((n) => PROCESS.has(n)),
    vendorFailed: failed.filter((n) => !PROCESS.has(n)),
  };
}

/** Heal local stack: prefer surgical --if-down, retry once, re-check process. */
function healLocalStack(health, actions) {
  const flags = processFlags(health);
  if (flags.processOk) return { health, restart: null, processOk: true };

  let restart = null;
  const bothDown = flags.apiFail && flags.viteFail;
  // Full sweep only when both web processes are down; otherwise keep the healthy one.
  restart = restartStack(
    bothDown ? "unhealthy_both" : flags.apiFail ? "unhealthy_api" : "unhealthy_vite",
    { ifDown: !bothDown },
  );
  actions.push(`restarted_stack_${restart.reason}_exit_${restart.status}`);

  let post = runHealth();
  let postFlags = processFlags(post);
  if (!postFlags.processOk) {
    const retry = restartStack("retry_if_down", { ifDown: true });
    actions.push(`restarted_stack_${retry.reason}_exit_${retry.status}`);
    restart = retry;
    // brief settle — vite sometimes needs a beat after spawn
    spawnSync("sleep", ["2"]);
    post = runHealth();
    postFlags = processFlags(post);
  }
  if (postFlags.processOk) {
    actions.push("process_healed");
  } else {
    actions.push(`process_still_down:${postFlags.processFailed.join("|") || "?"}`);
  }
  return { health: post, restart, processOk: postFlags.processOk };
}

/** @deprecated use restartStack — kept name for action log clarity */
function restartApi() {
  return restartStack("api_or_stack");
}

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
    timeout: 45 * 60 * 1000,
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

function runApiTsx(scriptRel, extraArgs = []) {
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
    timeout: 30 * 60 * 1000,
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

/** Budget / coverage / anomaly snapshot for the maintain report (0 API). */
function budgetSnapshot() {
  // Prefer api_usage (API Monitor SoT). Map data_sources.name → api_usage.source
  // (alpha_vantage ↔ av). Fall back to 0 when no row for CURRENT_DATE.
  const src = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (
      SELECT d.name,
             COALESCE(u.calls_made, 0)::int AS calls_today,
             d.daily_limit,
             (d.daily_limit - COALESCE(u.calls_made, 0))::int AS remaining,
             CASE WHEN d.daily_limit > 0
               THEN ROUND(100.0 * COALESCE(u.calls_made, 0) / d.daily_limit, 1)
               ELSE 0 END AS pct_used
      FROM data_sources d
      LEFT JOIN api_usage u
        ON u.date = CURRENT_DATE
       AND u.source = CASE d.name WHEN 'alpha_vantage' THEN 'av' ELSE d.name END
      ORDER BY d.name
    ) t
  "`);
  const nr = sh(`psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM field_provenance WHERE divergent"`);
  const gold = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*) FILTER (WHERE tf.fundamentals_last_fetched IS NOT NULL)::int || '/' ||
           COUNT(*)::int
    FROM ticker_registry r
    LEFT JOIN ticker_fundamentals tf ON tf.ticker = r.ticker
    WHERE r.fetch_fundamentals = true
  "`);
  // Field-fill coverage across core gold columns (true “current state” %, not just row existence)
  const fieldFill = sh(`psql "$DATABASE_URL" -tAc "
    WITH u AS (
      SELECT tf.* FROM ticker_fundamentals tf
      JOIN ticker_registry r ON r.ticker = tf.ticker AND r.fetch_fundamentals
    ),
    c AS (
      SELECT
        COUNT(*)::float AS n,
        (
          COUNT(pe_ratio)+COUNT(peg_ratio)+COUNT(forward_pe)+COUNT(price_to_book)+COUNT(price_to_sales)
          +COUNT(ev_ebitda)+COUNT(gross_margin)+COUNT(operating_margin)+COUNT(net_margin)
          +COUNT(return_on_equity)+COUNT(roic)+COUNT(revenue_growth_yoy)+COUNT(eps_growth)
          +COUNT(current_ratio)+COUNT(debt_to_equity)+COUNT(free_cash_flow)+COUNT(net_income)
          +COUNT(total_revenue)+COUNT(ebitda)+COUNT(cash_and_equivalents)+COUNT(total_debt)
          +COUNT(gross_profit)+COUNT(total_assets)+COUNT(annual_operating_cash_flow)
        )::float AS filled,
        24::float AS cols
      FROM u
    )
    SELECT ROUND((100.0 * filled / NULLIF(n * cols, 0))::numeric, 1) FROM c
  "`);
  // Active universe only: fetch_fundamentals + not ETF exclusion. Dead/acquired
  // (fetch=false) and ETFs stay NULL scores by design — don't anomaly them.
  const scored = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*) FILTER (WHERE tf.fund_total_score IS NOT NULL)::int
           || '/' || COUNT(*)::int
    FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker
    WHERE r.fetch_fundamentals = true
      AND UPPER(tf.ticker) NOT IN (
        'SMH','SOXX','IWM','QQQ','SPY','ARKG','CANE','BIZD','JBBB',
        'NVDY','SPCK','PSUS','HOOY','DRAM','ARKQ','XOP','GOOY','RVI'
      )
  "`);
  const unscoredActive = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*)::int
    FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker
    WHERE r.fetch_fundamentals = true
      AND tf.fund_total_score IS NULL
      AND UPPER(tf.ticker) NOT IN (
        'SMH','SOXX','IWM','QQQ','SPY','ARKG','CANE','BIZD','JBBB',
        'NVDY','SPCK','PSUS','HOOY','DRAM','ARKQ','XOP','GOOY','RVI'
      )
  "`);
  // Blended fair value health (lib/fair-value-snapshots.ts; refreshed by post-merge-scores above).
  // withValue|universe|extremes(>3x or <1/3)|jumps(>30% move with <5% price move)|ageHours|prevWithValue
  const fairValue = sh(`psql "$DATABASE_URL" -tAc "
    WITH t AS (SELECT max(as_of) d FROM fair_value_snapshots),
         p AS (SELECT max(as_of) d FROM fair_value_snapshots WHERE as_of < (SELECT d FROM t)),
         cur AS (SELECT * FROM fair_value_snapshots WHERE as_of = (SELECT d FROM t)),
         prev AS (SELECT * FROM fair_value_snapshots WHERE as_of = (SELECT d FROM p))
    SELECT COUNT(*) FILTER (WHERE c.fair_value IS NOT NULL) || '|' || COUNT(*) || '|' ||
           COUNT(*) FILTER (WHERE c.fair_value > 3 * c.price OR c.fair_value < c.price / 3) || '|' ||
           COUNT(*) FILTER (WHERE pv.fair_value > 0 AND c.fair_value > 0 AND pv.price > 0 AND c.price > 0
                              AND abs(ln(c.fair_value / pv.fair_value)) > ln(1.3) AND abs(ln(c.price / pv.price)) < ln(1.05)) || '|' ||
           COALESCE(round(extract(epoch FROM now() - max(c.computed_at)) / 3600), 9999) || '|' ||
           (SELECT COUNT(*) FILTER (WHERE fair_value IS NOT NULL) FROM prev)
    FROM cur c LEFT JOIN prev pv USING (ticker)
  " 2>/dev/null`);
  const earnWin = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(DISTINCT UPPER(ticker))
    FROM earnings_calendar
    WHERE report_date BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 2
  "`);
  let sources = [];
  try {
    sources = JSON.parse(src || "[]");
  } catch {
    sources = [];
  }
  const anomalies = [];
  for (const s of sources) {
    if (Number(s.pct_used) >= 90) anomalies.push(`${s.name}_budget_≥90%`);
    if (s.name === "factset" && Number(s.remaining) < 20) anomalies.push("factset_remaining_<20");
  }
  const nrN = Number(String(nr).trim());
  if (Number.isFinite(nrN) && nrN > 500) anomalies.push(`needs_review_${nrN}`);
  const unscoredN = Number(String(unscoredActive).trim());
  // Soft ceiling: coverage/safety gates are intentional; rising counts = enrich gap.
  if (Number.isFinite(unscoredN) && unscoredN > 8) anomalies.push(`unscored_active_${unscoredN}`);
  // Baseline 2026-10-06: 436/568 valued, 17 extremes, 0 jumps. Thresholds catch data breaks, not market moves.
  const [fvWith, fvN, fvExt, fvJumps, fvAge, fvPrev] = String(fairValue || "").trim().split("|").map(Number);
  if (Number.isFinite(fvWith)) {
    if (fvAge > 36) anomalies.push(`fair_value_stale_${fvAge}h`);
    if (fvExt > 30) anomalies.push(`fair_value_extremes_${fvExt}`);
    if (fvJumps > 10) anomalies.push(`fair_value_jumps_${fvJumps}`);
    if (fvPrev > 0 && fvWith < fvPrev * 0.9) anomalies.push(`fair_value_coverage_drop_${fvPrev}_to_${fvWith}`);
  } else {
    anomalies.push("fair_value_missing");
  }
  return {
    sources,
    needsReview: Number.isFinite(nrN) ? nrN : null,
    goldCoverage: String(gold).trim() || null,
    fieldFillPct: Number(String(fieldFill).trim()) || null,
    fundScoreCoverage: String(scored).trim() || null,
    unscoredActive: Number.isFinite(unscoredN) ? unscoredN : null,
    fairValue: Number.isFinite(fvWith) ? `${fvWith}/${fvN} ext=${fvExt} jumps=${fvJumps}` : null,
    earningsWindowTickers: Number(String(earnWin).trim()) || 0,
    anomalies,
  };
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  // 10-21: the 07:00 run spent 75 min in seconds-long dark wakes (lid closed / idle sleep) → killed steps, DNS failures, a
  // Model List at 08:19. Hold a no-idle-sleep (+ no-sleep on AC) assertion for as long as this process lives.
  try { spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { detached: true, stdio: "ignore" }).unref(); } catch {}
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

  if (args.has("--once-per-day")) { mkdirSync(LOG_DIR, { recursive: true }); maybePlanReviews(); }

  // 10-21 run-on-wake queue: launchd fires every 30 min while the Mac is awake; the chain runs until it completes once per
  // ET day (max 3 attempts), never two at a time. Jamie is on battery at school → the 07:00 slot alone is unreliable.
  // 10-21 drill: the ET day starts at 21:00 PT → an evening wake ran tomorrow's chain on tonight's data and burned all
  // 3 attempts waiting for the open. Day starts 08:00 ET (05:00 PT); a pre-open wait refunds its attempt; once the data
  // steps pass (dataDone) later fires run only the Model List.
  let dataDoneToday = false;
  if (args.has("--once-per-day")) {
    const day = etDay();
    const st = readJson(DAY_STATE) || {};
    if (etHour() < 8) { console.log(`[maintain] ${day}: before 08:00 ET — the day's chain starts at 05:00 PT`); return; }
    if (st.day === day && st.done) { console.log(`[maintain] ${day}: chain already complete — skip`); return; }
    if (st.day === day && (st.attempts || 0) >= 3) { console.log(`[maintain] ${day}: 3 attempts used — skip until tomorrow`); return; }
    if (!takeLock()) { console.log("[maintain] another run holds the lock — skip"); return; }
    dataDoneToday = st.day === day && !!st.dataDone;
    writeFileSync(DAY_STATE, JSON.stringify({ day, attempts: (st.day === day ? st.attempts || 0 : 0) + 1, done: false, dataDone: dataDoneToday }));
  }

  const started = Date.now();
  let health = runHealth();
  const logs = await rotateLogs();

  const apiPidBefore = listenerPid(8080);
  const vitePidBefore = listenerPid(8081);
  const apiStart = procStartEpoch(apiPidBefore);
  const apiAgeDays = apiStart != null ? (Date.now() - apiStart) / 86400_000 : null;

  const actions = [];
  let restart = null;

  // Prefer heal (adopt pidfiles / kill drift) over full restart when ports are up.
  const healOut = sh(`node "${join(ROOT, "scripts/local-stack.mjs")}" heal --json`);
  let healJson = null;
  try {
    healJson = JSON.parse(healOut || "{}");
  } catch {
    healJson = null;
  }
  if (healJson?.actions?.length) {
    actions.push(`healed:${healJson.actions.join("|")}`);
  }

  // Auto-fix local stack (api/vite). Vendor API failures are reported but not fatal —
  // overnight network blips used to mark the whole job "Failed" even when Postgres+API were fine.
  if (restartIfUnhealthy) {
    const flags = processFlags(health);
    if (!flags.processOk || healJson?.needsRestart) {
      const healed = healLocalStack(health, actions);
      health = healed.health;
      restart = healed.restart;
    }
  }
  if (staleDays > 0 && apiAgeDays != null && apiAgeDays >= staleDays) {
    restart = restartStack(`stale_${staleDays}d`, { ifDown: false });
    actions.push(`restarted_stack_${restart.reason}_exit_${restart.status}`);
    health = runHealth();
  }

  const apiPid = listenerPid(8080);
  const vitePid = listenerPid(8081);
  const finalFlags = processFlags(health);

  const resetNames = resetDataSourceCountersIfNeeded();
  if (resetNames.length) {
    actions.push(`data_sources_reset:${resetNames.join("|")}`);
  }

  let enrich = null;
  let enrichMissing = null;
  let enrichUnscored = null;
  let enrichEarnings = null;
  let modelList = null;
  const timings = {}; // per-step ms (10-20: the chain had no durations, so ordering costs were invisible)
  let peerHealth = null;
  let postMerge = null;

  /** Enrich scripts print JSON; skipped:true ⇒ no enrichAndMerge (no merge). */
  function ranEnrichMerge(r) {
    if (!r || r.status !== 0) return false;
    const t = r.stdoutTail || "";
    if (/["']skipped["']\s*:\s*true/.test(t)) return false;
    return true;
  }

  // Field-fill snapshot before any enrich writes — used for Pipeline Health before→after.
  const fieldFillPctBefore = enrichIfDue ? (budgetSnapshot().fieldFillPct ?? null) : null;

  // A236: Mac opens late (≥10:00 ET, no dataDone yet) → list-first (stale prices + earnings), then heavy work.
  // Normal 05:00–09:xx path unchanged (full data → list at 10:00 ET).
  const lateOpenListFirst = args.has("--once-per-day") && etHour() >= 10 && !dataDoneToday;
  if (lateOpenListFirst) actions.push("late_open_list_first");

  /** Heavy enrich/score work — skipped before the list on late-open; runs after the list instead. */
  function runHeavyDataBeforeList() {
    enrichMissing = runApiTsx("src/scripts/enrich-missing-fundamentals.ts", ["--max=30"]);
    actions.push(`enrich_missing_exit_${enrichMissing.status}`);

    enrichUnscored = runApiTsx("src/scripts/enrich-unscored-fundamentals.ts", ["--max=20"]);
    actions.push(`enrich_unscored_exit_${enrichUnscored.status}`);

    const breadth = runApiTsx("src/scripts/backfill-market-breadth.ts", ["--days=5"]);
    actions.push(`backfill_market_breadth_exit_${breadth.status ?? breadth.signal ?? "spawn_error"}`);

    const age = daysSinceEnrichment();
    if (age >= ENRICH_DUE_DAYS) {
      enrich = runEnrichmentCatchup();
      actions.push(`enrichment_catchup_age_${age.toFixed(1)}d_exit_${enrich.status}`);
    } else {
      actions.push(`enrichment_ok_age_${age.toFixed(1)}d`);
    }
  }

  function runListCriticalData() {
    // Daily bars for every active name missing the last session (Schwab → Yahoo → LSEG); exit 2 = coverage < 95%.
    const stalePrices = runApiTsx("src/scripts/backfill-stale-prices.ts");
    actions.push(`backfill_stale_prices_exit_${stalePrices.status ?? stalePrices.signal ?? "spawn_error"}`);

    // Earnings-window stale refresh (bounded) — Model List earnings re-strike reads this.
    enrichEarnings = runApiTsx("src/scripts/enrich-earnings-window.ts", ["--max=40"]);
    actions.push(`enrich_earnings_exit_${enrichEarnings.status}`);
  }

  function runScoresAndPrecompute(drainMerged) {
    peerHealth = runApiTsx("src/scripts/peer-health-check.ts");
    actions.push(`peer_health_exit_${peerHealth.status}`);

    const upstreamMerged =
      drainMerged ||
      ranEnrichMerge(enrichMissing) ||
      ranEnrichMerge(enrichUnscored) ||
      ranEnrichMerge(enrichEarnings) ||
      (enrich != null && enrich.status === 0);
    postMerge = runApiTsx("src/scripts/post-merge-scores.ts", ["--scores-only"]);
    actions.push(
      `post_merge_scores_exit_${postMerge.status}_scores_only` +
        (upstreamMerged ? "" : "_no_upstream_write"),
    );

    if (finalFlags.processOk) {
      const pre = runApiTsx("src/scripts/run-morning-precompute.ts");
      timings.morningPrecompute = pre.ms;
      actions.push(`morning_precompute_exit_${pre.status}`);
    } else {
      actions.push("morning_precompute_skipped_process_down");
    }
  }

  if (enrichIfDue && !dataDoneToday) {
    runListCriticalData();
    if (!lateOpenListFirst) runHeavyDataBeforeList();
  }

  let drain = null;
  let drainMerged = false;
  if (drainNr > 0 && !dataDoneToday && !lateOpenListFirst) {
    const rem = factsetRemaining();
    if (rem >= drainNr + 20) {
      drain = runDrainNr(drainNr);
      actions.push(`drain_nr_${drainNr}_rem_${rem}_exit_${drain.status}`);
      drainMerged = drain.status === 0;
    } else {
      actions.push(`drain_nr_skipped_rem_${rem}_need_${drainNr + 20}`);
    }
  }

  if (enrichIfDue) {
    if (!dataDoneToday && !lateOpenListFirst) {
      // Normal path: scores + precompute before the list (earnings history / street PT for re-strike).
      runScoresAndPrecompute(drainMerged);
    }

    // (f) Model List daily (user 2026-10-11): LSEG sync → fit model → plan → verify (Schwab live quotes unless the
    //      Robinhood export session already fetched RH quotes) → publish + grade + reflection. --if-needed = trading days
    //      only, once per ET day. Its failure is reported on its own, never as a stack failure.
    //      Not before 10:00 ET: opening-half-hour spreads fail L2. Late-open (A236) builds the list on yesterday's
    //      scores + fresh prices/earnings, then catches up heavy data below.
    modelList = etHour() >= 10 ? runModelListDaily()
      : { status: 0, stdoutTail: "skip: market closed — the list builds at 10:00 ET (opening spreads)", ms: 0 };
    timings.modelList = modelList.ms;
    actions.push(`model_list_exit_${modelList.status}`);
    if (modelList.status !== 0) {
      notifyMac("Fildi Model List not updated", (modelList.stdoutTail || modelList.stderrTail || "see maintain-last.json").slice(-180));
    }

    // Late-open catch-up: everything deferred so the list published first.
    if (lateOpenListFirst && enrichIfDue) {
      runHeavyDataBeforeList();
      if (drainNr > 0) {
        const rem = factsetRemaining();
        if (rem >= drainNr + 20) {
          drain = runDrainNr(drainNr);
          actions.push(`drain_nr_${drainNr}_rem_${rem}_exit_${drain.status}`);
          drainMerged = drain.status === 0;
        } else {
          actions.push(`drain_nr_skipped_rem_${rem}_need_${drainNr + 20}`);
        }
      }
      runScoresAndPrecompute(drainMerged);
    }

    // Retention prune lives here too so it runs when API was down all day.
    // Covers api_usage / ai_usage_log / old intraday app_config + filesystem logs.
    const retention = runApiTsx("src/scripts/run-retention-prune.ts");
    actions.push(`retention_prune_exit_${retention.status}`);

    // (h) Option history (was its own 03:00 LaunchAgent; nothing in the Model List reads it → after the list). Own lock + once/day.
    const oh = readJson(join(LOG_DIR, "option-history-last.json"));
    if (!(oh?.ok && String(oh.ts || "").slice(0, 10) === new Date().toLocaleDateString("en-CA"))) {
      const t0 = Date.now();
      const dir = join(ROOT, "scripts/watchlist_sync");
      const r = spawnSync(join(dir, ".venv/bin/python"), ["analysis/option_history.py"], { encoding: "utf8", cwd: dir, timeout: 120 * 60 * 1000 });
      timings.optionHistory = Date.now() - t0;
      actions.push(`option_history_exit_${r.status ?? r.signal ?? "spawn_error"}`);
    }

    // (i) Research backfill queue — last, resumable, time-capped; each job keeps its own budget guards (LSEG research 80 %
    //     of the day/month, Polygon shared 5/min gate), so production above always ran first and keeps its reserve.
    //     Only after today's list is final: a pre-open skip also exits 0 and must not hold the lock past 06:30 PT.
    if (args.has("--research") && modelListDoneToday(modelList)) {
      for (const [name, rel, extra, needsLseg] of RESEARCH_QUEUE) {
        if (needsLseg && !portOpen(9000)) { actions.push(`research_${name}_skipped_no_lseg`); continue; }
        const t0 = Date.now();
        const dir = join(ROOT, "scripts/watchlist_sync");
        const py = needsLseg ? join(ROOT, "research/lseg/.venv/bin/python") : join(dir, ".venv/bin/python");
        const r = spawnSync(py, [rel, ...extra], { encoding: "utf8", cwd: dir, timeout: 45 * 60 * 1000 });
        timings[`research_${name}`] = Date.now() - t0;
        actions.push(`research_${name}_exit_${r.status ?? r.signal ?? "spawn_error"}`);
      }
    }

    // Sunday lean digest: scoreboard → value-log only (no second drain/peer).
    if (isPtSunday()) {
      const dig = spawnSync(
        process.execPath,
        [join(ROOT, "scripts/weekly-data-ops-check.mjs"), "--digest-only"],
        { encoding: "utf8", cwd: ROOT, timeout: 10 * 60 * 1000, env: process.env },
      );
      actions.push(`ops_digest_exit_${dig.status ?? 1}`);
      if (dig.status !== 0) {
        console.warn("[maintain] ops digest warn:", (dig.stderr || dig.stdout || "").slice(-400));
      }
      // Mac resource audit (Jamie 10-16): disk/RAM/iCloud/growth snapshot + trim fildi logs (30 d / 50 MB).
      const ra = spawnSync("python3", [join(ROOT, "scripts/resource-audit.py"), "--prune"], {
        encoding: "utf8",
        cwd: ROOT,
        timeout: 10 * 60 * 1000,
        env: process.env,
      });
      actions.push(`resource_audit_exit_${ra.status ?? 1}`);
      // Optimization measurement (deterministic) — report then prove; never auto-refactor.
      const reviewScript = join(ROOT, ".cursor/scripts/ai-workflow-review.mjs");
      if (existsSync(reviewScript)) {
        const rev = spawnSync(process.execPath, [reviewScript], {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 5 * 60 * 1000,
          env: process.env,
        });
        actions.push(`ai_workflow_review_exit_${rev.status ?? 1}`);
        const ver = spawnSync(process.execPath, [reviewScript, "--verify"], {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 2 * 60 * 1000,
          env: process.env,
        });
        actions.push(`ai_workflow_verify_exit_${ver.status ?? 1}`);
        if (ver.status !== 0) {
          console.warn(
            "[maintain] ai-workflow-review --verify warn:",
            (ver.stderr || ver.stdout || "").slice(-400),
          );
        }
      } else {
        actions.push("ai_workflow_review_skipped_missing");
      }
    }
  }

  // (f) Budget / anomaly snapshot — always when enriching, else light.
  const budget = budgetSnapshot();
  if (fieldFillPctBefore != null) {
    budget.fieldFillPctBefore = fieldFillPctBefore;
  }
  if (budget.anomalies.length) {
    actions.push(`anomalies:${budget.anomalies.join("|")}`);
  }

  const enrichResults = [
    ["enrich_missing", enrichMissing],
    ["enrich_unscored", enrichUnscored],
    ["enrich_earnings", enrichEarnings],
    ["enrichment_catchup", enrich],
    ["peer_health", peerHealth],
    ["post_merge", postMerge],
  ];
  const enrichSoftWarns = [];
  for (const [name, r] of enrichResults) {
    if (!r || r.status === 0) continue;
    if (isTransientEnrichResult(r)) {
      enrichSoftWarns.push(name);
      actions.push(`enrich_soft_warn:${name}`);
      console.warn(
        `[maintain] soft enrich warn ${name} (DNS/network/timeout) — not hard-fail`,
        (r.stderrTail || r.stdoutTail || "").slice(-200),
      );
    }
  }
  const enrichFail = enrichResults.some(([, r]) => isHardEnrichFail(r));

  // UI / LaunchAgent "ok": local stack healthy after heal attempts.
  // Transient vendor DNS/timeouts → soft warn only (no macOS FAILED banner / exit 1).
  const jobOk = finalFlags.processOk && !enrichFail;
  const failureClass = !finalFlags.processOk
    ? "process"
    : enrichFail
      ? "enrich"
      : enrichSoftWarns.length || finalFlags.vendorFailed.length
        ? "vendor"
        : null;

  const mode = enrichIfDue ? "full" : "heal";
  let mergedActions = [...actions];
  // Heal-only must not wipe today’s full-pass proof (retention / morning precompute).
  if (!enrichIfDue) {
    const priorFull = readPriorReport(REPORT_FULL) || readPriorReport(REPORT);
    const priorTs = typeof priorFull?.ts === "string" ? priorFull.ts : null;
    const priorActions = Array.isArray(priorFull?.actions) ? priorFull.actions : [];
    if (priorTs && samePtDay(priorTs, new Date().toISOString())) {
      const keep = priorActions.filter((a) => typeof a === "string" && FULL_PASS_ACTION_RE.test(a));
      for (const a of keep) {
        if (!mergedActions.includes(a)) mergedActions.push(a);
      }
    }
  }

  const report = {
    ts: new Date().toISOString(),
    mode,
    ms: Date.now() - started,
    timings,
    healthOk: !!health.ok,
    processOk: finalFlags.processOk,
    vendorsOk: finalFlags.vendorFailed.length === 0,
    ok: jobOk,
    failureClass,
    healthPass: health.pass ?? null,
    healthFail: health.fail ?? null,
    failedChecks: (health.results || []).filter((r) => !r.ok).map((r) => r.name),
    processFailed: finalFlags.processFailed,
    vendorFailed: finalFlags.vendorFailed,
    enrichSoftWarns,
    apiPid,
    vitePid,
    apiAgeDays: apiAgeDays != null ? Number(apiAgeDays.toFixed(2)) : null,
    logs,
    actions: mergedActions,
    enrich,
    enrichMissing,
    enrichUnscored,
    enrichEarnings,
    modelList,
    drain,
    peerHealth,
    postMerge,
    budget,
    restart,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  if (args.has("--once-per-day") && enrichIfDue) {
    // Data steps the Model List reads; a failed one (killed in a dark wake, exit 1/2) is retried next fire, not "done".
    const dataFailed = actions.filter((a) =>
      /^(backfill_stale_prices|backfill_market_breadth|enrich_earnings|post_merge_scores|morning_precompute)_exit_(?!0(_|$))/.test(a));
    const st = readJson(DAY_STATE) || {};
    const dataDone = dataDoneToday || dataFailed.length === 0;
    const waitingForOpen = modelList?.status === 0 && !modelListDoneToday(modelList);
    writeFileSync(DAY_STATE, JSON.stringify({
      ...st,
      day: etDay(),
      dataDone,
      dataFailed,
      done: dataDone && modelListDoneToday(modelList),
      // waiting ≠ failing — refund even when a data step failed (10-22: stale-prices exit 2 burned all 3 pre-open → no list; A243)
      attempts: waitingForOpen ? Math.max(0, (st.attempts || 1) - 1) : st.attempts,
      finishedAt: new Date().toISOString(),
    }));
  }

  // Heal-cadence proof sibling (Nucleus / Ops) — same vocabulary as data-ops value log.
  if (!enrichIfDue) {
    const rem = {
      at: report.ts,
      trigger: "heal-cadence",
      taskIds: ["maintain"],
      alertsBefore: -1,
      alertsAfter: -1,
      alertDelta: null,
      value: actions.includes("process_healed")
        ? "IMPROVED"
        : jobOk
          ? "NO MATERIAL CHANGE"
          : "FAILED",
      ok: jobOk,
      actions: mergedActions.slice(0, 12),
      note: "Written by maintain.mjs heal path — see maintain-last.json for stack detail.",
    };
    writeFileSync(join(LOG_DIR, "ops-remediate-last.json"), JSON.stringify(rem, null, 2) + "\n");
  }

  // Pipeline Health (enrichment_runs) — daily maintain is the scheduled enrich path on Mac.
  if (enrichIfDue) {
    const rec = runApiTsx("src/scripts/record-maintain-run.ts", [`--report=${REPORT}`]);
    mergedActions.push(`record_maintain_run_exit_${rec.status}`);
    report.actions = mergedActions;
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    writeFileSync(REPORT_FULL, JSON.stringify(report, null, 2));
  }

  console.log(`[maintain] ${report.ts}`);
  console.log(
    `  job: ${jobOk ? "OK" : "FAIL"}  process=${finalFlags.processOk ? "OK" : "FAIL"}  vendors=${finalFlags.vendorFailed.length === 0 ? "OK" : "WARN"}`,
  );
  console.log(`  health: ${report.healthOk ? "OK" : "DEGRADED"} (${report.healthPass ?? "?"} pass / ${report.healthFail ?? "?"} fail)`);
  if (report.processFailed?.length) console.log(`  process failed: ${report.processFailed.join(", ")}`);
  if (report.vendorFailed?.length) console.log(`  vendor warn: ${report.vendorFailed.join(", ")}`);
  if (enrichSoftWarns.length) console.log(`  enrich soft: ${enrichSoftWarns.join(", ")}`);
  console.log(`  api pid=${apiPid ?? "—"} age_days=${report.apiAgeDays ?? "—"}  vite pid=${vitePid ?? "—"}`);
  console.log(`  logs rotated=${logs.rotated.length} pruned_gz=${logs.pruned}`);
  if (budget.goldCoverage) {
    console.log(
      `  gold=${budget.goldCoverage} fieldFill=${budget.fieldFillPct ?? "—"}% scores=${budget.fundScoreCoverage} unscoredActive=${budget.unscoredActive ?? "—"} NR=${budget.needsReview} earnWin=${budget.earningsWindowTickers} fairValue=${budget.fairValue ?? "—"}`,
    );
  }
  if (budget.anomalies.length) console.log(`  anomalies: ${budget.anomalies.join(", ")}`);
  if (actions.length) console.log(`  actions: ${actions.join(", ")}`);
  console.log(`  report: ${REPORT}`);

  if (!jobOk) {
    const why =
      failureClass === "process"
        ? `Stack down: ${(finalFlags.processFailed || []).join(", ") || "api/vite/postgres"}`
        : failureClass === "enrich"
          ? "Enrich/peer/scores step failed — see maintain-last.json"
          : "Maintain failed — open Settings → Scheduled Tasks";
    notifyMac("Fildi Maintain FAILED", why);
  }

  process.exit(jobOk ? 0 : 1);
}

main().catch((e) => {
  console.error("[maintain] fatal", e);
  notifyMac("Fildi Maintain FATAL", String(e?.message || e).slice(0, 180));
  process.exit(2);
});
