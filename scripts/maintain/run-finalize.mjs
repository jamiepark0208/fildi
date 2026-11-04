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

export async function finalizeRun(ctx) {
  let { args, restartIfUnhealthy, enrichIfDue, staleDays, drainNr } = ctx;
  let dataDoneToday = ctx.dataDoneToday;
  let started = ctx.started;
  let health = ctx.health;
  let logs = ctx.logs;
  let apiPidBefore = ctx.apiPidBefore;
  let vitePidBefore = ctx.vitePidBefore;
  let apiStart = ctx.apiStart;
  let apiAgeDays = ctx.apiAgeDays;
  let actions = ctx.actions;
  let researchSoftWarns = ctx.researchSoftWarns;
  let restart = ctx.restart;
  let finalFlags = ctx.finalFlags;
  let resetNames = ctx.resetNames;
  let enrich = ctx.enrich;
  let enrichMissing = ctx.enrichMissing;
  let enrichUnscored = ctx.enrichUnscored;
  let enrichEarnings = ctx.enrichEarnings;
  let modelList = ctx.modelList;
  let timings = ctx.timings;
  let peerHealth = ctx.peerHealth;
  let postMerge = ctx.postMerge;
  let drain = ctx.drain;
  let drainMerged = ctx.drainMerged;
  let fieldFillPctBefore = ctx.fieldFillPctBefore;
  let lateOpenListFirst = ctx.lateOpenListFirst;
  let healJson = ctx.healJson;
  let apiPid = ctx.apiPid;
  let vitePid = ctx.vitePid;
  
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
  
    // Persist full health rows so Settings › API can show Yahoo/DNS without re-probing.
    const healthResults = Array.isArray(health.results) ? health.results : [];
    const yahooRow = healthResults.find((r) => r?.name === "yahoo_chart");
    const dnsPublic = healthResults.find((r) => r?.name === "dns_public");
    const dnsSystem = healthResults.find((r) => r?.name === "dns_system");
    const slowVendors = healthResults.filter((r) => r?.ok && r?.slow).map((r) => r.name);
    const softFailed = [
      ...(Array.isArray(health.softFailed)
        ? health.softFailed
        : healthResults.filter((r) => !r.ok && r.soft).map((r) => r.name)),
    ];
    if (yahooRow && yahooRow.ok === false && !finalFlags.vendorFailed.includes("yahoo_chart")) {
      finalFlags.vendorFailed = [...finalFlags.vendorFailed, "yahoo_chart"];
    }
    if (dnsPublic && dnsPublic.ok === false && !finalFlags.vendorFailed.includes("dns_public")) {
      finalFlags.vendorFailed = [...finalFlags.vendorFailed, "dns_public"];
    }
    if (yahooRow?.ok === false) mergedActions.push("vendor_warn:yahoo_chart");
    if (dnsSystem && !dnsSystem.ok) mergedActions.push("dns_wedge_detected");
    if (slowVendors.length) mergedActions.push(`vendor_slow:${slowVendors.join("|")}`);
    for (const n of researchSoftWarns) {
      if (!softFailed.includes(`research_${n}`)) softFailed.push(`research_${n}`);
    }
    // Desk poisoned caches (soft) — surface in softFailed already via health; stamp action for ledger.
    for (const n of ["macro_data_cache", "macro_charts_cache"]) {
      const row = healthResults.find((r) => r?.name === n);
      if (row && row.ok === false) mergedActions.push(`desk_smoke_warn:${n}`);
    }
  
    // Self-heal beyond "report it": if Yahoo is down AND system DNS is wedged, bounce API
    // so dns-bypass.ts is loaded. Rate-limit: at most once per 30 min (prior report).
    let vendorRestart = null;
    // 11-03: public DNS failing too = no network (lid closing, Wi-Fi off), not a wedged resolver — a restart cannot fix it
    // (11-02 14:45 PT: all 9 vendors + both DNS paths failed and the stack was bounced anyway).
    const networkDown = dnsPublic?.ok === false && dnsSystem && !dnsSystem.ok;
    if (networkDown) mergedActions.push("network_down_no_restart");
    if (
      restartIfUnhealthy &&
      !networkDown &&
      yahooRow?.ok === false &&
      dnsSystem && !dnsSystem.ok &&
      finalFlags.processOk
    ) {
      const prior = readPriorReport(REPORT);
      const priorTs = typeof prior?.ts === "string" ? Date.parse(prior.ts) : 0;
      const priorHad = Array.isArray(prior?.actions) && prior.actions.includes("vendor_path_restart");
      const coolMs = 30 * 60_000;
      if (!priorHad || !priorTs || Date.now() - priorTs > coolMs) {
        try {
          const r = healLocalStack(
            { ...health, processOk: false, processFailed: ["api_healthz"], results: health.results },
            mergedActions,
          );
          vendorRestart = r.restart;
          mergedActions.push("vendor_path_restart");
          health = r.health;
          Object.assign(finalFlags, processFlags(health));
        } catch (e) {
          console.warn("[maintain] vendor_path_restart failed", String(e?.message || e).slice(0, 120));
        }
      } else {
        mergedActions.push("vendor_path_restart_skipped_cooldown");
      }
    }
  
    const report = {
      ts: new Date().toISOString(),
      mode,
      ms: Date.now() - started,
      timings,
      healthOk: !!health.ok,
      processOk: finalFlags.processOk,
      vendorsOk: finalFlags.vendorFailed.length === 0 && slowVendors.length === 0 && softFailed.length === 0,
      ok: jobOk,
      failureClass,
      healthPass: health.pass ?? null,
      healthFail: health.fail ?? null,
      healthResults,
      slowVendors,
      softFailed,
      failedChecks: healthResults.filter((r) => !r.ok).map((r) => r.name),
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
      restart: restart || vendorRestart,
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    // Settings › API Monitor + rolling history (catch intermittent Yahoo/DNS wedges).
    try {
      const yh = yahooRow || null;
      const overall =
        !yh || yh.ok === false || (dnsPublic && !dnsPublic.ok)
          ? "down"
          : yh.slow || slowVendors.length || softFailed.length
            ? "warn"
            : "ok";
      const snap = {
        checkedAt: report.ts,
        source: "maintain",
        dnsBypass: { active: true, servers: ["1.1.1.1", "8.8.8.8", "9.9.9.9"] },
        yahooCircuit: { open: false, openUntil: null, failStreak: 0 },
        livePriceTtlSec: 120,
        probes: healthResults.filter((r) =>
          ["yahoo_chart", "dns_public", "dns_system"].includes(r?.name),
        ),
        maintain: {
          ts: report.ts,
          vendorsOk: report.vendorsOk,
          yahooChart: yh ? { ok: !!yh.ok, ms: yh.ms ?? null, detail: yh.detail } : null,
          dnsSystem: dnsSystem
            ? { ok: !!dnsSystem.ok, ms: dnsSystem.ms ?? null, detail: dnsSystem.detail }
            : null,
          vendorFailed: report.vendorFailed,
          softFailed,
        },
        overall,
      };
      writeFileSync(join(LOG_DIR, "vendor-health-last.json"), JSON.stringify(snap, null, 2));
      const histPath = join(LOG_DIR, "vendor-health-history.jsonl");
      appendFileSync(
        histPath,
        JSON.stringify({
          ts: report.ts,
          overall,
          yahooOk: yh ? !!yh.ok : null,
          yahooMs: yh?.ms ?? null,
          dnsSystemOk: dnsSystem ? !!dnsSystem.ok : null,
          dnsPublicOk: dnsPublic ? !!dnsPublic.ok : null,
          vendorFailed: report.vendorFailed,
          softFailed,
        }) + "\n",
      );
      // Cap history so Settings stay snappy (keep last ~200 runs).
      try {
        const lines = readFileSync(histPath, "utf8").trim().split("\n").filter(Boolean);
        if (lines.length > 220) writeFileSync(histPath, lines.slice(-200).join("\n") + "\n");
      } catch { /* ignore */ }
    } catch {
      /* ignore */
    }
    if (args.has("--once-per-day") && enrichIfDue) {
      // Data steps the Model List reads; a failed one (killed in a dark wake, exit 1/2) is retried next fire, not "done".
      const dataFailed = actions.filter((a) =>
        /^(backfill_stale_prices|backfill_market_breadth|enrich_earnings|post_merge_scores|morning_precompute)_exit_(?!0(_|$))/.test(a));
      const st = readJson(DAY_STATE) || {};
      const dataDone = dataDoneToday || dataFailed.length === 0;
      // 11-03: daily.py exit codes carry the failure cause. 75 = network / vendor outage or another run in progress → refund,
      // retry next fire. 2 = auth (Jamie) or code error (agent) → no more attempts today, raise it. 1 / killed = resume next fire.
      const waitingForOpen = (modelList?.status === 0 && !modelListDoneToday(modelList)) || modelList?.status === 75;
      const needsAction = modelList?.status === 2
        ? (/cause: (\w+)/.exec(modelList.stdoutTail || "")?.[1] ?? st.modelListBlocked ?? "unknown") : null;
      if (needsAction) actions.push(`model_list_needs_action:${needsAction}`);
      writeFileSync(DAY_STATE, JSON.stringify({
        ...st,
        day: etDay(),
        dataDone,
        dataFailed,
        done: dataDone && modelListDoneToday(modelList),
        // waiting ≠ failing — refund even when a data step failed (10-22: stale-prices exit 2 burned all 3 pre-open → no list; A243)
        attempts: waitingForOpen ? Math.max(0, (st.attempts || 1) - 1) : st.attempts,
        modelListBlocked: needsAction ?? undefined,
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
    if (report.softFailed?.length) console.log(`  soft warn: ${report.softFailed.join(", ")}`);
    if (report.slowVendors?.length) console.log(`  slow: ${report.slowVendors.join(", ")}`);
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
  
    try {
      const { appendAutoLedger } = await import("../auto-ledger.mjs");
      const healed = mergedActions.some((a) => /process_healed|vendor_path_restart|healed:/.test(a));
      const value = !jobOk
        ? "FAILED"
        : healed
          ? "IMPROVED"
          : softFailed.length || researchSoftWarns.length || slowVendors.length
            ? "NO MATERIAL CHANGE"
            : "NO MATERIAL CHANGE";
      appendAutoLedger({
        id: "maintain",
        rail: "A",
        goal: "Local stack up; desk path probes; soft vendor/DNS; research soft-fail",
        ok: jobOk,
        value,
        ms: report.ms,
        actions: mergedActions,
        softFailed,
        evidence: {
          processOk: report.processOk,
          vendorsOk: report.vendorsOk,
          softFailed,
          slowVendors,
          researchSoftWarns,
          failedChecks: report.failedChecks,
          healthPass: report.healthPass,
          healthFail: report.healthFail,
        },
        note: softFailed.length
          ? `soft: ${softFailed.join(",")}`
          : healed
            ? "healed"
            : null,
      });
    } catch (e) {
      console.warn("[maintain] auto-ledger skip", String(e?.message || e).slice(0, 100));
    }
  

    if (!jobOk) {
      const why =
        failureClass === "process"
          ? `Stack down: ${(finalFlags.processFailed || []).join(", ") || "api/vite/postgres"}`
          : failureClass === "enrich"
            ? "Enrich/peer/scores step failed — see maintain-last.json"
            : "Maintain failed — open Settings → Scheduled Tasks";
      notifyMac("Fildi Maintain FAILED", why);
    } else if (
      yahooRow?.ok === false ||
      (dnsSystem && !dnsSystem.ok) ||
      softFailed.includes("macro_data_cache") ||
      softFailed.includes("macro_charts_cache")
    ) {
      // Soft path death — not LaunchAgent FAILED, but Jamie should see a warn (DNS/Yahoo loop class).
      notifyMac(
        "Fildi Maintain WARN",
        [
          yahooRow?.ok === false ? "Yahoo down" : null,
          dnsSystem && !dnsSystem.ok ? "system DNS wedged" : null,
          softFailed.includes("macro_data_cache") ? "macro-data cache empty" : null,
          softFailed.includes("macro_charts_cache") ? "macro-charts cache empty" : null,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 180) || "vendor/desk soft fail — Settings › API",
      );
    }
  
    process.exit(jobOk ? 0 : 1);
}
