/**
 * Recompute blended fair value for the active universe → fair_value_snapshots (DB + 2 FRED calls).
 * Normally runs automatically after every fund-score recompute; use this for a manual refresh.
 *
 *   pnpm exec tsx src/scripts/compute-fair-value.ts
 */
import { persistFairValueSnapshots } from "../lib/fair-value-snapshots.js";

persistFairValueSnapshots({ trigger: "manual" })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
