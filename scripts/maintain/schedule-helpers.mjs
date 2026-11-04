import { spawnSync } from "node:child_process";
import { etHour } from "./utils.mjs";

/** Pool every morning; universe once a week (PT Monday). --scan=0 skips the 3-name chain sample. */
function unusedFeedsArgs() {
  // Pool only before the list (~6 s). The Monday universe pass is ~1k Polygon calls at 5/min (~3 h) → research queue,
  // after the list is final (Claude 10-24: before daily.py it would have held Monday's Model List for hours).
  return ["--scan=0"];
}

function unusedFeedsAction(r) {
  const scope = "pool";
  return `unused_feeds_exit_${r.status ?? r.signal ?? "spawn_error"}_scope_${scope}`;
}

/** Best-effort: if the 05:00 PT prep runs before the open, ask macOS to wake at 09:55 ET so Model List + Fri
 *  accountability can capture live bids (10-24: Fri noon dual-write missed when the lid stayed closed). */
function scheduleSessionWake() {
  if (etHour() >= 10) return;
  try {
    const stamp = spawnSync("/usr/bin/python3", ["-c", `
from datetime import datetime
from zoneinfo import ZoneInfo
et = ZoneInfo("America/New_York")
now = datetime.now(et)
w = now.replace(hour=9, minute=55, second=0, microsecond=0)
if w <= now: raise SystemExit(0)
print(w.astimezone().strftime("%m/%d/%y %H:%M:%S"))
`], { encoding: "utf8" });
    const when = (stamp.stdout || "").trim();
    if (!when) return;
    const r = spawnSync("/usr/bin/pmset", ["schedule", "wakeorpoweron", when], { encoding: "utf8" });
    console.log(`[maintain] scheduled wake ${when} for Model List window${r.status === 0 ? "" : ` (pmset exit ${r.status}: ${(r.stderr || "").trim()})`}`);
  } catch (e) {
    console.log(`[maintain] wake schedule skipped: ${e?.message || e}`);
  }
}

function printMorningChain() {
  const feed = `refresh-unused-feeds.ts ${unusedFeedsArgs().join(" ")} (after data steps, polygon.gate)`;
  const steps = [
    "backfill-stale-prices.ts (+ ≤ 60 never-priced universe adds/day: history + technicals)",
    "enrich-earnings-window.ts --max=40",
    "enrich-missing-fundamentals.ts --max=30",
    "enrich-unscored-fundamentals.ts --max=20",
    "backfill-market-breadth.ts --days=5",
    "nightly-enrichment.ts (if last success ≥ 4d)",
    "drain-needs-review.ts",
    "peer-health-check.ts",
    "post-merge-scores.ts --scores-only",
    "run-morning-precompute.ts",
    feed,
    "daily.py --if-needed",
    "data_freshness.py",
    "run-retention-prune.ts",
    "option_history.py",
    "research queue (only after the list is final)",
  ];
  console.log("[maintain] dry-run --enrich-if-due morning chain (not executed)");
  for (const s of steps) console.log(`  - ${s}`);
}

export { scheduleSessionWake, printMorningChain, unusedFeedsArgs, unusedFeedsAction };
