#!/usr/bin/env node
/**
 * Lean TradeDash maintenance — run periodically (LaunchAgent / cron), NOT forever.
 * Failure modes + hardeners: scripts/maintain-FAILURE-MODES.md
 * Proof ledger: /tmp/fildi-logs/auto-ledger.jsonl (scripts/auto-ledger.mjs)
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
 *       (j) refresh-unused-feeds.ts after those data steps (pool daily; --scope=universe on PT Monday).
 *           --scan=0. Polygon calls stay on polygon.gate inside the script. scheduler.ts is not involved.
 *     Full nightly-enrichment ONLY if last enrichment_runs success ≥ 4 days
 *   node scripts/maintain.mjs --dry-run
 *     Local smoke only: print morning chain + health --desk-only + ledger write +
 *     research soft-fail classifier. No enrich, no Yahoo/FMP/Polygon, no LLM tokens.
 *   node scripts/maintain.mjs --step=unused-feeds
 *     Run only that feed step and stamp timings.unusedFeeds on maintain-last.json.
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
import { parseMaintainArgs } from "./maintain/args.mjs";
import { runDryRunSmoke } from "./maintain/dry-run.mjs";
import { runUnusedFeedsStepOnly } from "./maintain/unused-feeds-step.mjs";
import { runMaintainMain } from "./maintain/run.mjs";
import { notifyMac } from "./maintain/utils.mjs";

const flags = parseMaintainArgs(process.argv.slice(2));

async function dispatch() {
  if (flags.args.has("--dry-run")) {
    await runDryRunSmoke();
    return;
  }
  if (flags.args.has("--step=unused-feeds")) {
    runUnusedFeedsStepOnly();
    return;
  }
  await runMaintainMain(flags);
}

dispatch().catch((e) => {
  console.error("[maintain] fatal", e);
  notifyMac("Fildi Maintain FATAL", String(e?.message || e).slice(0, 180));
  process.exit(2);
});
