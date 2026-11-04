import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_DIR = "/tmp/fildi-logs";
const REPORT = join(LOG_DIR, "maintain-last.json");
const DAY_STATE = join(LOG_DIR, "maintain-day.json");
const LOCK = join(LOG_DIR, "maintain.lock");
const REPORT_FULL = join(LOG_DIR, "maintain-full-last.json");
const PLAN_REVIEW_STAMP = join(process.env.HOME || "/tmp", ".fildi/plan-review-last-run");

/** Resumable research fetches run after production: [name, script (from scripts/watchlist_sync), args, needs LSEG Workspace]. */
const RESEARCH_QUEUE = [
  ["s078_bars5m", "analysis/s078_orb_in_play.py", ["--fetch"], false],
  // s077_implied_tail retired 10-26: pre-registered read done on the cached sample (FAIL, display-only; A217) —
  // a daily LSEG fetch for a closed study only tripped the monthly datapoint guard.
];

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB → gzip + keep .1.gz
const ENRICH_DUE_DAYS = 4;
const DEFAULT_DRAIN_NR = 40;
/** A318 seg 1+2: FactSet NR drain only when remaining ≥ 80 (not drainNr+20). */
const FACTSET_DRAIN_MIN_REMAINING = 80;

/** Action markers that prove today’s full pass (UI verifyChecks). */
const FULL_PASS_ACTION_RE =
  /^(retention_prune_exit_|morning_precompute_exit_|enrichment_ok_age_|enrichment_catchup_|enrich_missing_|post_merge_scores_|ops_digest_exit_|ai_workflow_)/;

export {
  ROOT,
  LOG_DIR,
  REPORT,
  DAY_STATE,
  LOCK,
  REPORT_FULL,
  PLAN_REVIEW_STAMP,
  RESEARCH_QUEUE,
  MAX_LOG_BYTES,
  ENRICH_DUE_DAYS,
  DEFAULT_DRAIN_NR,
  FACTSET_DRAIN_MIN_REMAINING,
  FULL_PASS_ACTION_RE,
};
