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
 * Technicals / options: NOT in this job — ad-hoc on UI click (correct).
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
const DEFAULT_DRAIN_NR = 40;

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
  return {
    sources,
    needsReview: Number.isFinite(nrN) ? nrN : null,
    goldCoverage: String(gold).trim() || null,
    fieldFillPct: Number(String(fieldFill).trim()) || null,
    fundScoreCoverage: String(scored).trim() || null,
    unscoredActive: Number.isFinite(unscoredN) ? unscoredN : null,
    earningsWindowTickers: Number(String(earnWin).trim()) || 0,
    anomalies,
  };
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

  if (enrichIfDue) {
    // (a) New watchlist / registry adds — don't wait for 4d full run.
    enrichMissing = runApiTsx("src/scripts/enrich-missing-fundamentals.ts", ["--max=30"]);
    actions.push(`enrich_missing_exit_${enrichMissing.status}`);

    // (a2) Active names with null fund_total_score — free sources only, shrink coverage/safety gaps.
    enrichUnscored = runApiTsx("src/scripts/enrich-unscored-fundamentals.ts", ["--max=20"]);
    actions.push(`enrich_unscored_exit_${enrichUnscored.status}`);

    // (a3) Stale prices_historical — technicals used to skip Yahoo once ≥200 bars (A12).
    const stalePrices = runApiTsx("src/scripts/backfill-stale-prices.ts", ["--max=120"]);
    actions.push(`backfill_stale_prices_exit_${stalePrices.status}`);

    // (b) Earnings-window stale refresh (bounded) — every weekday when due.
    enrichEarnings = runApiTsx("src/scripts/enrich-earnings-window.ts", ["--max=40"]);
    actions.push(`enrich_earnings_exit_${enrichEarnings.status}`);

    // Full nightly only if ≥4 days since last success/partial.
    const age = daysSinceEnrichment();
    if (age >= ENRICH_DUE_DAYS) {
      enrich = runEnrichmentCatchup();
      actions.push(`enrichment_catchup_age_${age.toFixed(1)}d_exit_${enrich.status}`);
    } else {
      actions.push(`enrichment_ok_age_${age.toFixed(1)}d`);
    }
  }

  let drain = null;
  let drainMerged = false;
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

  if (enrichIfDue) {
    // (d) Peer roster heal (ETF quarantine, primary membership, null primary classify).
    peerHealth = runApiTsx("src/scripts/peer-health-check.ts");
    actions.push(`peer_health_exit_${peerHealth.status}`);

    // (e) Avoid double merge: enrichAndMergeTickers + drain + nightly already merge.
    //     - If any of those wrote → --scores-only
    //     - If nothing wrote → --scores-only anyway (peer primary may have changed; skip full merge)
    //     - Full merge only if we have no upstream merge but still need gold rebuild (shouldn't happen daily)
    const upstreamMerged =
      drainMerged ||
      ranEnrichMerge(enrichMissing) ||
      ranEnrichMerge(enrichUnscored) ||
      ranEnrichMerge(enrichEarnings) ||
      (enrich != null && enrich.status === 0);
    const scoreArgs = ["--scores-only"];
    postMerge = runApiTsx("src/scripts/post-merge-scores.ts", scoreArgs);
    actions.push(
      `post_merge_scores_exit_${postMerge.status}_scores_only` +
        (upstreamMerged ? "" : "_no_upstream_write"),
    );

    // Retention prune lives here too so it runs when API was down all day.
    // Covers api_usage / ai_usage_log / old intraday app_config + filesystem logs.
    const retention = runApiTsx("src/scripts/run-retention-prune.ts");
    actions.push(`retention_prune_exit_${retention.status}`);

    // Morning precompute so stock breakdown is warm by ~8 AM open.
    // Safe to re-run: each job dedupes same-UTC-day via scheduler stamps when
    // invoked from API; this script always runs once from Maintain.
    if (finalFlags.processOk) {
      const pre = runApiTsx("src/scripts/run-morning-precompute.ts");
      actions.push(`morning_precompute_exit_${pre.status}`);
    } else {
      actions.push("morning_precompute_skipped_process_down");
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

  const enrichFail =
    (enrichMissing && enrichMissing.status !== 0) ||
    (enrichUnscored && enrichUnscored.status !== 0) ||
    (enrichEarnings && enrichEarnings.status !== 0) ||
    (enrich && enrich.status !== 0) ||
    (peerHealth && peerHealth.status !== 0) ||
    (postMerge && postMerge.status !== 0);

  // UI / LaunchAgent "ok": local stack healthy after heal attempts. Vendor blips ≠ job failure.
  const jobOk = finalFlags.processOk && !enrichFail;
  const failureClass = !finalFlags.processOk
    ? "process"
    : enrichFail
      ? "enrich"
      : finalFlags.vendorFailed.length
        ? "vendor"
        : null;

  const report = {
    ts: new Date().toISOString(),
    ms: Date.now() - started,
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
    apiPid,
    vitePid,
    apiAgeDays: apiAgeDays != null ? Number(apiAgeDays.toFixed(2)) : null,
    logs,
    actions,
    enrich,
    enrichMissing,
    enrichUnscored,
    enrichEarnings,
    drain,
    peerHealth,
    postMerge,
    budget,
    restart,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  // Pipeline Health (enrichment_runs) — daily maintain is the scheduled enrich path on Mac.
  if (enrichIfDue) {
    const rec = runApiTsx("src/scripts/record-maintain-run.ts", [`--report=${REPORT}`]);
    actions.push(`record_maintain_run_exit_${rec.status}`);
    report.actions = actions;
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
  }

  console.log(`[maintain] ${report.ts}`);
  console.log(
    `  job: ${jobOk ? "OK" : "FAIL"}  process=${finalFlags.processOk ? "OK" : "FAIL"}  vendors=${finalFlags.vendorFailed.length === 0 ? "OK" : "WARN"}`,
  );
  console.log(`  health: ${report.healthOk ? "OK" : "DEGRADED"} (${report.healthPass ?? "?"} pass / ${report.healthFail ?? "?"} fail)`);
  if (report.processFailed?.length) console.log(`  process failed: ${report.processFailed.join(", ")}`);
  if (report.vendorFailed?.length) console.log(`  vendor warn: ${report.vendorFailed.join(", ")}`);
  console.log(`  api pid=${apiPid ?? "—"} age_days=${report.apiAgeDays ?? "—"}  vite pid=${vitePid ?? "—"}`);
  console.log(`  logs rotated=${logs.rotated.length} pruned_gz=${logs.pruned}`);
  if (budget.goldCoverage) {
    console.log(
      `  gold=${budget.goldCoverage} fieldFill=${budget.fieldFillPct ?? "—"}% scores=${budget.fundScoreCoverage} unscoredActive=${budget.unscoredActive ?? "—"} NR=${budget.needsReview} earnWin=${budget.earningsWindowTickers}`,
    );
  }
  if (budget.anomalies.length) console.log(`  anomalies: ${budget.anomalies.join(", ")}`);
  if (actions.length) console.log(`  actions: ${actions.join(", ")}`);
  console.log(`  report: ${REPORT}`);

  process.exit(jobOk ? 0 : 1);
}

main().catch((e) => {
  console.error("[maintain] fatal", e);
  process.exit(2);
});
