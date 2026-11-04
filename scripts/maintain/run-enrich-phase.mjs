import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DAY_STATE,
  ENRICH_DUE_DAYS,
  FACTSET_DRAIN_MIN_REMAINING,
  FULL_PASS_ACTION_RE,
  LOG_DIR,
  RESEARCH_QUEUE,
  REPORT,
  REPORT_FULL,
  ROOT,
  DEFAULT_DRAIN_NR,
} from "./constants.mjs";
import { budgetSnapshot } from "./budget.mjs";
import {
  daysSinceEnrichment,
  factsetRemaining,
  isHardEnrichFail,
  isTransientEnrichResult,
  resetDataSourceCountersIfNeeded,
  runApiTsx,
  runDrainNr,
  runEnrichmentCatchup,
  runModelListDaily,
} from "./enrich-runners.mjs";
import { classifyResearchResult } from "./dry-run.mjs";
import { healLocalStack, processFlags, restartStack, runHealth } from "./health-stack.mjs";
import { rotateLogs } from "./logs.mjs";
import {
  etDay,
  etHour,
  isPtMonday,
  isPtSunday,
  listenerPid,
  lsegDesktopUp,
  modelListDoneToday,
  notifyMac,
  procStartEpoch,
  readJson,
  readPriorReport,
  samePtDay,
  sh,
  takeLock,
} from "./utils.mjs";
import { scheduleSessionWake, unusedFeedsAction, unusedFeedsArgs } from "./schedule-helpers.mjs";

export async function runEnrichPhase(ctx) {
  const { args, restartIfUnhealthy, enrichIfDue, staleDays, drainNr } = ctx;
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
      // The 08:00 ET chain runs before the cash close, then marks the day done, so the
      // official session never gets a bar (10-29: 806 names stuck on the prior close).
      // After 16:00 ET, and again overnight before the next chain, fill that session only.
      if (etHour() >= 16 || etHour() < 8) {
        const fill = runApiTsx("src/scripts/backfill-stale-prices.ts", [], 20);
        console.log(`[maintain] closed-session prices exit ${fill.status ?? fill.signal ?? "spawn_error"}`);
      }
      if (etHour() < 8) { console.log(`[maintain] ${day}: before 08:00 ET — the day's chain starts at 05:00 PT`); return; }
      if (st.day === day && st.done) { console.log(`[maintain] ${day}: chain already complete — skip`); return; }
      if (st.day === day && (st.attempts || 0) >= 3) { console.log(`[maintain] ${day}: 3 attempts used — skip until tomorrow`); return; }
      if (!takeLock()) { console.log("[maintain] another run holds the lock — skip"); return; }
      dataDoneToday = st.day === day && !!st.dataDone;
      writeFileSync(DAY_STATE, JSON.stringify({ day, attempts: (st.day === day ? st.attempts || 0 : 0) + 1, done: false, dataDone: dataDoneToday }));
      scheduleSessionWake();
    }
  
    const started = Date.now();
    let health = runHealth();
    const logs = await rotateLogs();
  
    const apiPidBefore = listenerPid(8080);
    const vitePidBefore = listenerPid(8081);
    const apiStart = procStartEpoch(apiPidBefore);
    const apiAgeDays = apiStart != null ? (Date.now() - apiStart) / 86400_000 : null;
  
    const actions = [];
    /** Research child timeout/SIGTERM/nonzero — soft only (never jobOk fail). */
    const researchSoftWarns = [];
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
  
      // A267: after prices/breadth/earnings/scores. Pool daily; --scope=universe on PT Monday.
      // Polygon calls take polygon.gate inside the script. Not a list input — a miss does not fail dataDone.
      const feeds = runApiTsx("src/scripts/refresh-unused-feeds.ts", unusedFeedsArgs());
      timings.unusedFeeds = feeds.ms;
      actions.push(unusedFeedsAction(feeds));
      if (feeds.status !== 0) console.error(`[maintain] unused-feeds pool failed: ${feeds.error ?? ""} ${feeds.stderrTail}`);
    }
  
    if (enrichIfDue && !dataDoneToday) {
      runListCriticalData();
      if (!lateOpenListFirst) runHeavyDataBeforeList();
    }
  
    let drain = null;
    let drainMerged = false;
    if (drainNr > 0 && !dataDoneToday && !lateOpenListFirst) {
      const rem = factsetRemaining();
      if (rem >= FACTSET_DRAIN_MIN_REMAINING) {
        drain = runDrainNr(Math.min(drainNr, DEFAULT_DRAIN_NR));
        actions.push(`drain_nr_${drainNr}_rem_${rem}_exit_${drain.status}`);
        drainMerged = drain.status === 0;
      } else {
        actions.push(`drain_nr_skipped_rem_${rem}_need_${FACTSET_DRAIN_MIN_REMAINING}`);
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
      const dayState = readJson(DAY_STATE) || {};
      modelList = dayState.day === etDay() && dayState.modelListBlocked
        ? { status: 2, stdoutTail: `skip: needs action (${dayState.modelListBlocked}) — retrying cannot fix it`, ms: 0 }
        : etHour() >= 10 ? runModelListDaily()
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
          if (rem >= FACTSET_DRAIN_MIN_REMAINING) {
            drain = runDrainNr(Math.min(drainNr, DEFAULT_DRAIN_NR));
            actions.push(`drain_nr_${drainNr}_rem_${rem}_exit_${drain.status}`);
            drainMerged = drain.status === 0;
          } else {
            actions.push(`drain_nr_skipped_rem_${rem}_need_${FACTSET_DRAIN_MIN_REMAINING}`);
          }
        }
        runScoresAndPrecompute(drainMerged);
      }
  
      // (g) Data freshness (A243): the 9 health checks are liveness/vendor reachability only — none reads a table, so
      //     10-20 and 10-22 published the list on stale option_score_snapshots with health 9/9 pass. Runs after the list
      //     (and after the late-open catch-up) so the tables it checks have had their write. Non-zero exit = a stale
      //     table or too much of the put pool blocked for missing inputs → health fail + banner.
      if (args.has("--once-per-day")) {
        const dir = join(ROOT, "scripts/watchlist_sync");
        const t0 = Date.now();
        const fresh = spawnSync(join(dir, ".venv/bin/python"), ["data_freshness.py"], { encoding: "utf8", cwd: dir, timeout: 10 * 60 * 1000 });
        timings.dataFreshness = Date.now() - t0;
        const freshStatus = fresh.status ?? fresh.signal ?? "spawn_error";
        actions.push(`data_freshness_exit_${freshStatus}`);
        if (freshStatus !== 0) {
          const out = (fresh.stdout || fresh.stderr || "").trim();
          health.results = [...(health.results || []), { name: "data_freshness", ok: false, detail: out.slice(-600) }];
          health.fail = (health.fail ?? 0) + 1;
          health.ok = false;
          const findings = out.split("\n").filter((l) => l.startsWith("✗"));
          notifyMac("Fildi data stale", (findings.join(" · ") || `data_freshness exit ${freshStatus}`).slice(0, 180));
        }
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
        if (isPtMonday()) {   // A267 weekly universe pass (Form 4, 8-K, related, short interest) under polygon.gate
          const u = runApiTsx("src/scripts/refresh-unused-feeds.ts", ["--scan=0", "--scope=universe"], 240);   // ~3 h at 5/min; resumes per name
          timings.unusedFeedsUniverse = u.ms;
          actions.push(`unused_feeds_universe_exit_${u.status ?? u.signal ?? "spawn_error"}`);
          if (u.status !== 0) console.error(`[maintain] unused-feeds universe failed: ${u.error ?? ""} ${u.stderrTail}`);
        }
        for (const [name, rel, extra, needsLseg] of RESEARCH_QUEUE) {
          if (needsLseg && !lsegDesktopUp()) { actions.push(`research_${name}_skipped_no_lseg`); continue; }
          const t0 = Date.now();
          const dir = join(ROOT, "scripts/watchlist_sync");
          const py = needsLseg ? join(ROOT, "research/lseg/.venv/bin/python") : join(dir, ".venv/bin/python");
          // Cap 25m — was 45m; SIGTERM after long hang looked like "job OK" with no desk value.
          const r = spawnSync(py, [rel, ...extra], { encoding: "utf8", cwd: dir, timeout: 25 * 60 * 1000 });
          timings[`research_${name}`] = Date.now() - t0;
          const cls = classifyResearchResult(r);
          if (cls.soft) {
            // Soft: never LaunchAgent FAILED — research is optional after production.
            actions.push(`research_${name}_soft_${cls.tag}`);
            researchSoftWarns.push(name);
            console.warn(`[maintain] research ${name} soft-fail (${cls.tag}) — not hard-fail`);
          } else {
            actions.push(`research_${name}_exit_0`);
          }
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
        const digDay = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        if (!existsSync(join(LOG_DIR, "data-ops-value", `${digDay}.json`))) {
          actions.push("ops_digest_missing_artifact");
          console.warn("[maintain] ops digest exit ok but no PT-day artifact — check weekly-data-ops-check.mjs");
        }
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
  Object.assign(ctx, {
    dataDoneToday,
    started,
    health,
    logs,
    apiPidBefore,
    vitePidBefore,
    apiStart,
    apiAgeDays,
    actions,
    researchSoftWarns,
    restart,
    finalFlags,
    resetNames,
    enrich,
    enrichMissing,
    enrichUnscored,
    enrichEarnings,
    modelList,
    timings,
    peerHealth,
    postMerge,
    drain,
    drainMerged,
    fieldFillPctBefore,
    lateOpenListFirst,
    healJson,
    apiPid,
    vitePid,
  });
}
