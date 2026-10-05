/**
 * Morning readiness: watchlist event bullets + capped earnings warm + FMP analyst
 * tape. Invoked from Mac Maintain after the stack is healthy, and also from the
 * API scheduler (~7:00 AM PT) as a backup when the Mac was already on overnight.
 *
 * Uses scheduler job wrappers so lastRun stamps land in app_config (Settings UI).
 */
import {
  runEventBulletsJob,
  runEarningsBackfillJob,
  runFmpAnalystFeedJob,
} from "../lib/scheduler.js";
import { logger } from "../lib/logger.js";

async function main() {
  const started = Date.now();
  logger.info("morning-precompute: start");
  await runEventBulletsJob();
  await runEarningsBackfillJob();
  await runFmpAnalystFeedJob();
  logger.info({ ms: Date.now() - started }, "morning-precompute: complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
