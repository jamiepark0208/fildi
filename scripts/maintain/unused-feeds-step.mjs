import { mkdirSync, writeFileSync } from "node:fs";
import { LOG_DIR, REPORT } from "./constants.mjs";
import { runApiTsx } from "./enrich-runners.mjs";
import { readPriorReport, takeLock } from "./utils.mjs";
import { unusedFeedsAction, unusedFeedsArgs } from "./schedule-helpers.mjs";

function runUnusedFeedsStepOnly() {
  mkdirSync(LOG_DIR, { recursive: true });
  if (!takeLock()) {
    console.log("[maintain] another run holds the lock — skip unused-feeds step");
    process.exit(1);
  }
  const r = runApiTsx("src/scripts/refresh-unused-feeds.ts", unusedFeedsArgs());
  const prior = readPriorReport(REPORT) || {};
  const timings = {
    ...(prior.timings && typeof prior.timings === "object" ? prior.timings : {}),
    unusedFeeds: r.ms,
  };
  const action = unusedFeedsAction(r);
  const actions = Array.isArray(prior.actions) ? [...prior.actions] : [];
  if (!actions.includes(action)) actions.push(action);
  writeFileSync(REPORT, JSON.stringify({ ...prior, timings, actions }, null, 2));
  console.log(`[maintain] unused-feeds ${action} ms=${r.ms}`);
  if (r.stdoutTail) console.log(r.stdoutTail);
  if (r.status !== 0 && r.stderrTail) console.error(r.stderrTail);
  process.exit(r.status === 0 ? 0 : 1);
}

export { runUnusedFeedsStepOnly };
